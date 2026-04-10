package topology

import (
	"strings"
	"testing"
)

func TestPathEligible_coldStart(t *testing.T) {
	p := &ExecutionPath{Steps: []ExecStep{{Order: 1, Action: "llm_generate"}}, SuccessRate: 0, UseCount: 0}
	if !pathEligible(p) {
		t.Fatal("expected cold path eligible")
	}
	if matchConfidence(p) < 0.5 {
		t.Fatalf("expected default confidence, got %v", matchConfidence(p))
	}
}

func TestPathEligible_lowTelemetryRejected(t *testing.T) {
	p := &ExecutionPath{
		Steps:       []ExecStep{{Order: 1, Action: "call_mcp", TargetID: "x"}},
		SuccessRate: 0.2,
		UseCount:    10,
	}
	if pathEligible(p) {
		t.Fatal("expected low success path rejected")
	}
}

func TestFormatMatchForPromptEnriched_mcp(t *testing.T) {
	m := &Match{
		Intent: &Node{Label: "查日志"},
		Path: &ExecutionPath{
			Steps: []ExecStep{{Order: 1, Action: "call_mcp", TargetID: "search_logs"}},
		},
	}
	s := FormatMatchForPromptEnriched(m, map[string]string{"search_logs": "检索日志"}, nil)
	if s == "" || !strings.Contains(s, "search_logs") {
		t.Fatalf("unexpected: %q", s)
	}
}
