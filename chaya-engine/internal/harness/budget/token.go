package budget

import "unicode/utf8"

// EstimateTokens returns a rough input-token estimate for budgeting (not billing).
// Uses byte-length/4 with a floor; adequate for EN/CN mix in system prompts.
func EstimateTokens(s string) int {
	if s == "" {
		return 0
	}
	n := len(s) / 4
	if n < 1 {
		n = 1
	}
	// Long CJK runs: utf8 count as slightly denser than /4
	if utf8.RuneCountInString(s) > len(s)/2 {
		n = max(n, utf8.RuneCountInString(s)/2)
	}
	return n
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
