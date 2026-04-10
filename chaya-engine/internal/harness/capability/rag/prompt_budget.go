package rag

import (
	"fmt"
	"strings"
	"unicode"

	"github.com/chaya-ai/chaya-engine/internal/harness/budget"
)

const mmrLambda = 0.55

func chunkBody(sr SearchResult) string {
	var b strings.Builder
	if sr.CtxBefore != "" {
		b.WriteString(sr.CtxBefore)
		b.WriteByte('\n')
	}
	b.WriteString(sr.Text)
	if sr.CtxAfter != "" {
		b.WriteByte('\n')
		b.WriteString(sr.CtxAfter)
	}
	return strings.ToLower(strings.TrimSpace(b.String()))
}

func termSet(s string) map[string]struct{} {
	var runes []rune
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			runes = append(runes, r)
		} else {
			runes = append(runes, ' ')
		}
	}
	parts := strings.Fields(string(runes))
	out := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		if len(p) >= 2 {
			out[p] = struct{}{}
		}
	}
	return out
}

// jaccardTermSimilarity is a cheap proxy for semantic overlap between chunks (no extra embeddings).
func jaccardTermSimilarity(a, b string) float64 {
	A := termSet(a)
	B := termSet(b)
	if len(A) == 0 && len(B) == 0 {
		return 0
	}
	if len(A) == 0 || len(B) == 0 {
		return 0
	}
	inter := 0
	for t := range A {
		if _, ok := B[t]; ok {
			inter++
		}
	}
	union := len(A) + len(B) - inter
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

func maxScoreInResults(results []SearchResult) float64 {
	var m float64
	for _, r := range results {
		if r.Score > m {
			m = r.Score
		}
	}
	return m
}

func mmrOrder(results []SearchResult, lambda float64) []SearchResult {
	if len(results) <= 1 {
		return append([]SearchResult(nil), results...)
	}
	maxS := maxScoreInResults(results)
	if maxS <= 0 {
		maxS = 1
	}
	remaining := append([]SearchResult(nil), results...)
	var order []SearchResult
	for len(remaining) > 0 {
		bestI := 0
		bestMMR := -1.0
		for i, cand := range remaining {
			rel := cand.Score / maxS
			if rel > 1 {
				rel = 1
			}
			maxSim := 0.0
			cb := chunkBody(cand)
			for _, sel := range order {
				sim := jaccardTermSimilarity(cb, chunkBody(sel))
				if sim > maxSim {
					maxSim = sim
				}
			}
			mmr := lambda*rel - (1-lambda)*maxSim
			if mmr > bestMMR {
				bestMMR = mmr
				bestI = i
			}
		}
		sel := remaining[bestI]
		remaining = append(remaining[:bestI], remaining[bestI+1:]...)
		order = append(order, sel)
	}
	return order
}

func formatChunkEntry(idx int, r SearchResult) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("\n[参考%d]", idx))
	if r.Heading != "" {
		b.WriteString(fmt.Sprintf(" (%s)", r.Heading))
	}
	b.WriteString(fmt.Sprintf(" (相关度: %.2f)\n", r.Score))
	if r.CtxBefore != "" {
		b.WriteString(fmt.Sprintf("[前文] %s\n", r.CtxBefore))
	}
	b.WriteString(r.Text + "\n")
	if r.CtxAfter != "" {
		b.WriteString(fmt.Sprintf("[后文] %s\n", r.CtxAfter))
	}
	return b.String()
}

// FormatForPromptBudget applies MMR-style reordering for diversity, then packs chunks until est. token budget.
// If maxEstTokens <= 0, behaves like FormatForPrompt (no MMR packing constraint).
func FormatForPromptBudget(results []SearchResult, maxEstTokens int) string {
	if len(results) == 0 {
		return ""
	}
	if maxEstTokens <= 0 {
		return FormatForPrompt(results)
	}
	header := "【知识库参考资料】\n"
	est := budget.EstimateTokens(header)
	ordered := mmrOrder(results, mmrLambda)
	var b strings.Builder
	b.WriteString(header)
	idx := 1
	for _, r := range ordered {
		block := formatChunkEntry(idx, r)
		add := budget.EstimateTokens(block)
		if est+add > maxEstTokens {
			break
		}
		b.WriteString(block)
		est += add
		idx++
	}
	return b.String()
}
