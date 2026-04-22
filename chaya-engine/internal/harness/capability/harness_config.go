package capability

// HarnessRuntimeConfig holds harness prompt budgets and tool-selection knobs (from YAML / defaults).
type HarnessRuntimeConfig struct {
	PromptToolsTextEstTokens int
	PromptRAGEstTokens       int
	PromptSkillSOPEstTokens  int
	PromptMemoryEstTokens    int
	ToolSelectMaxPerServer   int
	// MinKeywordScore is the minimum best keyword score to trust selection; below this, inject all tools (fallback).
	ToolSelectMinKeywordScore int
	MetricsVerbose            bool
}

// DefaultHarnessRuntimeConfig matches prior behavior: ~20 short tool lines ≈ low thousands of est. tokens.
func DefaultHarnessRuntimeConfig() HarnessRuntimeConfig {
	return HarnessRuntimeConfig{
		PromptToolsTextEstTokens:  2800,
		PromptRAGEstTokens:        3200,
		PromptSkillSOPEstTokens:   6000,
		PromptMemoryEstTokens:     4000,
		// Tight by default: show only the top-few tools per server that actually
		// match the user's query. Model accuracy degrades as the menu grows;
		// with 18+ tools collected it was silently falling back to "all" half
		// the time. Raise the threshold so only genuinely relevant matches get
		// through, and cap per-server count lower.
		ToolSelectMaxPerServer:    4,
		ToolSelectMinKeywordScore: 2,
		MetricsVerbose:            false,
	}
}
