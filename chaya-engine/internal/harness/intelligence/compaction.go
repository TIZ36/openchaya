package intelligence

import (
	"context"
	"fmt"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/provider"
)

// CompactHistory compresses old messages into a summary when context exceeds budget.
// Keeps the most recent `keepRecent` messages intact, summarizes the rest.
func CompactHistory(
	ctx context.Context,
	llm provider.LLMProvider,
	history []provider.Message,
	maxTokens int,
	keepRecent int,
) []provider.Message {
	if len(history) <= keepRecent {
		return history
	}

	// Rough token estimate: 1 char ≈ 0.4 tokens (Chinese), 0.25 tokens (English)
	totalChars := 0
	for _, m := range history {
		totalChars += len(m.Content)
	}
	estimatedTokens := totalChars * 4 / 10 // rough estimate
	if estimatedTokens < maxTokens {
		return history // no compaction needed
	}

	// Split into old + recent
	cutoff := len(history) - keepRecent
	old := history[:cutoff]
	recent := history[cutoff:]

	// Summarize old messages
	var summaryParts []string
	for _, m := range old {
		if m.Role == "system" {
			continue // don't summarize system prompt
		}
		prefix := "用户"
		if m.Role == "assistant" {
			prefix = "助手"
		}
		summaryParts = append(summaryParts, fmt.Sprintf("%s: %s", prefix, truncate(m.Content, 200)))
	}

	summaryPrompt := "请用 3-5 句话总结以下对话要点，保留关键信息：\n\n" +
		strings.Join(summaryParts, "\n")

	summary, err := llm.Chat(ctx, provider.ChatRequest{
		Messages: []provider.Message{
			{Role: "user", Content: summaryPrompt},
		},
	})
	if err != nil {
		// Fallback: just truncate
		return recent
	}

	// Build compacted history: system + summary + recent
	var compacted []provider.Message
	for _, m := range history {
		if m.Role == "system" {
			compacted = append(compacted, m)
			break
		}
	}
	compacted = append(compacted, provider.Message{
		Role:    "assistant",
		Content: "[对话历史摘要]\n" + summary.Content,
	})
	compacted = append(compacted, recent...)

	return compacted
}

func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen]) + "..."
}
