package topology

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode"

	"gorm.io/gorm"
)

// TopologyRecord is the DB row for persisted topology.
type TopologyRecord struct {
	ID       string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AgentID  string          `gorm:"type:uuid;uniqueIndex" json:"agent_id"`
	GraphRaw json.RawMessage `gorm:"column:graph;type:jsonb" json:"graph"`
	Version  int             `gorm:"default:1" json:"version"`
	BuiltAt  time.Time       `json:"built_at"`
	Summary  string          `json:"summary,omitempty"`
}

func (TopologyRecord) TableName() string { return "agent_topology" }

// Manager orchestrates the topology lifecycle: Trace → Consolidate → Consult.
type Manager struct {
	db         *gorm.DB
	traceStore *TraceStore
	graph      *Graph
	agentID    string
}

func NewManager(db *gorm.DB, agentID string) *Manager {
	m := &Manager{
		db:         db,
		traceStore: NewTraceStore(db),
		agentID:    agentID,
	}
	m.loadFromDB()
	return m
}

// Consolidate triggers LLM-assisted graph refinement.
// Called periodically (daily cron) or when pending traces exceed threshold.
// The actual LLM call is injected as a function to avoid circular deps.
type LLMConsolidator func(prompt string) (string, error)

func (m *Manager) Consolidate(llmCall LLMConsolidator) error {
	// 1. Load recent traces
	traces, err := m.traceStore.LoadRecent(m.agentID, 7*24*time.Hour)
	if err != nil {
		return err
	}
	if len(traces) == 0 {
		return fmt.Errorf("no recent traces (last 7d) for this agent")
	}

	// 2. Build prompt for LLM
	tracesJSON, _ := json.Marshal(traces)
	graphJSON := m.graph.ToJSON()

	prompt := "你是工作流与智能体能力拓扑分析师。根据交互轨迹，补充「意图节点」和「执行路径」（关联 MCP 工具名、技能 id）。\n\n" +
		"【近 7 天轨迹 JSON】\n" + string(tracesJSON) +
		"\n\n【当前拓扑 JSON】\n" + string(graphJSON) +
		"\n\n只输出一个 JSON 对象，不要 Markdown。字段：\n" +
		"- new_intents: [{\"id\":\"intent_xxx\",\"label\":\"中文短名\",\"keywords\":[\"kw1\",\"kw2\"]}]  id 可选，缺省时用 intent_ + 英文/拼音 slug\n" +
		"- new_paths: [{\"id\":\"path_1\",\"intent_id\":\"意图节点 id\",\"steps\":[{\"order\":1,\"action\":\"call_mcp\",\"target_id\":\"工具名\"}],\"success_rate\":0.65,\"use_count\":0}]\n" +
		"  action 取值: call_skill | call_mcp | delegate_sub | llm_generate；call_skill 的 target_id 为技能 UUID\n" +
		"- new_edges: [{\"from\":\"intent_xxx\",\"to\":\"skill_uuid或mcp节点id\",\"relation\":\"uses\",\"success\":1,\"total\":1}]\n" +
		"merge_suggestions / prune_suggestions 可为 []。\n" +
		"轨迹中 intent_tag=assistant_feedback 表示用户对某条助手回复点赞/点踩（user_feedback: positive/negative，actions[0].target_id 为 messages.id），合并图谱时应作为质量信号加权路径与意图。\n"

	resp, err := llmCall(prompt)
	if err != nil {
		slog.Warn("consolidate LLM failed", "err", err)
		return err
	}

	// 3. Parse and apply suggestions
	jsonStr := ExtractJSONObject(strings.TrimSpace(resp))
	if jsonStr == "" {
		jsonStr = strings.TrimSpace(resp)
	}
	m.applySuggestions(jsonStr)

	// 4. Time decay
	m.graph.ApplyTimeDecay(30 * 24 * time.Hour)

	// 5. Persist
	m.saveToDB()

	slog.Info("topology consolidated", "agent", m.agentID, "traces", len(traces))
	return nil
}

