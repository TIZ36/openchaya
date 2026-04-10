package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/harness/metrics"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

// PrimaryActor is the user's personal secretary agent.
// It's always alive, analyzes intent, delegates to SubActors, and summarizes results.
type PrimaryActor struct {
	*Actor
	supervisor *Supervisor

	delegationScratchMu sync.Mutex
	delegationScratchBody string
	delegationScratchSpecs []delegationTaskSpec
}

type delegationTaskSpec struct {
	ID             string `json:"id"`
	AgentType      string `json:"agent_type"`
	Task           string `json:"task"`
	ExpectedResult string `json:"expected_result"`
}

type delegationPlan struct {
	Tasks []delegationTaskSpec `json:"tasks"`
}

type delegationTaskResult struct {
	Spec     delegationTaskSpec
	Result   string
	Err      string
	TimedOut bool
}

// NewPrimaryActor creates a PrimaryAgent with full permissions and a supervisor.
func NewPrimaryActor(base *Actor, sv *Supervisor) *PrimaryActor {
	base.Config.Permissions = PrimaryRuleset
	base.IsPrimary = true
	return &PrimaryActor{Actor: base, supervisor: sv}
}

// Run starts the PrimaryAgent event loop.
func (p *PrimaryActor) Run(ctx context.Context) {
	defer close(p.done)
	slog.Info("primary agent started", "id", p.ID, "user", p.UserID)

	for {
		select {
		case env := <-p.Mailbox:
			p.Touch()
			p.handle(ctx, env)
		case <-ctx.Done():
			slog.Info("primary agent stopped", "id", p.ID)
			return
		}
	}
}

func (p *PrimaryActor) handle(ctx context.Context, env *envelope.Envelope) {
	switch env.Type {
	case envelope.TypeChat:
		p.handleChat(ctx, env)
	case envelope.TypeResult:
		// SubAgent returned a result — handled inline via channels
	case envelope.TypeInterrupt:
		slog.Info("primary agent interrupted", "id", p.ID)
	}
}

func (p *PrimaryActor) handleChat(ctx context.Context, env *envelope.Envelope) {
	slog.Info("primary handling chat", "id", p.ID, "conv", env.ConvID, "content_len", len(env.Body))
	resetExecutionTrace(env.ConvID)
	p.clearDelegationScratch()

	// 1. Immediately publish thinking and first step
	p.Hub.Publish(env.ConvID, map[string]any{
		"type":       "agent_thinking",
		"agent_id":   p.AgentID,
		"agent_name": agentDisplayName(p.Config.SystemPrompt),
	})
	p.publishPipelineStep(env.ConvID, "收到请求，正在分析...")

	delegate := p.shouldDelegate(ctx, env)
	metrics.LogHarnessRoute(env.ConvID, "handle_chat", string(ResolveHarnessRoutePhaseA(env).Kind), delegate)
	if p.Orchestrator != nil && p.Orchestrator.HarnessMetricsVerbose() {
		slog.Debug("harness_route_detail", "conv_id", env.ConvID, "body_len", len(env.Body),
			"route_kind", string(ResolveHarnessRoutePhaseA(env).Kind), "delegate", delegate)
	}
	var result string
	defer func() { p.recordTopologyTurn(ctx, env, result, delegate) }()
	if delegate {
		result = p.delegateAndSummarize(ctx, env)
	} else {
		result = p.streamChat(ctx, env)
	}
	slog.Info("primary chat done", "id", p.ID, "result_len", len(result))
}

func (p *PrimaryActor) shouldDelegate(ctx context.Context, env *envelope.Envelope) bool {
	ph := ResolveHarnessRoutePhaseA(env)
	switch ph.Kind {
	case HarnessRouteCapabilitySingle:
		p.publishPipelineStep(env.ConvID, "识别为能力配置请求，将交由专用子智能体处理")
		return true
	case HarnessRouteLinkFast:
		p.publishPipelineStep(env.ConvID, "识别为外部链接/飞书读取请求，转入工具执行链路")
		return true
	case HarnessRoutePreciseClassify:
		p.publishPipelineStep(env.ConvID, "正在判断任务类型...")
		del, specs := p.preciseClassifyAndPlan(ctx, env.ConvID, env.Body)
		if del {
			p.publishPipelineStep(env.ConvID, "判定为复杂任务，启动多步处理")
			p.storeDelegationScratch(env.Body, specs)
		} else {
			p.publishPipelineStep(env.ConvID, "判定为简单问题，直接回答")
			p.clearDelegationScratch()
		}
		return del
	case HarnessRouteHintClassify:
		p.publishPipelineStep(env.ConvID, "正在判断任务类型...")
		decision := p.classifyIntent(ctx, env.ConvID, env.Body)
		p.clearDelegationScratch()
		if decision == "need_delegate" {
			p.publishPipelineStep(env.ConvID, "判定为复杂任务，启动多步处理")
		} else {
			p.publishPipelineStep(env.ConvID, "判定为简单问题，直接回答")
		}
		return decision == "need_delegate"
	default:
		p.clearDelegationScratch()
		return false
	}
}

