package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

const (
	maxRestarts    = 5
	idleTimeout    = 5 * time.Minute
	reaperInterval = 1 * time.Minute
)

// ActorHandle wraps a running actor with lifecycle metadata.
type ActorHandle struct {
	actor      *Actor
	ctx        context.Context
	cancel     context.CancelFunc
	lastAccess time.Time
	restarts   int
	agentType  string // "general", "translator", etc.
}

// genericAgentHandle is a long-lived mailbox worker for a user-created (generic) agent.
type genericAgentHandle struct {
	actor      *Actor
	ctx        context.Context
	cancel     context.CancelFunc
	lastAccess time.Time
}

// Supervisor manages all actors for a single user.
// PrimaryAgent is always-alive. SubActors are created on demand.
type Supervisor struct {
	userID         string
	primaryAgentID string // real agent UUID from agents table
	primary        *PrimaryActor
	subActors      map[string]*ActorHandle // agentType → handle
	genericAgents  map[string]*genericAgentHandle
	mu             sync.RWMutex
	ctx            context.Context
	cancel         context.CancelFunc

	// Dependencies
	hub       *gateway.Hub
	registry  *provider.Registry
	db        *gorm.DB
	orch      *capability.Orchestrator
	tempStore *TempAgStore

	// Result routing: taskID → channel
	pendingResults map[string]chan string
	resultMu       sync.Mutex
}

func (s *Supervisor) GetActorByAgentID(agentID string) (*Actor, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.primaryAgentID == agentID {
		return s.primary.Actor, true
	}
	for _, h := range s.subActors {
		if h.actor.AgentID == agentID {
			return h.actor, true
		}
	}
	for _, h := range s.genericAgents {
		if h.actor.AgentID == agentID {
			return h.actor, true
		}
	}
	return nil, false
}

func NewSupervisor(ctx context.Context, userID string, hub *gateway.Hub, registry *provider.Registry, db *gorm.DB, orch *capability.Orchestrator, rdb *redis.Client) *Supervisor {
	sCtx, sCancel := context.WithCancel(ctx)
	return &Supervisor{
		userID:         userID,
		subActors:      make(map[string]*ActorHandle),
		genericAgents:  make(map[string]*genericAgentHandle),
		ctx:            sCtx,
		cancel:         sCancel,
		hub:            hub,
		registry:       registry,
		db:             db,
		orch:           orch,
		tempStore:      NewTempAgStore(rdb),
		pendingResults: make(map[string]chan string),
	}
}

type SubActorLease struct {
	Actor   *Actor
	Reused  bool
	Created bool
}

// StartPrimary creates and starts the PrimaryAgent.
func (s *Supervisor) StartPrimary(agentID string, cfg ActorConfig, llm provider.LLMProvider) *PrimaryActor {
	s.primaryAgentID = agentID
	base := newBaseActor(
		fmt.Sprintf("primary_%s", s.userID),
		agentID, s.userID, cfg, llm, s.hub, s.db, s.orch, s.registry,
	)
	p := NewPrimaryActor(base, s)
	s.primary = p

	go s.monitorPrimary()
	go p.Run(s.ctx)
	go s.reaper()

	slog.Info("supervisor started", "user", s.userID, "primary", agentID)
	return p
}

// EnsureSubActor gets or creates a SubActor by type.
func (s *Supervisor) EnsureSubActor(agentType string, cfg ActorConfig) (*Actor, error) {
	lease, err := s.EnsureSubActorLease(agentType, cfg)
	if err != nil {
		return nil, err
	}
	return lease.Actor, nil
}

