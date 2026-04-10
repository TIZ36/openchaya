package capability

import (
	"strings"
	"testing"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

func TestFilterMCPToolsForPrompt_fallbackAll(t *testing.T) {
	all := []pkg.Tool{
		{Name: "alpha", Description: "does alpha", ServerID: "s1"},
		{Name: "beta", Description: "other", ServerID: "s2"},
	}
	out, maxScore, useAll := FilterMCPToolsForPrompt(all, "hello world", 1, 1)
	if !useAll || maxScore != 0 {
		t.Fatalf("no keyword overlap: useAll=%v maxScore=%d", useAll, maxScore)
	}
	if len(out) != len(all) {
		t.Fatalf("expected all tools, got %d", len(out))
	}
}

func TestFilterMCPToolsForPrompt_perServerQuota(t *testing.T) {
	all := []pkg.Tool{
		{Name: "read_file", Description: "read files from disk", ServerID: "s1"},
		{Name: "write_file", Description: "write files to disk", ServerID: "s1"},
		{Name: "search_web", Description: "search the web", ServerID: "s2"},
	}
	out, _, useAll := FilterMCPToolsForPrompt(all, "read write files on disk and search the web please", 1, 1)
	if useAll {
		t.Fatal("expected filtered subset")
	}
	if len(out) != 2 {
		t.Fatalf("want 2 tools (1 per server), got %d: %+v", len(out), out)
	}
}

func TestFilterMCPToolsForPrompt_lowConfidenceAll(t *testing.T) {
	all := []pkg.Tool{
		{Name: "x", Description: "y", ServerID: "a"},
	}
	out, _, useAll := FilterMCPToolsForPrompt(all, "filesystem read", 4, 5)
	if !useAll || len(out) != 1 {
		t.Fatalf("maxScore below threshold should return all: useAll=%v len=%d", useAll, len(out))
	}
}

func TestFormatMCPToolsPromptSection_budget(t *testing.T) {
	tools := []pkg.Tool{
		{Name: "tool_a", Description: "fits under budget"},
		{Name: "tool_b", Description: strings.Repeat("word ", 400)},
	}
	sec, listed, omitted := FormatMCPToolsPromptSection(tools, 800)
	if listed != 1 || omitted != 1 {
		t.Fatalf("expected one listed one omitted: listed=%d omitted=%d sec_len=%d", listed, omitted, len(sec))
	}
	if !strings.Contains(sec, "tool_a") || strings.Contains(sec, "tool_b") {
		t.Fatalf("expected only first tool in section: %q", sec)
	}
}
