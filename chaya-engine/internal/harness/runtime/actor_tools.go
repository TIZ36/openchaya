package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

// warnBrokenMCP surfaces bound-but-unusable MCP servers (expired OAuth token,
// unreachable, etc.) to both the user and the model. It emits a one-time
// execution-log warning per server (deduped for the actor's lifetime) and
// injects a system note every turn so the LLM guides the user to re-authorize
// rather than fabricating a tool result. Returns the (possibly extended)
// message slice with the note prepended/merged into the system message.
func (a *Actor) warnBrokenMCP(convID string, messages []provider.Message, broken []mcp.MCPServerStatus) []provider.Message {
	names := make([]string, 0, len(broken))
	for _, b := range broken {
		names = append(names, b.Name)

		a.mu.Lock()
		if a.mcpWarned == nil {
			a.mcpWarned = map[string]struct{}{}
		}
		_, seen := a.mcpWarned[b.ID]
		if !seen {
			a.mcpWarned[b.ID] = struct{}{}
		}
		a.mu.Unlock()

		if !seen {
			action := "请检查该 MCP 服务的连通性后重试"
			if b.NeedsAuth {
				action = "请在「MCP 设置」中重新授权后重试"
			}
			a.publishPipelineStepWithType(convID, "",
				fmt.Sprintf("⚠️ MCP「%s」当前不可用：%s —— %s", b.Name, b.Reason, action), "warning")
		}
	}

	note := fmt.Sprintf("\n\n【工具状态提醒】以下已绑定的 MCP 工具当前不可用：%s。"+
		"如果用户的请求需要用到这些工具，请如实告知该工具暂时不可用（多为 OAuth 授权过期或服务不通），"+
		"并提示用户在「MCP 设置」中重新授权或检查服务连通后再试；不要假装已经调用，也不要编造工具结果。",
		strings.Join(names, "、"))

	out := make([]provider.Message, len(messages))
	copy(out, messages)
	if len(out) > 0 && out[0].Role == "system" {
		out[0].Content += note
	} else {
		out = append([]provider.Message{{Role: "system", Content: strings.TrimSpace(note)}}, out...)
	}
	return out
}