func (p *PrimaryActor) storeDelegationScratch(body string, specs []delegationTaskSpec) {
	p.delegationScratchMu.Lock()
	defer p.delegationScratchMu.Unlock()
	p.delegationScratchBody = body
	p.delegationScratchSpecs = specs
}

func (p *PrimaryActor) clearDelegationScratch() {
	p.delegationScratchMu.Lock()
	defer p.delegationScratchMu.Unlock()
	p.delegationScratchBody = ""
	p.delegationScratchSpecs = nil
}

func (p *PrimaryActor) takeDelegationScratch(body string) []delegationTaskSpec {
	p.delegationScratchMu.Lock()
	defer p.delegationScratchMu.Unlock()
	if p.delegationScratchBody != body || len(p.delegationScratchSpecs) == 0 {
		return nil
	}
	out := p.delegationScratchSpecs
	p.delegationScratchSpecs = nil
	p.delegationScratchBody = ""
	return out
}

func shouldForceDelegationForExternalRetrieval(body string) bool {
	msg := strings.ToLower(strings.TrimSpace(body))
	if msg == "" {
		return false
	}

	hasExternalLink := strings.Contains(msg, "http://") || strings.Contains(msg, "https://")
	hasFeishuRef := strings.Contains(msg, "feishu") || strings.Contains(msg, "lark") || strings.Contains(msg, "飞书")
	hasReadIntent := false
	for _, hint := range []string{
		"看下", "看看", "读取", "打开", "解析", "总结", "提取", "详情", "内容", "原文", "文档", "需求单",
		"read", "open", "fetch", "parse", "summarize", "extract", "details", "content", "document", "requirement",
	} {
		if strings.Contains(msg, hint) {
			hasReadIntent = true
			break
		}
	}

	if hasFeishuRef && (hasExternalLink || hasReadIntent) {
		return true
	}

	if hasExternalLink {
		for _, hint := range []string{"文档", "详情", "内容", "原文", "需求单", "page", "doc", "details", "content"} {
			if strings.Contains(msg, hint) {
				return true
			}
		}
	}

	return false
}

func responseMode(env *envelope.Envelope) string {
	if len(env.Data) == 0 {
		return ""
	}
	var payload struct {
		ResponseMode string `json:"response_mode"`
	}
	if err := json.Unmarshal(env.Data, &payload); err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(payload.ResponseMode))
}

// classifyIntent does a quick LLM call to decide: simple_chat vs need_delegate.
// It injects available tool names so the classifier knows what capabilities exist.
func (p *PrimaryActor) classifyIntent(ctx context.Context, convID, userMsg string) string {
	cancelHeartbeat := p.startHarnessHeartbeat(ctx, convID, "意图判定", 4*time.Second)
	defer cancelHeartbeat()

	// Gather available tool names for capability-aware classification
	var toolHint string
	if p.Orchestrator != nil && p.Orchestrator.MCPRegistry != nil {
		tools := p.Orchestrator.MCPRegistry.ListToolsForHarness(ctx, p.AgentID, 2*time.Second, nil, p.UserID, p.resolvedTenantID())
		if len(tools) > 0 {
			names := make([]string, 0, len(tools))
			for _, t := range tools {
				names = append(names, t.Name)
			}
			toolHint = fmt.Sprintf("\nAvailable tools: %s", strings.Join(names, ", "))
		}
	}

	prompt := fmt.Sprintf(`Classify the user's intent. Reply with exactly one word:
- "simple_chat" if this is a casual question, greeting, or general knowledge that you can answer directly
- "need_delegate" if this requires specialized tools (MCP), code editing, document retrieval, translation, data analysis, or other expert capabilities
%s
User message: %s

Classification:`, toolHint, userMsg)

	msgs := []provider.Message{
		{Role: "system", Content: "You are an intent classifier. Reply with exactly one word."},
		{Role: "user", Content: prompt},
	}
	resp, err := p.callLLM(ctx, msgs)
	metrics.LogHarnessLLMPhase(convID, "intent_classify", msgs, resp, err)
	if err != nil {
		slog.Warn("intent classification failed, defaulting to simple_chat", "err", err)
		return "simple_chat"
	}

	resp = strings.TrimSpace(strings.ToLower(resp))
	if strings.Contains(resp, "delegate") {
		return "need_delegate"
	}
	return "simple_chat"
}

