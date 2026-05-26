package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pkg "github.com/chaya-ai/chaya-engine/pkg"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

const maxToolIterations = 10

// SubActor is a specialized agent that executes delegated tasks.
// It has no privilege to create other actors.
// It processes tasks from PrimaryAgent or direct user messages identically.
type SubActor struct {
	*Actor
	resultRouter ResultRouter
}

// ResultRouter sends results back to whoever delegated the task.
type ResultRouter interface {
	DeliverResult(taskID, result string)
}

// NewSubActor creates a SubActor with specific permissions.
func NewSubActor(base *Actor, router ResultRouter) *SubActor {
	if base.Config.Permissions == nil {
		base.Config.Permissions = ReadOnlyRuleset
	}
	return &SubActor{Actor: base, resultRouter: router}
}

// Run starts the SubActor event loop.
func (s *SubActor) Run(ctx context.Context) {
	defer close(s.done)
	slog.Info("sub actor started", "id", s.ID, "agent", s.AgentID)

	for {
		select {
		case env := <-s.Mailbox:
			s.Touch()
			s.handle(ctx, env)
		case <-ctx.Done():
			slog.Info("sub actor stopped", "id", s.ID)
			return
		}
	}
}

func (s *SubActor) handle(ctx context.Context, env *envelope.Envelope) {
	switch env.Type {
	case envelope.TypeTask:
		s.handleTask(ctx, env)
	case envelope.TypeChat:
		// Direct user message — same as task but no result routing
		s.streamChat(ctx, env)
	case envelope.TypeInterrupt:
		slog.Info("sub actor interrupted", "id", s.ID)
	}
}

// handleTask processes a delegated task and returns the result to the requester.
func (s *SubActor) handleTask(ctx context.Context, env *envelope.Envelope) {
	slog.Info("sub actor processing task", "id", s.ID, "from", env.From, "task", env.Body[:min(len(env.Body), 80)])
	taskKind := extractDelegationTaskKind(env.Data)
	tempMCPAuth := hasDelegationTempMCPAuth(env.Data)
	if !tempMCPAuth && taskKind != "capability_setup" {
		s.publishPipelineStepWithType(env.ConvID, "", "未获得工具授权，仅推理模式", "warning")
	}

	// Extract delegated MCP server IDs so the sub-agent can load tools
	// from the same servers the PrimaryAgent identified as candidates.
	var delegatedServerIDs map[string]struct{}
	if tempMCPAuth {
		delegatedServerIDs = extractDelegationMCPServerIDs(env.Data)
	}

	sys := combinedSystemPromptFromConfig(s.Config)
	if taskKind == "capability_setup" {
		sys = sys + capabilitySystemExtra
	}
	// Build messages with the task as user input
	messages := []provider.Message{
		{Role: "system", Content: sys},
		{Role: "user", Content: env.Body},
	}
	messages, mcpTools := s.enrichMessagesWithCapabilities(ctx, env.ConvID, env.Body, messages, delegatedServerIDs, true)
	if taskKind == "capability_setup" {
		mcpTools = append(capabilitySetupTools(s, env.ConvID), mcpTools...)
		s.publishPipelineStep(env.ConvID, "能力配置模式：可使用 chaya_* 内置工具读写绑定")
	} else if !tempMCPAuth {
		mcpTools = nil
	}
	// Inject web_fetch builtin tool when external links are detected,
	// so the LLM has a fallback for URLs not covered by MCP tools.
	if containsExternalLink(env.Body) {
		mcpTools = append(mcpTools, webFetchTool())
	}

	if len(mcpTools) == 0 {
		s.publishPipelineStep(env.ConvID, "无可用工具，进入纯推理模式")
	}

	// Convert pkg.Tool → provider.Tool and build lookup index
	providerTools, toolIndex := convertTools(mcpTools)

	// Call LLM with tool calling loop
	resp := s.callLLMWithTools(ctx, env.ConvID, messages, providerTools, toolIndex)

	// Deliver result back
	if s.resultRouter != nil {
		s.resultRouter.DeliverResult(env.ID, resp)
	}

	slog.Info("sub actor task completed", "id", s.ID, "result_len", len(resp))
}

