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
		ToolSelectMaxPerServer:    8,
		ToolSelectMinKeywordScore: 1,
		MetricsVerbose:            false,
	}
}