func (s *Supervisor) EnsureSubActorLease(agentType string, cfg ActorConfig) (*SubActorLease, error) {
	s.mu.RLock()
	if h, ok := s.subActors[agentType]; ok {
		h.lastAccess = time.Now()
		s.mu.RUnlock()
		return &SubActorLease{Actor: h.actor, Reused: true}, nil
	}
	s.mu.RUnlock()

	// Get a provider
	llm, err := s.resolveProvider()
	if err != nil {
		return nil, err
	}

	base := newBaseActor(
		fmt.Sprintf("sub_%s_%s", agentType, s.userID),
		s.primaryAgentID, s.userID, cfg, llm, s.hub, s.db, s.orch, s.registry,
	)
	sub := NewSubActor(base, s)

	actorCtx, actorCancel := context.WithCancel(s.ctx)
	handle := &ActorHandle{
		actor:      base,
		ctx:        actorCtx,
		cancel:     actorCancel,
		lastAccess: time.Now(),
		agentType:  agentType,
	}

	s.mu.Lock()
	// Double-check
	if h, ok := s.subActors[agentType]; ok {
		s.mu.Unlock()
		actorCancel()
		return &SubActorLease{Actor: h.actor, Reused: true}, nil
	}
	s.subActors[agentType] = handle
	s.mu.Unlock()

	go s.monitorSub(handle, sub)
	go sub.Run(actorCtx)

	slog.Info("sub actor created", "type", agentType, "user", s.userID)
	return &SubActorLease{Actor: base, Created: true}, nil
}

// EnsureGenericChatActor returns a running mailbox worker for a generic (non-primary) agent row.
func (s *Supervisor) EnsureGenericChatActor(agentID string) (*Actor, error) {
	s.mu.Lock()
	if h, ok := s.genericAgents[agentID]; ok {
		h.lastAccess = time.Now()
		act := h.actor
		s.mu.Unlock()
		return act, nil
	}
	s.mu.Unlock()

	if s.db == nil {
		return nil, fmt.Errorf("no database")
	}

	type agRow struct {
		Config json.RawMessage `gorm:"column:config"`
	}
	var r agRow
	err := s.db.Table("agents").
		Select("config").
		Where("id = ? AND user_id = ? AND is_primary = ?", agentID, s.userID, false).
		First(&r).Error
	if err != nil {
		return nil, fmt.Errorf("load generic agent: %w", err)
	}

	var cfg ActorConfig
	_ = json.Unmarshal(r.Config, &cfg)
	if cfg.SystemPrompt == "" {
		cfg.SystemPrompt = defaultSystemPrompt
	}
	if cfg.LLMConfigID != "" {
		var row provider.LLMConfigRow
		if s.db.Where("id = ? AND enabled = true", cfg.LLMConfigID).First(&row).Error == nil {
			cfg.Model = row.Model
		}
	}
	cfg.Permissions = PrimaryRuleset

	llm, err := s.resolveLLMForConfig(&cfg)
	if err != nil {
		return nil, err
	}

	base := newBaseActor(
		fmt.Sprintf("generic_%s_%s", agentID, s.userID),
		agentID, s.userID, cfg, llm, s.hub, s.db, s.orch, s.registry,
	)
	base.IsPrimary = false

	actorCtx, actorCancel := context.WithCancel(s.ctx)
	handle := &genericAgentHandle{
		actor:      base,
		ctx:        actorCtx,
		cancel:     actorCancel,
		lastAccess: time.Now(),
	}

	s.mu.Lock()
	if h, ok := s.genericAgents[agentID]; ok {
		s.mu.Unlock()
		actorCancel()
		h.lastAccess = time.Now()
		return h.actor, nil
	}
	s.genericAgents[agentID] = handle
	s.mu.Unlock()

	go runGenericChatMailbox(base, actorCtx)
	slog.Info("generic chat actor created", "user", s.userID, "agent", agentID)
	return base, nil
}

func (s *Supervisor) resolveLLMForConfig(cfg *ActorConfig) (provider.LLMProvider, error) {
	if cfg != nil && cfg.LLMConfigID != "" {
		if llm, err := s.registry.Get(cfg.LLMConfigID); err == nil {
			return llm, nil
		}
	}
	return s.resolveProvider()
}

