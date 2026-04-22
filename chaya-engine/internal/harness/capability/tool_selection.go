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

// tokenizeForMatch turns a free-form user message into a set of match tokens
// suitable for substring-matching against tool descriptions.
//
// English / digits: split on non-letter-digit and emit whole words ≥ 2 chars.
// CJK: emit character bigrams (and the whole run up to 4 chars) so queries
//      like "查数据库" match a description mentioning "数据" or "数据库".
// Mixed queries work because both passes run.
func tokenizeForMatch(msg string) []string {
	msg = strings.ToLower(strings.TrimSpace(msg))
	seen := map[string]struct{}{}
	add := func(t string) {
		if len([]rune(t)) < 2 {
			return
		}
		if _, ok := seen[t]; ok {
			return
		}
		seen[t] = struct{}{}
	}

	// Pass 1: latin / digit words.
	var buf []rune
	for _, r := range msg {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			buf = append(buf, r)
		} else {
			buf = append(buf, ' ')
		}
	}
	for _, w := range strings.Fields(string(buf)) {
		add(w)
	}

	// Pass 2: CJK bigrams. Walk runs of Han / Hiragana / Katakana chars and
	// emit every 2-char sliding bigram plus 3- and 4-char prefix forms so
	// common compounds ("数据库", "项目管理") surface as keys.
	runes := []rune(msg)
	var cjk []rune
	flush := func() {
		if len(cjk) < 2 {
			cjk = cjk[:0]
			return
		}
		for i := 0; i+2 <= len(cjk); i++ {
			add(string(cjk[i : i+2]))
		}
		for n := 3; n <= 4; n++ {
			if len(cjk) >= n {
				add(string(cjk[:n]))
				add(string(cjk[len(cjk)-n:]))
			}
		}
		cjk = cjk[:0]
	}
	for _, r := range runes {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) {
			cjk = append(cjk, r)
		} else {
			flush()
		}
	}
	flush()

	// Ordered output keeps selection deterministic for tests.
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	return out
}
