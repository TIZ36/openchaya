package mcp

import (
	"strings"
	"testing"
)

func TestParseJSONRPCResult_SingleJSON(t *testing.T) {
	body := []byte(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
	res, err := parseJSONRPCResult("application/json", body, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res), `"tools"`) {
		t.Fatalf("unexpected result: %s", res)
	}
}

func TestParseJSONRPCResult_SSE(t *testing.T) {
	body := []byte("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"x\":1}}\n\n")
	res, err := parseJSONRPCResult("text/event-stream", body, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res), `"x"`) {
		t.Fatalf("unexpected result: %s", res)
	}
}

func TestResolveMCPConnectURL_NoEnv(t *testing.T) {
	const u = "http://localhost:18060/mcp"
	if got := ResolveMCPConnectURL(u); got != u {
		t.Fatalf("expected unchanged, got %q", got)
	}
}

func TestResolveMCPConnectURL_WithEnv(t *testing.T) {
	t.Setenv("CHAYA_MCP_LOCALHOST_REWRITE", "host.docker.internal")
	got := ResolveMCPConnectURL("http://localhost:18060/mcp")
	want := "http://host.docker.internal:18060/mcp"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
