package topology

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Match represents a topology lookup result.
type Match struct {
	Intent     *Node          `json:"intent"`
	Path       *ExecutionPath `json:"path"`
	Confidence float64        `json:"confidence"`
	MatchType  string         `json:"match_type"` // keyword / semantic
}

// Consult queries the topology for a matching intent + execution path.
// Zero LLM cost — pure in-memory graph traversal.
func Consult(graph *Graph, userMsg string) *Match {
	if graph == nil {
		return nil
	}

	intents := graph.FindIntentNodes()
	if len(intents) == 0 {
		return nil
	}

	msgLower := strings.ToLower(userMsg)

	// Level 1: keyword match (nanosecond)
	for _, node := range intents {
		if keywordHit(msgLower, node.Keywords) {
			path := bestPath(graph, node.ID)
			if pathEligible(path) {
				return &Match{
					Intent:     node,
					Path:       path,
					Confidence: matchConfidence(path),
					MatchType:  "keyword",
				}
			}
		}
	}

	// Level 2: semantic similarity (would need embedding index — future)
	// For now, skip. When embedding index is available:
	// topK := embeddingIndex.Search(userMsg, 3)
	// for _, hit := range topK { ... }

	return nil // no match → caller falls through to LLM reasoning
}

// bestPath selects the highest-quality execution path for an intent.
// Score = successRate × log(useCount + 1)
func bestPath(graph *Graph, intentID string) *ExecutionPath {
	paths := graph.PathsForIntent(intentID)
	if len(paths) == 0 {
		return nil
	}

	sort.Slice(paths, func(i, j int) bool {
		si := paths[i].SuccessRate * math.Log(float64(paths[i].UseCount+1))
		sj := paths[j].SuccessRate * math.Log(float64(paths[j].UseCount+1))
		return si > sj
	})

	return paths[0]
}

// pathEligible allows curated graphs with no telemetry (success_rate=0, use_count=0) to surface hints.
func pathEligible(p *ExecutionPath) bool {
	if p == nil || len(p.Steps) == 0 {
		return false
	}
	if p.UseCount <= 0 && p.SuccessRate <= 0 {
		return true
	}
	return p.SuccessRate >= 0.45
}

func matchConfidence(p *ExecutionPath) float64 {
	if p == nil {
		return 0
	}
	if p.UseCount <= 0 && p.SuccessRate <= 0 {
		return 0.72
	}
	if p.SuccessRate <= 0 {
		return 0.55
	}
	return p.SuccessRate
}

func keywordHit(msgLower string, keywords []string) bool {
	for _, kw := range keywords {
		if strings.Contains(msgLower, strings.ToLower(kw)) {
			return true
		}
	}
	return false
}

// FormatMatchForPrompt renders a topology Consult hit for system prompt injection (Orchestrator).
func FormatMatchForPrompt(m *Match) string {
	return FormatMatchForPromptEnriched(m, nil, nil)
}

// FormatMatchForPromptEnriched adds human-readable tool/skill captions when maps are provided.
// toolHints: MCP tool name → short description; skillHints: skill id → display name.
func FormatMatchForPromptEnriched(m *Match, toolHints map[string]string, skillHints map[string]string) string {
	if m == nil || m.Intent == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("【行为拓扑 · 参考工作流】\n")
	b.WriteString("命中意图：" + m.Intent.Label + "\n")
	if m.Path != nil {
		conf := matchConfidence(m.Path)
		b.WriteString(fmt.Sprintf("路径置信度（估计）：%.0f%%\n", conf*100))
		if m.Path.UseCount > 0 {
			b.WriteString(fmt.Sprintf("历史使用次数：%d\n", m.Path.UseCount))
		}
		b.WriteString("推荐步骤（请结合当前用户句与可用工具灵活执行，不必机械逐步照搬）：\n")
		for _, step := range m.Path.Steps {
			line := formatStepLine(step, toolHints, skillHints)
			b.WriteString("  · " + line + "\n")
		}
	}
	return b.String()
}

func formatStepLine(step ExecStep, toolHints map[string]string, skillHints map[string]string) string {
	action := strings.TrimSpace(step.Action)
	tid := strings.TrimSpace(step.TargetID)
	label := actionHumanLabel(action)
	var detail string
	switch action {
	case "call_skill":
		name := tid
		if skillHints != nil && tid != "" {
			if n, ok := skillHints[tid]; ok && n != "" {
				name = fmt.Sprintf("%s（%s）", n, tid)
			}
		}
		detail = name
	case "call_mcp":
		name := tid
		if toolHints != nil && tid != "" {
			if d, ok := toolHints[tid]; ok && d != "" {
				name = fmt.Sprintf("%s — %s", tid, d)
			}
		}
		detail = name
	default:
		detail = tid
	}
	line := label
	if detail != "" {
		line += " → " + detail
	}
	if step.Condition != "" {
		line += "（条件：" + step.Condition + "）"
	}
	return line
}

func actionHumanLabel(action string) string {
	switch strings.TrimSpace(action) {
	case "call_skill":
		return "技能 SOP"
	case "call_mcp":
		return "MCP 工具"
	case "delegate_sub":
		return "子智能体"
	case "llm_generate":
		return "模型推理"
	default:
		if action == "" {
			return "步骤"
		}
		return action
	}
}