// streamChatWithTools runs a function-calling loop for an agent that has bound
// MCP tools, then delivers the final answer to the chat UI. It mirrors the
// SubActor.callLLMWithTools loop, but is reachable directly from a PrimaryActor
// (or any Actor) so a user talking to their main agent can use its MCP tools
// WITHOUT the request being routed through delegation first.
//
// Tool resolution is non-streaming (StreamChunk can't carry tool calls). Once
// the model produces an answer with no further tool calls we emit it through
// the same agent_thinking / agent_stream_chunk / agent_stream_done events the
// pure-streaming path uses, so the frontend renders it identically. The loop
// publishes tool_start / tool_done execution logs for live progress.
func (a *Actor) streamChatWithTools(ctx context.Context, convID string, messages []provider.Message, mcpTools []pkg.Tool) string {
	providerTools, toolIndex := convertTools(mcpTools)
	if len(providerTools) == 0 {
		return a.streamAssistantResponse(ctx, convID, messages)
	}

	doom := intelligence.NewDoomLoopDetector()

	for iter := 0; iter < maxToolIterations; iter++ {
		a.publishPipelineStep(convID, fmt.Sprintf("第 %d 轮推理...", iter+1))

		a.reloadRuntimeConfigFromDB()
		llm, model := a.resolveLLM()

		// On the last allowed iteration drop tools and force a final answer,
		// saving the otherwise-wasted "you're out of iterations" round-trip.
		iterTools := providerTools
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
			slog.Error("actor tool call LLM error", "id", a.ID, "iteration", iter, "err", err)
			a.publishPipelineStepWithType(convID, "", "请求失败："+err.Error(), "error")
			return a.emitAssistantMessage(ctx, convID, "❌ Error: "+err.Error(), "")
		}

		// No tool calls → the model is ready to answer. Emit its content
		// directly (no extra streaming round-trip — see file header).
		if len(resp.ToolCalls) == 0 {
			return a.emitAssistantMessage(ctx, convID, resp.Content, resp.Reasoning)
		}

		// Append the assistant's tool-call turn. Reasoning MUST be round-tripped
		// for reasoning models (DeepSeek-Reasoner / Qwen-thinking) or the next
		// call rejects with HTTP 400 "reasoning_content must be passed back".
		messages = append(messages, provider.Message{
			Role:      "assistant",
			Content:   resp.Content,
			Reasoning: resp.Reasoning,
			ToolCalls: resp.ToolCalls,
		})

		// Execute the requested tools in parallel within this iteration; the
		// doom check stays sequential so its gating decision is deterministic.
		type toolOutcome struct {
			content  string
			duration time.Duration
			tc       provider.ToolCall
			skipped  bool
		}
		outcomes := make([]toolOutcome, len(resp.ToolCalls))
		var wg sync.WaitGroup
		for i, tc := range resp.ToolCalls {
			argsSummary := tc.Arguments
			if len(argsSummary) > 120 {
				argsSummary = argsSummary[:120] + "..."
			}
			a.publishPipelineStepWithType(convID, "", fmt.Sprintf("调用工具 %s（%s）", tc.Name, argsSummary), "tool_start")

			if doom.Check(tc.Name, tc.Arguments) {
				slog.Warn("doom loop detected", "tool", tc.Name, "iteration", iter)
				a.publishPipelineStepWithType(convID, "", fmt.Sprintf("检测到工具重复调用 %s，已终止", tc.Name), "error")
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
				result := a.executeTool(ctx, tc, toolIndex)
				outcomes[i] = toolOutcome{tc: tc, content: result, duration: time.Since(start)}
			}(i, tc)
		}
		wg.Wait()

		for _, o := range outcomes {
			if !o.skipped {
				a.publishPipelineStepWithType(convID, "", fmt.Sprintf("工具完成 %s（%dms，%d 字符）", o.tc.Name, o.duration.Milliseconds(), len(o.content)), "tool_done")
			}
			messages = append(messages, provider.Message{
				Role:       "tool",
				Content:    o.content,
				ToolCallID: o.tc.ID,
			})
		}
	}

	// Max iterations reached — force a final answer without tools, streamed.
	a.publishPipelineStep(convID, "已达工具调用上限，正在生成最终回答...")
	messages = append(messages, provider.Message{
		Role:    "user",
		Content: "You have used all available tool call iterations. Please provide your best final answer now based on the tool results you have.",
	})
	return a.streamAssistantResponse(ctx, convID, messages)
}

