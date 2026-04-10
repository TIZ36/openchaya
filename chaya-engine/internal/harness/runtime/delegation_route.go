package runtime

import (
	"context"
	"strings"

	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

// HarnessRouteKind identifies the pre-LLM routing branch for observability and tests.
type HarnessRouteKind string

const (
	HarnessRouteDirectChat       HarnessRouteKind = "no_delegate"
	HarnessRouteCapabilitySingle HarnessRouteKind = "capability_single"
	HarnessRouteLinkFast         HarnessRouteKind = "link_fast"
	HarnessRoutePreciseClassify  HarnessRouteKind = "precise_classify"
	HarnessRouteHintClassify     HarnessRouteKind = "hint_classify"
)

// HarnessRoutePhaseA is the deterministic routing outcome before any delegation-plan LLM.
type HarnessRoutePhaseA struct {
	Kind HarnessRouteKind
}

// ResolveHarnessRoutePhaseA returns the first matching branch in priority order (FSM).
// Does not call LLM; precise/hint paths require classifyIntent in a second step.
func ResolveHarnessRoutePhaseA(env *envelope.Envelope) HarnessRoutePhaseA {
	if env == nil {
		return HarnessRoutePhaseA{Kind: HarnessRouteDirectChat}
	}
	body := env.Body
	if isCapabilitySetupIntent(body) {
		return HarnessRoutePhaseA{Kind: HarnessRouteCapabilitySingle}
	}
	if shouldForceDelegationForExternalRetrieval(body) {
		return HarnessRoutePhaseA{Kind: HarnessRouteLinkFast}
	}
	if responseMode(env) == "precise" {
		return HarnessRoutePhaseA{Kind: HarnessRoutePreciseClassify}
	}
	msg := strings.ToLower(strings.TrimSpace(body))
	if msg == "" {
		return HarnessRoutePhaseA{Kind: HarnessRouteDirectChat}
	}
	if len([]rune(msg)) <= 24 {
		return HarnessRoutePhaseA{Kind: HarnessRouteDirectChat}
	}
	delegateHints := []string{
		"mcp", "tool", "tools", "code", "coding", "debug", "bug", "fix", "refactor",
		"search", "retrieve", "document", "docs", "kb", "knowledge base",
		"translate", "translation", "analyze", "analysis", "data", "sql",
		"日志", "报错", "修复", "代码", "文档", "分析", "数据", "查询", "翻译",
	}
	for _, hint := range delegateHints {
		if strings.Contains(msg, hint) {
			return HarnessRoutePhaseA{Kind: HarnessRouteHintClassify}
		}
	}
	return HarnessRoutePhaseA{Kind: HarnessRouteDirectChat}
}

// BuildDelegationTaskSpecs builds task specs from user message (mirrors delegateAndSummarize branches).
func BuildDelegationTaskSpecs(ctx context.Context, p *PrimaryActor, convID, userBody string) []delegationTaskSpec {
	if isCapabilitySetupIntent(userBody) {
		return []delegationTaskSpec{{
			ID:             "capability_1",
			AgentType:      "capability",
			Task:           userBody,
			ExpectedResult: "使用内置 chaya_* 工具完成新建/绑定或说明阻塞原因；新建 MCP 用 chaya_create_mcp_server；OAuth 需推送事件并指导用户在前端授权",
		}}
	}
	if shouldForceDelegationForExternalRetrieval(userBody) {
		return []delegationTaskSpec{{
			ID:             "link_retrieval_1",
			AgentType:      "tempag",
			Task:           userBody,
			ExpectedResult: "读取链接原文，提取并返回完整内容",
		}}
	}
	return p.buildDelegationPlan(ctx, convID, userBody)
}

// DedupeDelegationTasks removes duplicate task+expected pairs (same normalized text).
func DedupeDelegationTasks(specs []delegationTaskSpec) []delegationTaskSpec {
	if len(specs) <= 1 {
		return specs
	}
	seen := make(map[string]struct{}, len(specs))
	out := make([]delegationTaskSpec, 0, len(specs))
	for _, s := range specs {
		key := strings.ToLower(strings.TrimSpace(s.Task)) + "|" + strings.ToLower(strings.TrimSpace(s.ExpectedResult))
		if key == "|" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	if len(out) == 0 {
		return specs
	}
	return out
}