// WaitResult returns a channel that will receive the result for a given task ID.
func (s *Supervisor) WaitResult(taskID string) <-chan string {
	s.resultMu.Lock()
	defer s.resultMu.Unlock()

	ch := make(chan string, 1)
	s.pendingResults[taskID] = ch
	return ch
}

// DeliverResult delivers a SubAgent's result to the pending channel (implements ResultRouter).
func (s *Supervisor) DeliverResult(taskID, result string) {
	s.resultMu.Lock()
	ch, ok := s.pendingResults[taskID]
	if ok {
		delete(s.pendingResults, taskID)
	}
	s.resultMu.Unlock()

	if ok {
		ch <- result
	}
}

// Shutdown stops all actors.
func (s *Supervisor) Shutdown() {
	slog.Info("supervisor shutting down", "user", s.userID)
	s.cancel()
}

// monitorPrimary watches the PrimaryAgent and restarts on crash.
func (s *Supervisor) monitorPrimary() {
	restarts := 0
	for {
		<-s.primary.Done()

		if s.ctx.Err() != nil {
			return // supervisor shut down
		}

		restarts++
		if restarts > maxRestarts {
			slog.Error("primary agent exceeded max restarts", "user", s.userID)
			return
		}

		backoff := time.Duration(1<<restarts) * time.Second
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
		slog.Warn("primary agent crashed, restarting", "user", s.userID, "attempt", restarts, "backoff", backoff)
		time.Sleep(backoff)

		// Recreate with same config
		base := newBaseActor(
			s.primary.ID, s.primary.AgentID, s.userID,
			s.primary.Config, s.primary.Provider, s.hub, s.db, s.orch, s.registry,
		)
		s.primary = NewPrimaryActor(base, s)
		go s.primary.Run(s.ctx)
	}
}

// monitorSub watches a SubActor and restarts on crash (limited restarts).
func (s *Supervisor) monitorSub(h *ActorHandle, sub *SubActor) {
	for {
		<-h.actor.Done()

		if h.ctx.Err() != nil {
			return // cancelled normally
		}

		h.restarts++
		if h.restarts > 3 {
			slog.Warn("sub actor exceeded restarts, removing", "type", h.agentType)
			s.removeSub(h.agentType)
			return
		}

		backoff := time.Duration(1<<h.restarts) * time.Second
		slog.Warn("sub actor crashed, restarting", "type", h.agentType, "attempt", h.restarts)
		time.Sleep(backoff)

		newBase := newBaseActor(h.actor.ID, h.actor.AgentID, s.userID,
			h.actor.Config, h.actor.Provider, s.hub, s.db, s.orch, s.registry)
		newSub := NewSubActor(newBase, s)
		h.actor = newBase
		go newSub.Run(h.ctx)
	}
}

// reaper periodically parks idle SubActors.
func (s *Supervisor) reaper() {
	ticker := time.NewTicker(reaperInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.mu.Lock()
			for agentType, h := range s.subActors {
				if time.Since(h.lastAccess) > idleTimeout {
					slog.Info("reaping idle sub actor", "type", agentType, "idle", h.actor.IdleSince())
					h.cancel()
					delete(s.subActors, agentType)
				}
			}
			for gid, h := range s.genericAgents {
				if time.Since(h.lastAccess) > idleTimeout {
					slog.Info("reaping idle generic chat actor", "agent", gid, "idle", h.actor.IdleSince())
					h.cancel()
					delete(s.genericAgents, gid)
				}
			}
			s.mu.Unlock()
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *Supervisor) removeSub(agentType string) {
	s.mu.Lock()
	if h, ok := s.subActors[agentType]; ok {
		h.cancel()
		delete(s.subActors, agentType)
	}
	s.mu.Unlock()
}

func (s *Supervisor) resolveProvider() (provider.LLMProvider, error) {
	llm, _, err := s.registry.GetAny()
	return llm, err
}
