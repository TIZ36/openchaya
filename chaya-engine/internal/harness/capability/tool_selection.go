package capability

import (
	"fmt"
	"strings"
	"unicode"

	pkg "github.com/chaya-ai/chaya-engine/pkg"

	"github.com/chaya-ai/chaya-engine/internal/harness/budget"
)

// FilterMCPToolsForPrompt narrows tools using keyword overlap + per-server quota.
// If maxScore < minScoreThreshold, returns all tools (caller should not filter).
func FilterMCPToolsForPrompt(all []pkg.Tool, userMsg string, maxPerServer int, minScoreThreshold int) (filtered []pkg.Tool, maxScore int, useAll bool) {
	if len(all) == 0 {
		return nil, 0, false
	}
	terms := tokenizeForMatch(userMsg)
	if len(terms) == 0 {
		return all, 0, true
	}

	type scored struct {
		t     pkg.Tool
		score int
	}
	list := make([]scored, 0, len(all))
	for _, t := range all {
		hay := strings.ToLower(t.Name + " " + t.Description)
		s := 0
		for _, term := range terms {
			if len(term) < 2 {
				continue
			}
			if strings.Contains(hay, term) {
				s++
			}
		}
		if s > maxScore {
			maxScore = s
		}
		list = append(list, scored{t: t, score: s})
	}
	if maxScore < minScoreThreshold {
		return all, maxScore, true
	}

	for i := 0; i < len(list); i++ {
		for j := i + 1; j < len(list); j++ {
			if list[j].score > list[i].score ||
				(list[j].score == list[i].score && list[j].t.Name < list[i].t.Name) {
				list[i], list[j] = list[j], list[i]
			}
		}
	}

	perServer := map[string]int{}
	for _, sc := range list {
		if sc.score == 0 {
			continue
		}
		sid := strings.TrimSpace(sc.t.ServerID)
		if maxPerServer > 0 && sid != "" && perServer[sid] >= maxPerServer {
			continue
		}
		filtered = append(filtered, sc.t)
		if maxPerServer > 0 && sid != "" {
			perServer[sid]++
		}
	}
	if len(filtered) == 0 {
		return all, maxScore, true
	}
	return filtered, maxScore, false
}

// FormatMCPToolsPromptSection builds the 【可用工具】 block, truncating by estimated token budget.
func FormatMCPToolsPromptSection(tools []pkg.Tool, maxEstTokens int) (section string, listed int, omitted int) {
	if len(tools) == 0 {
		return "", 0, 0
	}
	header := "\n\n【可用工具】\n你具备以下工具能力（由 MCP 服务提供）：\n"
	est := budget.EstimateTokens(header)
	var b strings.Builder
	b.WriteString(header)
	listed = 0
	for _, t := range tools {
		line := fmt.Sprintf("- %s：%s\n", t.Name, t.Description)
		add := budget.EstimateTokens(line)
		if maxEstTokens > 0 && est+add > maxEstTokens {
			omitted = len(tools) - listed
			break
		}
		est += add
		b.WriteString(line)
		listed++
	}
	omitted = len(tools) - listed
	if omitted > 0 {
		b.WriteString(fmt.Sprintf("（还有 %d 个工具因预算未列出）\n", omitted))
	}
	return b.String(), listed, omitted
}

func tokenizeForMatch(msg string) []string {
	msg = strings.ToLower(strings.TrimSpace(msg))
	var runes []rune
	for _, r := range msg {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			runes = append(runes, r)
		} else {
			runes = append(runes, ' ')
		}
	}
	parts := strings.Fields(string(runes))
	seen := map[string]struct{}{}
	var out []string
	for _, p := range parts {
		if len(p) < 2 {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}