// convertTools converts pkg.Tool slice to provider.Tool slice and builds a name→pkg.Tool index.
func convertTools(tools []pkg.Tool) ([]provider.Tool, map[string]pkg.Tool) {
	if len(tools) == 0 {
		return nil, nil
	}
	providerTools := make([]provider.Tool, 0, len(tools))
	toolIndex := make(map[string]pkg.Tool, len(tools))
	for _, t := range tools {
		providerTools = append(providerTools, provider.Tool{
			Type: "function",
			Function: provider.ToolFunction{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  t.Parameters,
			},
		})
		toolIndex[t.Name] = t
	}
	return providerTools, toolIndex
}

// callLLMWithTools performs a non-streaming LLM call with tool calling loop.
// If no tools are available, falls back to a plain LLM call.
func (s *SubActor) callLLMWithTools(ctx context.Context, convID string, messages []provider.Message, tools []provider.Tool, toolIndex map[string]pkg.Tool) string {
	if len(tools) == 0 {
		resp, err := s.callLLM(ctx, messages)
		if err != nil {
			slog.Error("sub actor LLM error", "id", s.ID, "err", err)
			return "(Error: " + err.Error() + ")"
		}
		return resp
	}

	doom := intelligence.NewDoomLoopDetector()

	for iter := 0; iter < maxToolIterations; iter++ {
		s.publishPipelineStep(convID, fmt.Sprintf("第 %d 轮推理...", iter+1))

		s.reloadRuntimeConfigFromDB()
		llm, model := s.resolveLLM()

		// On the LAST allowed iteration, force the model to give a final
		// answer instead of asking for more tools — saves the otherwise
		// wasted "you've used all iterations, please answer now" extra
		// LLM round-trip at the bottom of the function. We also drop the
		// tools list so the request payload shrinks.
		iterTools := tools
		iterChoice := "auto"
		if iter == maxToolIterations-1 {
			iterTools = nil
			iterChoice = "none"
		}

		resp, err := llm.Chat(ctx, provider.ChatRequest{
			Messages:   messages,
			Model:      model,
			Tools:      iterTools,
			ToolChoice: iterChoice,
		})
		if err != nil {
			slog.Error("sub actor tool call LLM error", "id", s.ID, "iteration", iter, "err", err)
			return "(Error: " + err.Error() + ")"
		}

		// No tool calls → final text response
		if len(resp.ToolCalls) == 0 {
			s.publishPipelineStep(convID, "生成最终回答")
			return resp.Content
		}

		// Append assistant message with tool calls. We MUST keep Reasoning
		// here — DeepSeek-Reasoner / Qwen-thinking enforce that the previous
		// turn's reasoning_content is round-tripped, otherwise the next call
		// fails with HTTP 400 "reasoning_content must be passed back".
		messages = append(messages, provider.Message{
			Role:      "assistant",
			Content:   resp.Content,
			Reasoning: resp.Reasoning,
			ToolCalls: resp.ToolCalls,
		})

		// Execute tool calls in parallel within a single iteration. The model
		// is allowed to ask for N independent tools in one turn (e.g.
		// "fetch these 3 URLs + search KB"); previously we ran them serially
		// so total latency was sum(individual). Now it's max(individual).
		//
		// Doom-check + doom-record stays sequential (it inspects history),
		// so the gating decision for each call is deterministic and not
		// racy. Only the actual executeTool work runs concurrently.
		// Results are collected by index so the tool_result messages are
		// appended in the same order the model emitted them — most LLMs
		// don't care about ordering but a few are sensitive to it.
		type toolOutcome struct {
			content   string
			duration  time.Duration
			tc        provider.ToolCall
			skipped   bool // doom-loop short-circuit
		}
		outcomes := make([]toolOutcome, len(resp.ToolCalls))
		var wg sync.WaitGroup
		for i, tc := range resp.ToolCalls {
			argsSummary := tc.Arguments
			if len(argsSummary) > 120 {
				argsSummary = argsSummary[:120] + "..."
			}
			s.publishPipelineStepWithType(convID, "", fmt.Sprintf("调用工具 %s（%s）", tc.Name, argsSummary), "tool_start")

			if doom.Check(tc.Name, tc.Arguments) {
				slog.Warn("doom loop detected", "tool", tc.Name, "iteration", iter)
				s.publishPipelineStepWithType(convID, "", fmt.Sprintf("检测到工具重复调用 %s，已终止", tc.Name), "error")
				outcomes[i] = toolOutcome{
					tc:      tc,
					content: "Error: tool call loop detected — same call repeated too many times. Please provide a final answer.",
					skipped: true,
				}
				continue
			}
			doom.Record(tc.Name, tc.Arguments)

			wg.Add(1)
			go func(i int, tc provider.ToolCall) {
				defer wg.Done()
				start := time.Now()
				result := s.executeTool(ctx, tc, toolIndex)
				outcomes[i] = toolOutcome{tc: tc, content: result, duration: time.Since(start)}
			}(i, tc)
		}
		wg.Wait()

		for _, o := range outcomes {
			if !o.skipped {
				s.publishPipelineStepWithType(convID, "", fmt.Sprintf("工具完成 %s（%dms，%d 字符）", o.tc.Name, o.duration.Milliseconds(), len(o.content)), "tool_done")
			}
			messages = append(messages, provider.Message{
				Role:       "tool",
				Content:    o.content,
				ToolCallID: o.tc.ID,
			})
		}
	}

	// Max iterations reached — force a final answer without tools
	s.publishPipelineStep(convID, "已达工具调用上限，正在生成最终回答...")
	messages = append(messages, provider.Message{
		Role:    "user",
		Content: "You have used all available tool call iterations. Please provide your best final answer now based on the tool results you have.",
	})
	resp, err := s.callLLM(ctx, messages)
	if err != nil {
		return "(Error after max iterations: " + err.Error() + ")"
	}
	return resp
}

