package capability

import (
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/harness/budget"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/skill"
)

func truncateTextByEstTokens(s string, maxTok int) string {
	if maxTok <= 0 || strings.TrimSpace(s) == "" {
		return s
	}
	if budget.EstimateTokens(s) <= maxTok {
		return s
	}
	rs := []rune(s)
	lo, hi := 0, len(rs)
	best := 0
	for lo <= hi {
		mid := (lo + hi) / 2
		frag := string(rs[:mid])
		if budget.EstimateTokens(frag) <= maxTok {
			best = mid
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	if best >= len(rs) {
		return s
	}
	return strings.TrimSpace(string(rs[:best])) + "\n...(因预算截断)"
}

// FormatSystemPromptAdditions builds system prompt sections with token budgets and optional MCP keyword filtering.
func (o *Orchestrator) FormatSystemPromptAdditions(ec *EnrichedContext, toolsViaFC bool, userMsg string) string {
	if ec == nil {
		return ""
	}
	cfg := o.harness
	if cfg.PromptToolsTextEstTokens <= 0 {
		cfg = DefaultHarnessRuntimeConfig()
	}

	var additions string

	if !toolsViaFC && len(ec.MCPTools) > 0 {
		tools := ec.MCPTools
		filtered, _, useAll := FilterMCPToolsForPrompt(
			ec.MCPTools,
			userMsg,
			cfg.ToolSelectMaxPerServer,
			cfg.ToolSelectMinKeywordScore,
		)
		if !useAll {
			tools = filtered
		}
		sec, listed, omitted := FormatMCPToolsPromptSection(tools, cfg.PromptToolsTextEstTokens)
		if listed > 0 {
			additions += sec
			_ = omitted
		}
	}

	if ec.Memory != "" {
		mem := ec.Memory
		if cfg.PromptMemoryEstTokens > 0 {
			mem = truncateTextByEstTokens(mem, cfg.PromptMemoryEstTokens)
		}
		additions += "\n\n【记忆】\n" + mem
	}

	if ec.KBContext != "" {
		kb := ec.KBContext
		if cfg.PromptRAGEstTokens > 0 {
			kb = truncateTextByEstTokens(kb, cfg.PromptRAGEstTokens)
		}
		additions += "\n\n" + kb
	}

	if len(ec.SkillCatalog) > 0 {
		cat := skill.FormatCatalog(ec.SkillCatalog)
		if cfg.PromptSkillSOPEstTokens > 0 && budget.EstimateTokens(cat) > cfg.PromptSkillSOPEstTokens/2 {
			cat = truncateTextByEstTokens(cat, cfg.PromptSkillSOPEstTokens/2)
		}
		additions += "\n\n" + cat
	}

	if len(ec.ActiveSkills) > 0 {
		sop := skill.FormatActiveSOP(ec.ActiveSkills)
		if cfg.PromptSkillSOPEstTokens > 0 {
			sop = truncateTextByEstTokens(sop, cfg.PromptSkillSOPEstTokens)
		}
		additions += "\n" + sop
	}

	if ec.TopologyHint != "" {
		additions += "\n\n" + ec.TopologyHint
	}

	return additions
}

// FormatSystemPromptAdditionsLegacy delegates to default budgets (for tests / callers without Orchestrator harness field).
func (ec *EnrichedContext) FormatSystemPromptAdditions(toolsViaFC bool) string {
	orch := &Orchestrator{harness: DefaultHarnessRuntimeConfig()}
	return orch.FormatSystemPromptAdditions(ec, toolsViaFC, "")
}
