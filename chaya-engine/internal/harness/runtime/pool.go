package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/chaya-ai/chaya-engine/internal/gateway"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// ActorPool manages one Supervisor per user.
type ActorPool struct {
	hub         *gateway.Hub
	registry    *provider.Registry
	db          *gorm.DB
	rdb         *redis.Client
	orch        *capability.Orchestrator
	supervisors map[string]*Supervisor // userID → supervisor
	mu          sync.RWMutex
}

func NewActorPool(hub *gateway.Hub, registry *provider.Registry, db *gorm.DB, orch *capability.Orchestrator, rdb *redis.Client) *ActorPool {
	return &ActorPool{
		hub:         hub,
		registry:    registry,
		db:          db,
		rdb:         rdb,
		orch:        orch,
		supervisors: make(map[string]*Supervisor),
	}
}

// GetOrCreate returns the PrimaryAgent's mailbox for a user, creating the full
// Supervisor + PrimaryAgent stack if needed.
// PrimaryAgentIDForUser returns the primary agent row id for the user (for WS UX / logs).
func PrimaryAgentIDForUser(db *gorm.DB, userID string) string {
	if db == nil || userID == "" {
		return ""
	}
	var id string
	if err := db.Table("agents").
		Where("user_id = ? AND is_primary = true", userID).
		Select("id").
		Limit(1).
		Scan(&id).Error; err != nil || id == "" {
		return ""
	}
	return id
}

func (p *ActorPool) GetOrCreate(userID, convID string) (*PrimaryActor, error) {
	p.mu.RLock()
	if sv, ok := p.supervisors[userID]; ok {
		p.mu.RUnlock()
		return sv.primary, nil
	}
	p.mu.RUnlock()

	// Load PrimaryAgent config from DB
	agentCfg, agentID, err := p.loadPrimaryAgent(userID)
	if err != nil {
		return nil, err
	}

	// Get LLM provider (prefer agent's llm_config_id)
	llm, err := p.resolveProviderForConfig(agentCfg)
	if err != nil {
		return nil, fmt.Errorf("no LLM provider: %w", err)
	}

	// Create Supervisor + PrimaryAgent
	sv := NewSupervisor(context.Background(), userID, p.hub, p.registry, p.db, p.orch, p.rdb)
	primary := sv.StartPrimary(agentID, agentCfg, llm)

	p.mu.Lock()
	// Double-check
	if existing, ok := p.supervisors[userID]; ok {
		p.mu.Unlock()
		sv.Shutdown()
		return existing.primary, nil
	}
	p.supervisors[userID] = sv
	p.mu.Unlock()

	slog.Info("supervisor+primary created", "user", userID, "agent", agentID)
	return primary, nil
}

// InvalidateConvHistory clears any live actor's cached history for this conv so
// the next turn re-hydrates from the (truncated) DB. No-op if the user has no
// live supervisor. Satisfies api.HistoryInvalidator.
func (p *ActorPool) InvalidateConvHistory(userID, convID string) {
	p.mu.RLock()
	sv, ok := p.supervisors[userID]
	p.mu.RUnlock()
	if ok && sv != nil {
		sv.InvalidateConvHistory(convID)
	}
}

// SendToUser dispatches an envelope to the targeted agent or PrimaryAgent.
func (p *ActorPool) SendToUser(userID string, env *envelope.Envelope) error {
	// Generic (non-primary) agents bound to a conversation get their own mailbox + config.
	if env.Type == envelope.TypeChat && env.ConvID != "" {
		if agentID, isPrimary, ok := p.lookupChatAgent(userID, env.ConvID); ok && !isPrimary && agentID != "" {
			if _, err := p.GetOrCreate(userID, env.ConvID); err != nil {
				return err
			}
			p.mu.RLock()
			sv := p.supervisors[userID]
			p.mu.RUnlock()
			if sv != nil {
				if actor, err := sv.EnsureGenericChatActor(agentID); err == nil {
					actor.Mailbox <- env
					return nil
				} else {
					slog.Warn("generic chat actor unavailable, using primary", "user", userID, "agent", agentID, "err", err)
				}
			}
		}
	}

	p.mu.RLock()
	sv, ok := p.supervisors[userID]
	p.mu.RUnlock()

	if ok && env.To != "" {
		if actor, ok := sv.GetActorByAgentID(env.To); ok {
			actor.Mailbox <- env
			return nil
		}
	}

	primary, err := p.GetOrCreate(userID, env.ConvID)
	if err != nil {
		return err
	}
	primary.Mailbox <- env
	return nil
}

