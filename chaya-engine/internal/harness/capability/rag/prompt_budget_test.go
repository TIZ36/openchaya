package rag

import (
	"strings"
	"testing"

	"github.com/chaya-ai/chaya-engine/internal/harness/budget"
)

func TestFormatForPromptBudget_tightBudgetPrefersFirstFitAfterMMR(t *testing.T) {
	results := []SearchResult{
		{KBChunk: KBChunk{Text: strings.Repeat("alpha ", 400), Heading: "h1"}, Score: 0.99},
		{KBChunk: KBChunk{Text: "beta gamma delta epsilon zeta", Heading: "h2"}, Score: 0.5},
	}
	s := FormatForPromptBudget(results, 120)
	if !strings.Contains(s, "【知识库参考资料】") {
		t.Fatal("missing header")
	}
	// Very small budget: at most one chunk body should appear fully
	if budget.EstimateTokens(s) > 250 {
		t.Fatalf("expected small output, est=%d", budget.EstimateTokens(s))
	}
}

func TestJaccardTermSimilarity(t *testing.T) {
	a := jaccardTermSimilarity("hello world foo", "hello world bar")
	b := jaccardTermSimilarity("hello world foo", "completely different text here")
	if a <= b {
		t.Fatalf("overlap a=%v b=%v", a, b)
	}
}