// preciseClassifyAndPlan performs one LLM call for 精准模式: whether to delegate + optional task split (replaces separate classify + plan).
func (p *PrimaryActor) preciseClassifyAndPlan(ctx context.Context, convID, userMsg string) (delegate bool, specs []delegationTaskSpec) {
	cancelHeartbeat := p.startHarnessHeartbeat(ctx, convID, "意图与任务规划", 5*time.Second)
	defer cancelHeartbeat()

	var toolHint string
	if p.Orchestrator != nil && p.Orchestrator.MCPRegistry != nil {
		tools := p.Orchestrator.MCPRegistry.ListToolsForHarness(ctx, p.AgentID, 2*time.Second, nil, p.UserID, p.resolvedTenantID())
		if len(tools) > 0 {
			names := make([]string, 0, min(80, len(tools)))
			for i, t := range tools {
				if i >= 80 {
					break
				}
				names = append(names, t.Name)
			}
			toolHint = fmt.Sprintf("\nAvailable tool names (sample): %s", strings.Join(names, ", "))
		}
	}

	prompt := fmt.Sprintf(`You route the user message for a multi-agent assistant.
Return valid JSON only, shape:
{"delegate":true|false,"tasks":[{"id":"task_1","agent_type":"researcher","task":"...","expected_result":"..."}]}

Rules:
1) Set "delegate" to false if the user only needs a short direct answer, greeting, or general chat without tools.
2) Set "delegate" to true if MCP tools, code work, document retrieval, translation, data analysis, or multi-step expert work may help.
3) If delegate is true, provide 1-3 parallelizable subtasks with concrete "task" and "expected_result". Use agent_type like researcher / coder / verifier / writer / tempag.
4) If delegate is false, "tasks" must be [].

%s

User message:
%s`, toolHint, userMsg)

	msgs := []provider.Message{
		{Role: "system", Content: "You are a strict JSON router. Return JSON only."},
		{Role: "user", Content: prompt},
	}
	planCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	rawResp, err := p.callLLM(planCtx, msgs)
	metrics.LogHarnessLLMPhase(convID, "precise_classify_and_plan", msgs, rawResp, err)
	if err != nil {
		slog.Warn("precise classify+plan failed, defaulting to no delegate", "err", err)
		return false, nil
	}

	var parsed struct {
		Delegate bool                 `json:"delegate"`
		Tasks    []delegationTaskSpec `json:"tasks"`
	}
	jsonStr := extractFirstJSONObject(strings.TrimSpace(rawResp))
	if jsonStr == "" {
		jsonStr = strings.TrimSpace(rawResp)
	}
	if err := json.Unmarshal([]byte(jsonStr), &parsed); err != nil {
		slog.Warn("precise classify+plan parse failed", "err", err)
		return false, nil
	}
	if !parsed.Delegate {
		return false, nil
	}
	out := make([]delegationTaskSpec, 0, len(parsed.Tasks))
	for i, t := range parsed.Tasks {
		task := strings.TrimSpace(t.Task)
		exp := strings.TrimSpace(t.ExpectedResult)
		if task == "" || exp == "" {
			continue
		}
		id := strings.TrimSpace(t.ID)
		if id == "" {
			id = fmt.Sprintf("task_%d", i+1)
		}
		agentType := normalizeAgentType(t.AgentType)
		out = append(out, delegationTaskSpec{
			ID:             id,
			AgentType:      agentType,
			Task:           task,
			ExpectedResult: exp,
		})
		if len(out) >= 3 {
			break
		}
	}
	if len(out) == 0 {
		return true, []delegationTaskSpec{{
			ID:             "task_1",
			AgentType:      "tempag",
			Task:           userMsg,
			ExpectedResult: "给出完整、可执行且覆盖关键风险点的答案",
		}}
	}
	return true, out
}

// startHarnessHeartbeat periodically publishes progress logs during long-running Harness stages.
func (p *PrimaryActor) startHarnessHeartbeat(parent context.Context, convID, stage string, interval time.Duration) context.CancelFunc {
	if strings.TrimSpace(convID) == "" || interval <= 0 {
		return func() {}
	}
	ctx, cancel := context.WithCancel(parent)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		started := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				elapsed := int(time.Since(started).Seconds())
				p.publishPipelineStep(convID, fmt.Sprintf("%s...（%ds）", stage, elapsed))
			}
		}
	}()
	return cancel
}

