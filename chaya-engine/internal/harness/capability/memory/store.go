package memory

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// MaxMemoryChars is the default capacity limit per agent.
	MaxMemoryChars = 64 * 1024 // 64K chars ≈ 128K/2
)

// Type distinguishes memory kinds.
type Type string

const (
	TypeStatement Type = "statement" // agent's observation/output stored as memory
	TypeQA        Type = "qa"        // user question + agent answer pair
)

// Entry is a single memory item.
type Entry struct {
	ID        string    `json:"id"`
	AgentID   string    `json:"agent_id"`
	Type      Type      `json:"type"`
	Content   string    `json:"content"`   // for statement: the text. for QA: "Q: ...\nA: ..."
	CreatedAt time.Time `json:"created_at"`
	CharLen   int       `json:"char_len"`
}

// Store manages agent memory in Redis with LRU eviction by time.
type Store struct {
	rdb      *redis.Client
	maxChars int
}

func NewStore(rdb *redis.Client) *Store {
	return &Store{rdb: rdb, maxChars: MaxMemoryChars}
}

func (s *Store) key(agentID string) string {
	return fmt.Sprintf("memory:%s", agentID)
}

// Add appends a memory entry and evicts oldest if over capacity.
func (s *Store) Add(ctx context.Context, agentID string, typ Type, content string) error {
	if s.rdb == nil {
		return nil
	}

	entry := Entry{
		ID:        fmt.Sprintf("%d", time.Now().UnixNano()),
		AgentID:   agentID,
		Type:      typ,
		Content:   content,
		CreatedAt: time.Now(),
		CharLen:   len(content),
	}

	data, _ := json.Marshal(entry)

	// ZADD with timestamp as score (for LRU eviction)
	s.rdb.ZAdd(ctx, s.key(agentID), redis.Z{
		Score:  float64(entry.CreatedAt.UnixNano()),
		Member: string(data),
	})

	// Evict oldest if over capacity
	return s.evict(ctx, agentID)
}

// Load returns all memory entries for an agent (full injection into context).
func (s *Store) Load(ctx context.Context, agentID string) []Entry {
	if s.rdb == nil {
		return nil
	}

	members, err := s.rdb.ZRange(ctx, s.key(agentID), 0, -1).Result()
	if err != nil {
		slog.Warn("memory load failed", "agent", agentID, "err", err)
		return nil
	}

	entries := make([]Entry, 0, len(members))
	for _, m := range members {
		var e Entry
		if json.Unmarshal([]byte(m), &e) == nil {
			entries = append(entries, e)
		}
	}
	return entries
}

// FormatForContext formats all memories as a string for system prompt injection.
func (s *Store) FormatForContext(ctx context.Context, agentID string) string {
	entries := s.Load(ctx, agentID)
	if len(entries) == 0 {
		return ""
	}

	var result string
	for _, e := range entries {
		switch e.Type {
		case TypeStatement:
			result += fmt.Sprintf("[Memory] %s\n", e.Content)
		case TypeQA:
			result += fmt.Sprintf("[Memory Q&A] %s\n", e.Content)
		}
	}
	return result
}

// TotalChars returns the total character count of all memories for an agent.
func (s *Store) TotalChars(ctx context.Context, agentID string) int {
	entries := s.Load(ctx, agentID)
	total := 0
	for _, e := range entries {
		total += e.CharLen
	}
	return total
}

// evict removes oldest entries until total chars is under maxChars.
func (s *Store) evict(ctx context.Context, agentID string) error {
	for {
		total := s.TotalChars(ctx, agentID)
		if total <= s.maxChars {
			return nil
		}

		// Remove oldest (lowest score)
		removed, err := s.rdb.ZPopMin(ctx, s.key(agentID), 1).Result()
		if err != nil || len(removed) == 0 {
			return err
		}

		slog.Info("memory evicted", "agent", agentID, "total_chars", total, "max", s.maxChars)
	}
}

// Clear removes all memory for an agent.
func (s *Store) Clear(ctx context.Context, agentID string) error {
	if s.rdb == nil {
		return nil
	}
	return s.rdb.Del(ctx, s.key(agentID)).Err()
}
