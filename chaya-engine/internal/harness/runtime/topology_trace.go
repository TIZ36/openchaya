package runtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence/topology"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
)

func (p *PrimaryActor) recordTopologyTurn(ctx context.Context, env *envelope.Envelope, result string, delegated bool) {
	_ = ctx
	if p.DB == nil || !topologyEnabledFromExt(p.Config.Ext) || strings.TrimSpace(p.AgentID) == "" {
		return
	}
	logs := finishExecutionTrace(env.ConvID)

	p.topoMatchMu.Lock()
	intentTag := p.lastTopologyIntentLabel
	p.topoMatchMu.Unlock()

	actions := buildTraceActionsFromLogs(logs, delegated, result)
	raw, err := json.Marshal(actions)
	if err != nil || len(raw) == 0 {
		raw = []byte("[]")
	}
	dur := int64(0)
	if len(logs) >= 2 {
		dur = logs[len(logs)-1].Timestamp - logs[0].Timestamp
	}
	tr := &topology.InteractionTrace{
		AgentID:    p.AgentID,
		UserInput:  env.Body,
		IntentTag:  intentTag,
		Actions:    raw,
		Success:    strings.TrimSpace(result) != "",
		DurationMS: dur,
	}
	if err := topology.NewTraceStore(p.DB).Save(tr); err != nil {
		slog.Warn("topology trace persist", "err", err)
	}
}

func buildTraceActionsFromLogs(logs []ExecutionLogEntry, delegated bool, result string) []topology.TraceAction {
	var actions []topology.TraceAction
	n := 1
	ok := strings.TrimSpace(result) != ""
	if delegated {
		actions = append(actions, topology.TraceAction{Order: n, Type: "delegate", TargetID: "sub_agents", Success: ok})
		n++
	}
	for _, log := range logs {
		msg := strings.ToLower(log.Message + " " + log.Detail)
		typ := strings.ToLower(log.Type)
		if strings.Contains(msg, "子任务") || strings.Contains(msg, "sub-agent") || strings.Contains(msg, "delegat") {
			actions = append(actions, topology.TraceAction{Order: n, Type: "delegate", Success: typ != "error"})
			n++
			continue
		}
		if strings.Contains(msg, "mcp") || strings.Contains(msg, "工具已") || strings.Contains(msg, "工具能力") {
			actions = append(actions, topology.TraceAction{Order: n, Type: "mcp", Success: typ != "error"})
			n++
		}
	}
	if len(actions) == 0 {
		actions = []topology.TraceAction{{Order: 1, Type: "llm", Success: ok}}
	}
	return actions
}