// delegateAndSummarize creates a delegation plan, runs multiple SubAgents in parallel, and summarizes the merged result.
func (p *PrimaryActor) delegateAndSummarize(ctx context.Context, env *envelope.Envelope) string {
	convID := env.ConvID

	// Notify: delegating
	p.Hub.Publish(convID, map[string]any{
		"type": "agent_delegating", "agent_id": p.AgentID,
		"message": "Analyzing your request...",
	})
	p.publishPipelineStep(convID, "正在拆分任务...")
	var taskSpecs []delegationTaskSpec
	if pre := p.takeDelegationScratch(env.Body); len(pre) > 0 {
		taskSpecs = pre
	} else {
		taskSpecs = BuildDelegationTaskSpecs(ctx, p, convID, env.Body)
	}
	taskSpecs = DedupeDelegationTasks(taskSpecs)
	if len(taskSpecs) == 0 {
		taskSpecs = []delegationTaskSpec{
			{
				ID:             "task_1",
				AgentType:      "tempag",
				Task:           env.Body,
				ExpectedResult: "给出完整、可执行且覆盖关键风险点的答案",
			},
		}
	}
	for i, spec := range taskSpecs {
		p.publishPipelineStep(convID, fmt.Sprintf("任务 %d：%s（期望：%s）", i+1, spec.Task, spec.ExpectedResult))
	}
	p.logCapabilityUsage(ctx, convID, env.Body)

	delegationTimeout := 60 * time.Second
	if isCapabilitySetupIntent(env.Body) {
		delegationTimeout = 120 * time.Second
	}
	parallelCtx, cancel := context.WithTimeout(ctx, delegationTimeout)
	defer cancel()
	cancelHeartbeat := func() {}

	results := make([]delegationTaskResult, 0, len(taskSpecs))
	resultCh := make(chan delegationTaskResult, len(taskSpecs))
	var wg sync.WaitGroup
	launched := 0
	cacheHitCount := 0

	for i, spec := range taskSpecs {
		resolvedType := chooseDelegationAgentType(spec)
		spec.AgentType = resolvedType
		agentType := fmt.Sprintf("%s_%d", normalizeAgentType(resolvedType), i+1)
		subPrompt := fmt.Sprintf("You are a capable specialist assistant for %s. Complete the delegated task thoroughly and concisely.", spec.AgentType)
		if resolvedType == "capability" {
			subPrompt = "You are Chaya's capability configuration executor. Use only chaya_* builtin tools: chaya_create_mcp_server for new MCP URLs, chaya_bind_mcp_to_agent / chaya_bind_skill_to_agent for bindings, chaya_list_* for ids. Reply in Chinese when the user writes Chinese."
		}
		lease, err := p.supervisor.EnsureSubActorLease(agentType, ActorConfig{SystemPrompt: subPrompt})
		if err != nil {
			slog.Error("delegate: ensure sub actor failed", "agent_type", agentType, "err", err)
			results = append(results, delegationTaskResult{
				Spec: spec,
				Err:  "failed to create sub-actor: " + err.Error(),
			})
			continue
		}

		// Check cache (external URL tasks bypass cache to avoid stale remote content)
		fingerprint := p.supervisor.tempStore.GetTaskFingerprint(p.UserID, spec.Task, spec.ExpectedResult, spec.AgentType)
		shouldBypassCache := strings.Contains(spec.Task, "http://") || strings.Contains(spec.Task, "https://") || isCapabilitySetupIntent(spec.Task)
		if shouldBypassCache {
			if strings.Contains(spec.Task, "http://") || strings.Contains(spec.Task, "https://") {
				p.publishPipelineStepWithType(convID, "", "检测到外部链接，跳过结果缓存", "info")
			} else if isCapabilitySetupIntent(spec.Task) {
				p.publishPipelineStepWithType(convID, "", "能力配置任务，跳过结果缓存", "info")
			}
		}
		if !shouldBypassCache {
			if cached, ok := p.supervisor.tempStore.GetResult(ctx, fingerprint); ok {
				p.publishPipelineStepWithType(convID, "", "命中缓存，跳过执行", "cache_hit")
				results = append(results, delegationTaskResult{Spec: spec, Result: cached})
				cacheHitCount++
				continue
			}
		}

		if lease.Created {
			p.publishPipelineStep(convID, fmt.Sprintf("已分配子智能体 %s", agentType))
		} else if lease.Reused {
			p.publishPipelineStep(convID, fmt.Sprintf("复用子智能体 %s", agentType))
		}

		extraConstraint := ""
		taskLower := strings.ToLower(spec.Task)
		if strings.Contains(taskLower, "http://") || strings.Contains(taskLower, "https://") || strings.Contains(taskLower, "feishu") {
			extraConstraint = "\n4) 若任务涉及外部链接，必须优先调用工具读取原文；若无法访问，明确说明「未能读取原文」，禁止臆测内容。"
		}
		capExtra := ""
		if spec.AgentType == "capability" {
			capExtra = "\n5) 能力配置任务：仅使用 chaya_* 内置工具；新建 MCP 用 chaya_create_mcp_server，绑定用 chaya_bind_*；不要编造 id，先用 chaya_list_* 查询。"
		}
		taskBody := fmt.Sprintf(
			"【用户原始需求】\n%s\n\n【你负责的子任务】\n%s\n\n【期望结果】\n%s\n\n【输出要求】\n1) 仅输出与你子任务相关的结果\n2) 若信息不足，明确列出缺失点与风险\n3) 给出可直接用于最终汇总的结论与依据%s%s",
			env.Body, spec.Task, spec.ExpectedResult, extraConstraint, capExtra,
		)
		taskEnv := envelope.Task(p.ID, lease.Actor.ID, convID, taskBody)
		taskEnv.ReplyTo = env.ID
		if spec.AgentType == "capability" {
			taskEnv.Data = buildCapabilityDelegationData(env.Data, map[string]any{
				"task":            spec.Task,
				"expected_result": spec.ExpectedResult,
				"agent_type":      "capability",
				"task_kind":       "capability_setup",
			})
		} else {
			delegationMeta := p.buildDelegationTaskMeta(ctx, spec.Task, spec.ExpectedResult, spec.AgentType)
			taskEnv.Data = mergeDelegationTaskData(env.Data, delegationMeta)
		}
		waitResultCh := p.supervisor.WaitResult(taskEnv.ID)

		launched++
		lease.Actor.Mailbox <- taskEnv
		wg.Add(1)
		go func(spec delegationTaskSpec, ch <-chan string, fp string) {
			defer wg.Done()
			select {
			case result := <-ch:
				// Save to cache only for stable/success-like results.
				if shouldCacheDelegationResult(result) {
					p.supervisor.tempStore.SaveResult(ctx, fp, TempAgRecord{
						UserID:         p.UserID,
						Task:           spec.Task,
						ExpectedResult: spec.ExpectedResult,
						AgentType:      spec.AgentType,
						Result:         result,
					})
				}
				resultCh <- delegationTaskResult{Spec: spec, Result: result}
			case <-parallelCtx.Done():
				resultCh <- delegationTaskResult{Spec: spec, Err: "timed out waiting for sub-actor", TimedOut: true}
			}
		}(spec, waitResultCh, fingerprint)
	}
	if launched > 0 && cacheHitCount > 0 {
		p.publishPipelineStep(convID, fmt.Sprintf("开始执行：%d 个子任务（%d 个缓存命中）", launched, cacheHitCount))
	} else if launched > 0 {
		p.publishPipelineStep(convID, fmt.Sprintf("开始执行：%d 个子任务", launched))
	}
	if launched > 0 {
		cancelHeartbeat = p.startHarnessHeartbeat(parallelCtx, convID, "子任务执行中", 5*time.Second)
	} else if cacheHitCount > 0 {
		p.publishPipelineStepWithType(convID, "", "全部命中缓存，直接使用历史结果", "info")
	}

	go func() {
		wg.Wait()
		close(resultCh)
	}()

	for r := range resultCh {
		results = append(results, r)
		if r.Err == "" {
			p.publishPipelineStepWithTypeDetail(
				convID,
				"",
				fmt.Sprintf("子任务 %s 已完成，点击查看回答", r.Spec.AgentType),
				truncateLogDetail(r.Result, 6000),
				"success",
			)
		}
	}

	var successCount int
	for _, r := range results {
		if r.Err == "" {
			successCount++
		}
	}

	if launched > 0 && successCount == 0 {
		p.publishPipelineStepWithType(convID, "", "所有子任务失败，正在尝试降级回答...", "error")
	} else if successCount < len(taskSpecs) {
		p.publishPipelineStepWithType(convID, "", fmt.Sprintf("部分任务失败（%d/%d），汇总中标记不确定性", successCount, len(taskSpecs)), "warning")
	} else {
		p.publishPipelineStep(convID, "所有子任务完成，正在汇总回答...")
	}

	subResult := formatDelegationResults(results)
	if parallelCtx.Err() != nil {
		p.publishPipelineStepWithType(convID, "", "部分子任务超时，使用已完成结果继续", "warning")
	}
	cancelHeartbeat()

	metrics.LogHarnessDelegationComplete(convID, delegationRouteSummary(taskSpecs), len(taskSpecs), cacheHitCount, launched)

	// Summarize: PrimaryAgent wraps the result in its own voice
	res := p.summarizeAndStream(ctx, env, subResult)

	// Clean up trace after full cycle
	clearExecutionTrace(convID)
	return res
}

