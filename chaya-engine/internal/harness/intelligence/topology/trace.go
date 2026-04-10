package topology

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// InteractionTrace records a single completed interaction for topology learning.
type InteractionTrace struct {
	ID           string        `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AgentID      string        `gorm:"type:uuid;index" json:"agent_id"`
	UserInput    string        `json:"user_input"`
	IntentTag    string        `json:"intent_tag"`
	Actions      json.RawMessage `gorm:"type:jsonb" json:"actions"` // []TraceAction
	Success      bool          `json:"success"`
	DurationMS   int64         `json:"duration_ms"`
	UserFeedback string        `json:"user_feedback"` // positive / negative / neutral
	CreatedAt    time.Time     `json:"created_at"`
}

func (InteractionTrace) TableName() string { return "agent_traces" }

// TraceAction represents one action taken during an interaction.
type TraceAction struct {
	Order      int    `json:"order"`
	Type       string `json:"type"`       // skill / mcp / delegate / llm
	TargetID   string `json:"target_id"`
	Success    bool   `json:"success"`
	DurationMS int64  `json:"duration_ms"`
}

// TraceStore handles trace persistence.
type TraceStore struct {
	db *gorm.DB
}

func NewTraceStore(db *gorm.DB) *TraceStore {
	return &TraceStore{db: db}
}

// Save persists a trace.
func (s *TraceStore) Save(trace *InteractionTrace) error {
	return s.db.Create(trace).Error
}

// LoadRecent loads traces from the last N days for an agent.
func (s *TraceStore) LoadRecent(agentID string, since time.Duration) ([]InteractionTrace, error) {
	var traces []InteractionTrace
	cutoff := time.Now().Add(-since)
	err := s.db.Where("agent_id = ? AND created_at > ?", agentID, cutoff).
		Order("created_at desc").
		Find(&traces).Error
	return traces, err
}
