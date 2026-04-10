package budget

import "testing"

func TestEstimateTokens(t *testing.T) {
	if n := EstimateTokens(""); n != 0 {
		t.Fatalf("empty: got %d", n)
	}
	if n := EstimateTokens("ab"); n < 1 {
		t.Fatalf("short: got %d", n)
	}
	// CJK-heavy string should be denser than byte/4 alone
	cjk := "这是一段用于测试的中文内容用来拉长字符串长度"
	n := EstimateTokens(cjk)
	if n < len(cjk)/8 {
		t.Fatalf("cjk estimate too small: %d for len %d", n, len(cjk))
	}
}