// summarizeAndStream takes a SubAgent result and streams a final response to the user.
func (p *PrimaryActor) summarizeAndStream(ctx context.Context, env *envelope.Envelope, subResult string) string {
	convID := env.ConvID
	p.persistUserMessage(convID, env.Body, env.From)

	// If subResult is short enough, stream it directly with PrimaryAgent persona
	p.mu.Lock()
	p.history = append(p.history,
		provider.Message{Role: "user", Content: env.Body},
		provider.Message{Role: "assistant", Content: fmt.Sprintf("[Internal work result]\n%s", subResult)},
		provider.Message{Role: "user", Content: "Based on the above work result, give the user a clear, complete answer in your own style."},
	)
	messages := make([]provider.Message, len(p.history))
	copy(messages, p.history)
	p.mu.Unlock()

	// Stream the summarized response
	assistantMsg := p.streamAssistantResponse(ctx, convID, messages)

	// Clean up history: replace the 3 internal messages with just user+assistant
	p.mu.Lock()
	if len(p.history) >= 3 {
		p.history = p.history[:len(p.history)-3]
	}
	p.history = append(p.history,
		provider.Message{Role: "user", Content: env.Body},
		provider.Message{Role: "assistant", Content: assistantMsg},
	)
	p.mu.Unlock()

	return assistantMsg
}