// emitAssistantMessage delivers a pre-computed final answer to the chat UI using
// the same event sequence as the streaming path (agent_thinking → chunk → done)
// plus DB persistence, followups, and reasoning round-trip. Used by the tool
// loop, where the answer is produced by a non-streaming call.
func (a *Actor) emitAssistantMessage(ctx context.Context, convID, content, reasoning string) string {
	assistantMsg := pgstore.Message{ConvID: convID, Role: "assistant", AgentID: &a.AgentID}
	if a.DB != nil {
		a.DB.Create(&assistantMsg)
	}
	logsForMessage := bindExecutionTraceMessage(convID, assistantMsg.ID)

	a.Hub.Publish(convID, map[string]any{
		"type":           "agent_thinking",
		"agent_id":       a.AgentID,
		"agent_name":     agentDisplayName(a.Config.SystemPrompt),
		"message_id":     assistantMsg.ID,
		"execution_logs": logsForMessage,
	})

	if reasoning != "" {
		a.Hub.Publish(convID, map[string]any{
			"type":       "agent_reasoning_chunk",
			"agent_id":   a.AgentID,
			"message_id": assistantMsg.ID,
			"content":    reasoning,
			"chunk":      reasoning,
		})
	}

	// Deliver the answer in modest slices so the UI's incremental renderer
	// still animates it landing, rather than a single jarring blob. Each event
	// carries the cumulative content (what the frontend renders) plus the delta.
	const sliceLen = 80
	runes := []rune(content)
	var built strings.Builder
	for off := 0; off < len(runes); off += sliceLen {
		end := off + sliceLen
		if end > len(runes) {
			end = len(runes)
		}
		chunk := string(runes[off:end])
		built.WriteString(chunk)
		a.Hub.Publish(convID, map[string]any{
			"type":       "agent_stream_chunk",
			"agent_id":   a.AgentID,
			"message_id": assistantMsg.ID,
			"content":    built.String(),
			"chunk":      chunk,
		})
	}

	if a.DB != nil {
		a.DB.Model(&pgstore.Message{}).Where("id = ?", assistantMsg.ID).Update("content", content)
		textData, _ := json.Marshal(map[string]string{"text": content})
		a.DB.Create(&pgstore.MessagePart{MessageID: assistantMsg.ID, Type: "text", State: "completed", Data: textData})
	}

	finalLogs := finishExecutionTrace(convID)
	ext := map[string]any{
		"agent_log":     finalLogs,
		"log":           finalLogs,
		"executionLogs": finalLogs,
	}
	if reasoning != "" {
		ext["reasoning"] = reasoning
	}
	a.persistMessageExt(assistantMsg.ID, ext)

	doneEvt := map[string]any{
		"type":           "agent_stream_done",
		"agent_id":       a.AgentID,
		"message_id":     assistantMsg.ID,
		"content":        content,
		"execution_logs": finalLogs,
	}
	if reasoning != "" {
		doneEvt["reasoning"] = reasoning
	}
	a.Hub.Publish(convID, doneEvt)

	go a.publishFollowups(convID, assistantMsg.ID, "", content)

	if !a.IsPrimary {
		clearExecutionTrace(convID)
	}

	a.mu.Lock()
	a.lastReasoning = reasoning
	a.mu.Unlock()

	return content
}

// executeTool dispatches a single tool call to the appropriate handler (MCP or ExecuteFn).
func (a *Actor) executeTool(ctx context.Context, tc provider.ToolCall, toolIndex map[string]pkg.Tool) string {
	pkgTool, found := toolIndex[tc.Name]
	if !found {
		return fmt.Sprintf("Error: tool %q not found. Available tools: %s. Try a different tool name, or use web_fetch as a fallback for URL content.",
			tc.Name, availableToolNames(toolIndex))
	}

	args := json.RawMessage(tc.Arguments)

	// MCP tool → CallTool via registry (userID/tenantID needed for OAuth MCP servers)
	if pkgTool.Source == "mcp" && pkgTool.ServerID != "" && a.Orchestrator != nil && a.Orchestrator.MCPRegistry != nil {
		result, err := a.Orchestrator.MCPRegistry.CallTool(ctx, pkgTool.ServerID, tc.Name, args, a.UserID, a.resolvedTenantID())
		if err != nil {
			return fmt.Sprintf("Error calling %s: %s. Try different parameters, a different tool, or use web_fetch as a fallback.", tc.Name, err.Error())
		}
		if !result.Success {
			return fmt.Sprintf("Error from %s: %s. The tool returned an error — try different parameters, a different tool, or use web_fetch as a fallback.", tc.Name, result.Error)
		}
		return result.Body
	}

	// Generic tool with ExecuteFn
	if pkgTool.ExecuteFn != nil {
		result, err := pkgTool.ExecuteFn(ctx, args)
		if err != nil {
			return fmt.Sprintf("Error executing %s: %s. Try a different approach or tool.", tc.Name, err.Error())
		}
		return result.Body
	}

	return fmt.Sprintf("Error: tool %q has no execution handler", tc.Name)
}