// availableToolNames returns a comma-separated list of available tool names for error messages.
func availableToolNames(index map[string]pkg.Tool) string {
	names := make([]string, 0, len(index))
	for name := range index {
		names = append(names, name)
	}
	if len(names) > 15 {
		return strings.Join(names[:15], ", ") + fmt.Sprintf(" ... (%d more)", len(names)-15)
	}
	return strings.Join(names, ", ")
}

func extractDelegationTaskKind(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var payload struct {
		Delegation *struct {
			TaskKind string `json:"task_kind"`
		} `json:"delegation"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Delegation == nil {
		return ""
	}
	return strings.TrimSpace(payload.Delegation.TaskKind)
}

func hasDelegationTempMCPAuth(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return false
	}
	var payload struct {
		Delegation *struct {
			TempMCPAuth *bool `json:"temp_mcp_auth"`
		} `json:"delegation"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Delegation == nil || payload.Delegation.TempMCPAuth == nil {
		return false
	}
	return *payload.Delegation.TempMCPAuth
}

// extractDelegationMCPServerIDs parses delegation.related_resources.mcp_candidates[].server_id
// and returns a set of MCP server IDs for tool loading.
func extractDelegationMCPServerIDs(raw json.RawMessage) map[string]struct{} {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var payload struct {
		Delegation *struct {
			RelatedResources map[string]json.RawMessage `json:"related_resources"`
		} `json:"delegation"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Delegation == nil {
		return nil
	}
	candidatesRaw, ok := payload.Delegation.RelatedResources["mcp_candidates"]
	if !ok {
		return nil
	}
	var candidates []struct {
		ServerID string `json:"server_id"`
	}
	if err := json.Unmarshal(candidatesRaw, &candidates); err != nil || len(candidates) == 0 {
		return nil
	}
	ids := make(map[string]struct{}, len(candidates))
	for _, c := range candidates {
		if c.ServerID != "" {
			ids[c.ServerID] = struct{}{}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	return ids
}