func (p *PrimaryActor) buildDelegationPlan(ctx context.Context, convID, userMsg string) []delegationTaskSpec {
	planCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	prompt := fmt.Sprintf(`You are a task planner for multi-agent delegation.
Split the user's request into 2-3 parallelizable subtasks.
Each subtask must include:
- id
- agent_type (short role, e.g. researcher / coder / verifier / writer)
- task
- expected_result

Rules:
1) Subtasks should be complementary and independently executable.
2) Keep task descriptions concrete and outcome-oriented.
3) Return valid JSON only, in this shape:
{"tasks":[{"id":"task_1","agent_type":"researcher","task":"...","expected_result":"..."}]}

User request:
%s`, userMsg)

	msgs := []provider.Message{
		{Role: "system", Content: "You are a strict JSON planner. Return JSON only."},
		{Role: "user", Content: prompt},
	}
	resp, err := p.callLLM(planCtx, msgs)
	metrics.LogHarnessLLMPhase(convID, "delegation_plan", msgs, resp, err)
	if err != nil {
		slog.Warn("delegation plan failed, fallback single task", "err", err)
		p.publishPipelineStep(convID, "任务拆分失败，将作为单任务处理")
		return []delegationTaskSpec{{
			ID:             "task_1",
			AgentType:      "tempag",
			Task:           userMsg,
			ExpectedResult: "给出完整、可执行且覆盖关键风险点的答案",
		}}
	}

	plan := delegationPlan{}
	raw := extractFirstJSONObject(strings.TrimSpace(resp))
	if raw == "" {
		raw = strings.TrimSpace(resp)
	}
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		slog.Warn("delegation plan parse failed, fallback single task", "raw", raw, "err", err)
		p.publishPipelineStep(convID, "任务拆分解析失败，将作为单任务处理")
		return []delegationTaskSpec{{
			ID:             "task_1",
			AgentType:      "tempag",
			Task:           userMsg,
			ExpectedResult: "给出完整、可执行且覆盖关键风险点的答案",
		}}
	}

	out := make([]delegationTaskSpec, 0, len(plan.Tasks))
	for i, t := range plan.Tasks {
		task := strings.TrimSpace(t.Task)
		exp := strings.TrimSpace(t.ExpectedResult)
		if task == "" || exp == "" {
			continue
		}
		id := strings.TrimSpace(t.ID)
		if id == "" {
			id = fmt.Sprintf("task_%d", i+1)
		}
		agentType := normalizeAgentType(t.AgentType)
		out = append(out, delegationTaskSpec{
			ID:             id,
			AgentType:      agentType,
			Task:           task,
			ExpectedResult: exp,
		})
		if len(out) >= 3 {
			break
		}
	}
	if len(out) == 0 {
		return []delegationTaskSpec{{
			ID:             "task_1",
			AgentType:      "tempag",
			Task:           userMsg,
			ExpectedResult: "给出完整、可执行且覆盖关键风险点的答案",
		}}
	}
	return out
}

