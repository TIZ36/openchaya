// Package envelope defines the three-layer internal communication protocol
// between actors. Control and logic layers are zero-token (no LLM).
// Semantic layer uses natural language (costs tokens but unavoidable).
package envelope

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Type classifies messages into control, logic, or semantic layer.
type Type string

const (
	// ── Control layer (structured, zero LLM cost) ──
	TypePing      Type = "ping"
	TypePong      Type = "pong"
	TypeInterrupt Type = "interrupt"
	TypePark      Type = "park"
	TypeResume    Type = "resume"
	TypeStatus    Type = "status"

	// ── Logic layer (structured Data, zero LLM cost) ──
	TypeToolCall   Type = "tool_call"
	TypeToolResult Type = "tool_result"
	TypeRAGQuery   Type = "rag_query"
	TypeRAGResult  Type = "rag_result"
	TypeMemRead    Type = "mem_read"
	TypeMemWrite   Type = "mem_write"

	// ── Semantic layer (natural language Body, costs tokens) ──
	TypeChat     Type = "chat"     // user → agent conversation
	TypeTask     Type = "task"     // PrimaryAgent → SubAgent delegation
	TypeResult   Type = "result"   // SubAgent → PrimaryAgent result
	TypeQuestion Type = "question" // SubAgent needs clarification
	TypeNotify   Type = "notify"   // offline notification
)

// Envelope is the universal message format for all actor communication.
type Envelope struct {
	ID        string          `json:"id"`
	From      string          `json:"from"`
	To        string          `json:"to"`
	Type      Type            `json:"type"`
	Priority  int             `json:"priority"` // 0=normal, 1=high, 2=urgent
	ReplyTo   string          `json:"reply_to,omitempty"`
	ConvID    string          `json:"conv_id,omitempty"`
	Timestamp time.Time       `json:"timestamp"`

	// Logic layer: structured data, parsed by code, zero tokens
	Data json.RawMessage `json:"data,omitempty"`

	// Semantic layer: natural language, consumed by LLM
	Body string `json:"body,omitempty"`
}

// New creates an envelope with a fresh ID and timestamp.
func New(typ Type, from, to string) *Envelope {
	return &Envelope{
		ID:        uuid.New().String(),
		Type:      typ,
		From:      from,
		To:        to,
		Timestamp: time.Now(),
	}
}

// Chat creates a chat envelope (user → agent).
func Chat(from, convID, content string) *Envelope {
	e := New(TypeChat, from, "")
	e.ConvID = convID
	e.Body = content
	return e
}

// Task creates a delegation envelope (PrimaryAgent → SubAgent).
func Task(from, to, convID, body string) *Envelope {
	e := New(TypeTask, from, to)
	e.ConvID = convID
	e.Body = body
	return e
}

// Result creates a result envelope (SubAgent → PrimaryAgent).
func Result(from, to, replyTo, body string) *Envelope {
	e := New(TypeResult, from, to)
	e.ReplyTo = replyTo
	e.Body = body
	return e
}

// WithData attaches structured data to the envelope.
func (e *Envelope) WithData(v any) *Envelope {
	e.Data, _ = json.Marshal(v)
	return e
}

// IsControl returns true if the envelope is a control-layer message.
func (e *Envelope) IsControl() bool {
	switch e.Type {
	case TypePing, TypePong, TypeInterrupt, TypePark, TypeResume, TypeStatus:
		return true
	}
	return false
}

// IsLogic returns true if the envelope is a logic-layer message.
func (e *Envelope) IsLogic() bool {
	switch e.Type {
	case TypeToolCall, TypeToolResult, TypeRAGQuery, TypeRAGResult, TypeMemRead, TypeMemWrite:
		return true
	}
	return false
}

// IsSemantic returns true if the envelope is a semantic-layer message (costs tokens).
func (e *Envelope) IsSemantic() bool {
	return !e.IsControl() && !e.IsLogic()
}