// lookupChatAgent returns the agent row bound to this conversation (prefers non-primary).
func (p *ActorPool) lookupChatAgent(userID, convID string) (agentID string, isPrimary bool, ok bool) {
	if p.db == nil || convID == "" || userID == "" {
		return "", false, false
	}
	type row struct {
		ID        string `gorm:"column:id"`
		IsPrimary bool   `gorm:"column:is_primary"`
	}
	var rows []row
	err := p.db.Table("agents AS ag").
		Select("ag.id, ag.is_primary").
		Joins("JOIN conversation_agents ca ON ca.agent_id = ag.id").
		Where("ca.conversation_id = ? AND ag.user_id = ?", convID, userID).
		Order("ag.is_primary ASC").
		Limit(1).
		Find(&rows).Error
	if err != nil || len(rows) == 0 {
		return "", false, false
	}
	return rows[0].ID, rows[0].IsPrimary, true
}

func (p *ActorPool) loadPrimaryAgent(userID string) (ActorConfig, string, error) {
	type row struct {
		ID     string          `gorm:"column:id"`
		Config json.RawMessage `gorm:"column:config"`
	}

	var r row
	err := p.db.Table("agents").
		Where("user_id = ? AND is_primary = true", userID).
		Select("id, config").First(&r).Error

	if err == gorm.ErrRecordNotFound {
		return p.createDefaultPrimaryAgent(userID)
	}
	if err != nil {
		return ActorConfig{}, "", fmt.Errorf("load agent: %w", err)
	}

	var cfg ActorConfig
	json.Unmarshal(r.Config, &cfg)
	if cfg.SystemPrompt == "" {
		cfg.SystemPrompt = defaultSystemPrompt
	}
	p.fillModelFromLLMConfig(&cfg)
	return cfg, r.ID, nil
}

func (p *ActorPool) createDefaultPrimaryAgent(userID string) (ActorConfig, string, error) {
	cfg := ActorConfig{SystemPrompt: defaultSystemPrompt}
	cfgJSON, _ := json.Marshal(cfg)

	result := p.db.Exec(
		`INSERT INTO agents (user_id, type, name, config, is_primary) VALUES (?, 'primary', 'chaya', ?, true)`,
		userID, string(cfgJSON),
	)
	if result.Error != nil {
		return cfg, "", result.Error
	}

	var id string
	p.db.Table("agents").Where("user_id = ? AND is_primary = true", userID).Pluck("id", &id)
	return cfg, id, nil
}

func (p *ActorPool) resolveProvider() (provider.LLMProvider, error) {
	llm, _, err := p.registry.GetAny()
	return llm, err
}

func (p *ActorPool) resolveProviderForConfig(cfg ActorConfig) (provider.LLMProvider, error) {
	if cfg.LLMConfigID != "" {
		if llm, err := p.registry.Get(cfg.LLMConfigID); err == nil {
			return llm, nil
		}
	}
	return p.resolveProvider()
}

func (p *ActorPool) fillModelFromLLMConfig(cfg *ActorConfig) {
	if cfg == nil || cfg.LLMConfigID == "" {
		return
	}
	var row provider.LLMConfigRow
	if p.db.Where("id = ? AND enabled = true", cfg.LLMConfigID).First(&row).Error == nil {
		cfg.Model = row.Model
	}
}

const defaultSystemPrompt = `You are Chaya, a friendly and capable AI assistant. You help users with various tasks including answering questions, analyzing documents, using tools when needed, and generating creative content. Be concise, helpful, and proactive.`