func chooseDelegationAgentType(spec delegationTaskSpec) string {
	raw := strings.ToLower(strings.TrimSpace(spec.AgentType))
	task := strings.ToLower(strings.TrimSpace(spec.Task))
	if raw == "capability" {
		return "capability"
	}
	if raw == "" {
		raw = "tempag"
	}
	// 对链接抓取/文档整理类任务，优先使用 tempag，避免退回泛化 general。
	if raw == "general" {
		if strings.Contains(task, "http://") || strings.Contains(task, "https://") ||
			strings.Contains(task, "feishu") || strings.Contains(task, "文档") ||
			strings.Contains(task, "wiki") || strings.Contains(task, "整理") {
			return "tempag"
		}
	}
	return raw
}

func normalizeAgentType(v string) string {
	s := strings.TrimSpace(strings.ToLower(v))
	if s == "" {
		return "general"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '_' || r == '-':
			b.WriteRune('_')
		case r == ' ':
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "general"
	}
	return out
}

func extractFirstJSONObject(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start == -1 || end == -1 || end <= start {
		return ""
	}
	return s[start : end+1]
}

func delegationRouteSummary(specs []delegationTaskSpec) string {
	if len(specs) == 0 {
		return "empty"
	}
	counts := make(map[string]int)
	for _, s := range specs {
		counts[s.AgentType]++
	}
	b := strings.Builder{}
	b.WriteString(fmt.Sprintf("n=%d", len(specs)))
	for k, v := range counts {
		b.WriteString(fmt.Sprintf(";%s=%d", k, v))
	}
	return b.String()
}

func formatDelegationResults(results []delegationTaskResult) string {
	if len(results) == 0 {
		return "(No delegated results)"
	}
	var b strings.Builder
	b.WriteString("[Parallel Delegation Results]\n")
	for i, r := range results {
		b.WriteString(fmt.Sprintf("\n### Task %d (%s)\n", i+1, r.Spec.AgentType))
		b.WriteString(fmt.Sprintf("- Task: %s\n", r.Spec.Task))
		b.WriteString(fmt.Sprintf("- Expected: %s\n", r.Spec.ExpectedResult))
		if r.Err != "" {
			b.WriteString(fmt.Sprintf("- Status: failed (%s)\n", r.Err))
			continue
		}
		b.WriteString("- Status: success\n")
		b.WriteString("Result:\n")
		b.WriteString(r.Result)
		b.WriteString("\n")
	}
	return b.String()
}