func (m *Manager) applySuggestions(resp string) {
	var suggestions struct {
		NewIntents []struct {
			ID       string   `json:"id"`
			Label    string   `json:"label"`
			Keywords []string `json:"keywords"`
		} `json:"new_intents"`
		NewPaths []struct {
			ID          string     `json:"id"`
			IntentID    string     `json:"intent_id"`
			Steps       []ExecStep `json:"steps"`
			SuccessRate float64    `json:"success_rate"`
			UseCount    int        `json:"use_count"`
		} `json:"new_paths"`
		NewEdges []struct {
			From     string `json:"from"`
			To       string `json:"to"`
			Relation string `json:"relation"`
			Success  int    `json:"success"`
			Total    int    `json:"total"`
		} `json:"new_edges"`
	}
	if err := json.Unmarshal([]byte(resp), &suggestions); err != nil {
		slog.Warn("parse consolidate response", "err", err)
		return
	}

	for _, intent := range suggestions.NewIntents {
		label := strings.TrimSpace(intent.Label)
		if label == "" {
			continue
		}
		id := strings.TrimSpace(intent.ID)
		if id == "" {
			id = "intent_" + slugTopologyID(label)
		} else {
			id = slugTopologyID(id)
			if !strings.HasPrefix(id, "intent_") {
				id = "intent_" + id
			}
		}
		kws := intent.Keywords
		if len(kws) == 0 {
			kws = []string{strings.ToLower(label)}
		}
		m.graph.AddNode(&Node{
			ID:       id,
			Type:     NodeIntent,
			Label:    label,
			Keywords: kws,
		})
	}

	for _, np := range suggestions.NewPaths {
		pid := strings.TrimSpace(np.ID)
		if pid == "" {
			continue
		}
		pid = slugTopologyID(pid)
		iid := strings.TrimSpace(np.IntentID)
		if iid == "" {
			continue
		}
		if m.graph.GetNode(iid) == nil {
			alt := iid
			if !strings.HasPrefix(strings.ToLower(alt), "intent_") {
				alt = "intent_" + slugTopologyID(alt)
			}
			if m.graph.GetNode(alt) != nil {
				iid = alt
			}
		}
		if m.graph.GetNode(iid) == nil {
			slog.Warn("topology path skipped: unknown intent_id", "intent_id", np.IntentID)
			continue
		}
		steps := np.Steps
		if len(steps) == 0 {
			continue
		}
		sr := np.SuccessRate
		if sr <= 0 {
			sr = 0.65
		}
		if sr > 1 {
			sr = 1
		}
		m.graph.AddPath(&ExecutionPath{
			ID:          pid,
			IntentID:    iid,
			Steps:       steps,
			SuccessRate: sr,
			UseCount:    np.UseCount,
		})
	}

	for _, e := range suggestions.NewEdges {
		from := strings.TrimSpace(e.From)
		to := strings.TrimSpace(e.To)
		if from == "" || to == "" {
			continue
		}
		if m.graph.GetNode(from) == nil || m.graph.GetNode(to) == nil {
			continue
		}
		rel := strings.TrimSpace(e.Relation)
		if rel == "" {
			rel = "uses"
		}
		succ, tot := e.Success, e.Total
		if tot <= 0 {
			tot = 1
			succ = 1
		}
		m.graph.AddEdge(&Edge{From: from, To: to, Relation: rel, Success: succ, Total: tot})
	}
}

func slugTopologyID(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	var b strings.Builder
	lastUnderscore := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if r == '_' || r == '-' {
			if !lastUnderscore && b.Len() > 0 {
				b.WriteRune('_')
				lastUnderscore = true
			}
			continue
		}
		if !lastUnderscore && b.Len() > 0 {
			b.WriteRune('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "general"
	}
	return out
}

func (m *Manager) loadFromDB() {
	var record TopologyRecord
	err := m.db.Where("agent_id = ?", m.agentID).First(&record).Error
	if err != nil {
		m.graph = NewGraph()
		return
	}
	m.graph = FromJSON(record.GraphRaw)
}

func (m *Manager) saveToDB() {
	graphJSON := m.graph.ToJSON()
	var record TopologyRecord
	err := m.db.Where("agent_id = ?", m.agentID).First(&record).Error
	if err != nil {
		// Create
		m.db.Create(&TopologyRecord{
			AgentID:  m.agentID,
			GraphRaw: graphJSON,
			Version:  1,
			BuiltAt:  time.Now(),
		})
	} else {
		// Update
		m.db.Model(&record).Updates(map[string]any{
			"graph":   graphJSON,
			"version": record.Version + 1,
			"built_at": time.Now(),
		})
	}
}
