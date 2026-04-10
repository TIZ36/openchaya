package runtime

import (
	"encoding/json"
	"testing"

	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

func TestResolveHarnessRoutePhaseA_capability(t *testing.T) {
	env := &envelope.Envelope{Body: "帮我增加一个 MCP 服务器绑定"}
	ph := ResolveHarnessRoutePhaseA(env)
	if ph.Kind != HarnessRouteCapabilitySingle {
		t.Fatalf("got %s", ph.Kind)
	}
}

func TestResolveHarnessRoutePhaseA_linkFast(t *testing.T) {
	env := &envelope.Envelope{Body: "读一下这个飞书文档的内容 https://x.com/a"}
	ph := ResolveHarnessRoutePhaseA(env)
	if ph.Kind != HarnessRouteLinkFast {
		t.Fatalf("got %s", ph.Kind)
	}
}

func TestResolveHarnessRoutePhaseA_precise(t *testing.T) {
	data, _ := json.Marshal(map[string]string{"response_mode": "precise"})
	env := &envelope.Envelope{Body: "任意较长内容用于测试精准模式路由分支", Data: data}
	ph := ResolveHarnessRoutePhaseA(env)
	if ph.Kind != HarnessRoutePreciseClassify {
		t.Fatalf("got %s", ph.Kind)
	}
}

func TestResolveHarnessRoutePhaseA_shortDirect(t *testing.T) {
	env := &envelope.Envelope{Body: "hi"}
	ph := ResolveHarnessRoutePhaseA(env)
	if ph.Kind != HarnessRouteDirectChat {
		t.Fatalf("got %s", ph.Kind)
	}
}

func TestDedupeDelegationTasks(t *testing.T) {
	specs := []delegationTaskSpec{
		{ID: "a", Task: " same ", ExpectedResult: " x "},
		{ID: "b", Task: "same", ExpectedResult: "x"},
		{ID: "c", Task: "other", ExpectedResult: "y"},
	}
	out := DedupeDelegationTasks(specs)
	if len(out) != 2 {
		t.Fatalf("want 2 unique, got %d", len(out))
	}
}