func (p *PrimaryActor) logCapabilityUsage(ctx context.Context, convID, userMsg string) {
	if p.Orchestrator == nil || p.DB == nil {
		return
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	tid := p.resolvedTenantID()
	topoOn := topologyEnabledFromExt(p.Config.Ext)
	ec := p.Orchestrator.BuildContext(checkCtx, userMsg, p.AgentID, p.UserID, tid, topoOn, true, nil, nil)
	if ec == nil {
		return
	}
	p.syncTopologyIntentFromEC(ec)
	var capParts []string
	if len(ec.MCPTools) > 0 {
		capParts = append(capParts, fmt.Sprintf("%d 个工具", len(ec.MCPTools)))
	}
	if len(ec.ActiveSkills) > 0 {
		capParts = append(capParts, fmt.Sprintf("%d 个技能", len(ec.ActiveSkills)))
	}
	if strings.TrimSpace(ec.KBContext) != "" {
		capParts = append(capParts, "知识库命中")
	}
	if len(capParts) > 0 {
		p.publishPipelineStepWithType(convID, "", fmt.Sprintf("可用能力：%s", strings.Join(capParts, "，")), "info")
	}
}

func truncateLogDetail(s string, max int) string {
	if max <= 0 {
		return ""
	}
	src := strings.TrimSpace(s)
	if len(src) <= max {
		return src
	}
	return src[:max] + "\n...(已截断)"
}

func shouldCacheDelegationResult(result string) bool {
	r := strings.TrimSpace(result)
	if r == "" {
		return false
	}
	for _, bad := range []string{
		"(Error:",
		"(Error after max iterations:",
		"timed out waiting for sub-actor",
		"(Sub-agent timed out)",
		"[错误]",
		"无法产生回复",
	} {
		if strings.Contains(r, bad) {
			return false
		}
	}
	return true
}

func (p *PrimaryActor) buildDelegationTaskMeta(ctx context.Context, task, expectedResult, agentType string) map[string]any {
	meta := map[string]any{
		"task":            strings.TrimSpace(task),
		"expected_result": strings.TrimSpace(expectedResult),
		"agent_type":      strings.TrimSpace(agentType),
	}
	if p.Orchestrator == nil || p.DB == nil {
		return meta
	}

	metaCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	tid := p.resolvedTenantID()
	topoOn := topologyEnabledFromExt(p.Config.Ext)
	ec := p.Orchestrator.BuildContext(metaCtx, task, p.AgentID, p.UserID, tid, topoOn, true, nil, nil)
	if ec == nil {
		return meta
	}

	if len(ec.MCPTools) > 0 {
		candidates := make([]map[string]any, 0, len(ec.MCPTools))
		seen := map[string]struct{}{}
		for _, t := range ec.MCPTools {
			key := strings.TrimSpace(t.ServerID) + "::" + strings.TrimSpace(t.Name)
			if key == "::" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			candidates = append(candidates, map[string]any{
				"name":      t.Name,
				"server_id": t.ServerID,
			})
			if len(candidates) >= 100 {
				break
			}
		}
		meta["mcp_candidates"] = candidates
	}

	if len(ec.ActiveSkills) > 0 {
		skills := make([]map[string]any, 0, len(ec.ActiveSkills))
		for _, s := range ec.ActiveSkills {
			skills = append(skills, map[string]any{
				"id":           s.ID,
				"name":         s.Name,
				"required_mcp": s.RequiredMCP,
			})
			if len(skills) >= 10 {
				break
			}
		}
		meta["skill_candidates"] = skills
	}

	kbPreview := strings.TrimSpace(ec.KBContext)
	if len(kbPreview) > 1000 {
		kbPreview = kbPreview[:1000] + "\n...(已截断)"
	}
	meta["kb"] = map[string]any{
		"hit":     kbPreview != "",
		"preview": kbPreview,
	}
	return meta
}

func mergeDelegationTaskData(raw json.RawMessage, delegationMeta map[string]any) json.RawMessage {
	payload := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		_ = json.Unmarshal(raw, &payload)
	}
	payload["delegation"] = map[string]any{
		"temp_mcp_auth":     true,
		"scope":             "associated_mcp_only",
		"related_resources": delegationMeta,
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return json.RawMessage(buf)
}

// buildCapabilityDelegationData marks delegation for DB-writing setup sub-agents (no temp MCP tool list).
func buildCapabilityDelegationData(raw json.RawMessage, delegationMeta map[string]any) json.RawMessage {
	payload := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		_ = json.Unmarshal(raw, &payload)
	}
	payload["delegation"] = map[string]any{
		"temp_mcp_auth":     false,
		"task_kind":         "capability_setup",
		"scope":             "tenant_db_write",
		"related_resources": delegationMeta,
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return json.RawMessage(buf)
}

// isCapabilitySetupIntent returns true when the user likely wants to create/bind/configure MCP or Skill for agents.
func isCapabilitySetupIntent(msg string) bool {
	m := strings.TrimSpace(strings.ToLower(msg))
	if m == "" {
		return false
	}
	hasTarget := strings.Contains(m, "mcp") || strings.Contains(m, "技能") || strings.Contains(m, "skill") || strings.Contains(m, "助手")
	if !hasTarget {
		return false
	}
	triggers := []string{
		// 中文：含「增加/新建」等口语，避免只认「添加」导致走错子智能体
		"绑定", "关联", "添加", "增加", "新建", "创建", "录入", "接入", "配置", "挂接", "绑到", "加到", "给", "装上", "删除", "解绑", "移除",
		"bind", "attach", "link", "add", "enable", "create", "new", "remove", "delete", "unregister",
	}
	for _, t := range triggers {
		if strings.Contains(m, t) {
			return true
		}
	}
	// 粘贴了 MCP HTTP 端点（路径含 /mcp）时，视为配置意图，避免仅缺省「添加」等动词就委派给 tempag
	if hasTarget && strings.Contains(m, "/mcp") &&
		(strings.Contains(m, "http://") || strings.Contains(m, "https://")) {
		return true
	}
	return false
}
