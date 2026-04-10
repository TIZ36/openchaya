package runtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	pkg "github.com/chaya-ai/chaya-engine/pkg"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ActorConfig holds agent configuration (mirrors agents.config JSON + frontend profile fields).
type ActorConfig struct {
	SystemPrompt string          `json:"system_prompt"`
	Model        string          `json:"model,omitempty"`
	LLMConfigID  string          `json:"llm_config_id,omitempty"`
	Permissions  Ruleset         `json:"permissions,omitempty"`
	Ext          json.RawMessage `json:"ext,omitempty"` // personaPresets, persona (voice/thinking/…)
}

// Actor is the base execution unit for all agent types.
type Actor struct {
	ID       string
	AgentID  string
	UserID   string
	Config   ActorConfig
	Mailbox  chan *envelope.Envelope
	Provider provider.LLMProvider // fallback when llm_config_id unset or lookup fails
	Registry *provider.Registry   // resolves per-config provider from DB
	Hub      *gateway.Hub
	DB       *gorm.DB
	// Orchestrator injects memory/MCP/skills context into the LLM prompt (optional).
	Orchestrator *capability.Orchestrator
	IsPrimary    bool // true for PrimaryActor — sees all MCP servers without binding

	history        []provider.Message
	mu             sync.Mutex
	done           chan struct{}
	cancelFunc     context.CancelFunc
	lastAccess     time.Time
	cachedTenantID string

	topoMatchMu             sync.Mutex
	lastTopologyIntentLabel string // Consult 命中意图 label（本回合，用于拓扑学习轨迹）
}

func newBaseActor(id, agentID, userID string, cfg ActorConfig, llm provider.LLMProvider, hub *gateway.Hub, db *gorm.DB, orch *capability.Orchestrator, reg *provider.Registry) *Actor {
	combined := combinedSystemPromptFromConfig(cfg)
	a := &Actor{
		ID:           id,
		AgentID:      agentID,
		UserID:       userID,
		Config:       cfg,
		Mailbox:      make(chan *envelope.Envelope, 32),
		Provider:     llm,
		Registry:     reg,
		Hub:          hub,
		DB:           db,
		Orchestrator: orch,
		done:         make(chan struct{}),
		lastAccess:   time.Now(),
	}
	if combined != "" {
		a.history = append(a.history, provider.Message{Role: "system", Content: combined})
	}
	return a
}

// combinedSystemPromptFromConfig merges system_prompt with persona hints from ext (frontend ChayaConfigPanel).
func combinedSystemPromptFromConfig(cfg ActorConfig) string {
	base := strings.TrimSpace(cfg.SystemPrompt)
	if base == "" {
		base = defaultSystemPrompt
	}
	extras := personaExtrasFromExt(cfg.Ext)
	if extras == "" {
		return base
	}
	return base + "\n\n" + extras
}

func personaExtrasFromExt(ext json.RawMessage) string {
	if len(ext) == 0 || string(ext) == "null" {
		return ""
	}
	var wrap struct {
		Persona *struct {
			ResponseMode          string `json:"responseMode"`
			MemoryTriggersEnabled *bool  `json:"memoryTriggersEnabled"`
			Voice                 *struct {
				Enabled bool `json:"enabled"`
			} `json:"voice"`
		} `json:"persona"`
	}
	if err := json.Unmarshal(ext, &wrap); err != nil || wrap.Persona == nil {
		return ""
	}
	p := wrap.Persona
	var parts []string
	switch p.ResponseMode {
	case "persona":
		parts = append(parts, "【对话模式】保持人设一致，语气与立场与系统人设相符。")
	}
	if p.MemoryTriggersEnabled != nil && *p.MemoryTriggersEnabled {
		parts = append(parts, "【记忆】关注对话中的长期偏好与关键事实，必要时主动承接上文。")
	}
	if p.Voice != nil && p.Voice.Enabled {
		parts = append(parts, "【语音】回复适合朗读：句式完整、避免仅符号或碎片列表。")
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "\n")
}

func (a *Actor) reloadRuntimeConfigFromDB() {
	if a.DB == nil || a.AgentID == "" {
		return
	}
	// SubActors use non-UUID labels as AgentID; only real agent rows use UUID.
	if _, err := uuid.Parse(a.AgentID); err != nil {
		return
	}
	// Runtime path only needs prompt/model/ext; avoid loading full config (e.g. base64 avatar blobs).
	var row struct {
		SystemPrompt string          `gorm:"column:system_prompt"`
		LLMConfigID  string          `gorm:"column:llm_config_id"`
		Ext          json.RawMessage `gorm:"column:ext"`
	}
	if err := a.DB.Table("agents").
		Select(
			"config ->> 'system_prompt' AS system_prompt, "+
				"config ->> 'llm_config_id' AS llm_config_id, "+
				"config -> 'ext' AS ext",
		).
		Where("id = ?", a.AgentID).
		Scan(&row).Error; err != nil {
		return
	}
	cfg := ActorConfig{
		SystemPrompt: strings.TrimSpace(row.SystemPrompt),
		LLMConfigID:  strings.TrimSpace(row.LLMConfigID),
		Ext:          row.Ext,
	}
	if cfg.LLMConfigID != "" {
		var row provider.LLMConfigRow
		if a.DB.Where("id = ? AND enabled = true", cfg.LLMConfigID).First(&row).Error == nil {
			cfg.Model = row.Model
		}
	}
	if strings.TrimSpace(cfg.SystemPrompt) == "" {
		cfg.SystemPrompt = defaultSystemPrompt
	}
	combined := combinedSystemPromptFromConfig(cfg)

	a.mu.Lock()
	defer a.mu.Unlock()
	a.Config = cfg
	if len(a.history) > 0 && a.history[0].Role == "system" {
		a.history[0].Content = combined
	} else {
		a.history = append([]provider.Message{{Role: "system", Content: combined}}, a.history...)
	}
}

func (a *Actor) resolveLLM() (provider.LLMProvider, string) {
	model := a.Config.Model
	if a.Registry != nil && a.Config.LLMConfigID != "" {
		if p, err := a.Registry.Get(a.Config.LLMConfigID); err == nil {
			if a.DB != nil {
				var row provider.LLMConfigRow
				if a.DB.Where("id = ?", a.Config.LLMConfigID).First(&row).Error == nil {
					model = row.Model
				}
			}
			return p, model
		}
	}
	return a.Provider, model
}

// topologyEnabledFromExt reads ext.persona.topologyEnabled (default false).
func (a *Actor) syncTopologyIntentFromEC(ec *capability.EnrichedContext) {
	if ec == nil {
		return
	}
	a.topoMatchMu.Lock()
	defer a.topoMatchMu.Unlock()
	a.lastTopologyIntentLabel = ""
	if ec.TopologyMatch != nil && ec.TopologyMatch.Intent != nil {
		a.lastTopologyIntentLabel = strings.TrimSpace(ec.TopologyMatch.Intent.Label)
	}
}

func topologyEnabledFromExt(ext json.RawMessage) bool {
	if len(ext) == 0 || string(ext) == "null" {
		return false
	}
	var wrap struct {
		Persona *struct {
			TopologyEnabled *bool `json:"topologyEnabled"`
		} `json:"persona"`
	}
	if json.Unmarshal(ext, &wrap) != nil || wrap.Persona == nil || wrap.Persona.TopologyEnabled == nil {
		return false
	}
	return *wrap.Persona.TopologyEnabled
}

func agentDisplayName(sys string) string {
	s := strings.TrimSpace(sys)
	if s == "" {
		return "Chaya"
	}
	if len(s) > 20 {
		return s[:20]
	}
	return s
}

// resolvedTenantID returns the user's tenant ID, lazily resolved and cached.
func (a *Actor) resolvedTenantID() string {
	if a.cachedTenantID == "" {
		a.cachedTenantID = tenantIDForUser(a.DB, a.UserID)
	}
	return a.cachedTenantID
}

// Done returns a channel that's closed when the actor exits.
func (a *Actor) Done() <-chan struct{} { return a.done }

// Touch updates the last access time (prevents idle reaping).
func (a *Actor) Touch() { a.lastAccess = time.Now() }

// IdleSince returns how long the actor has been idle.
func (a *Actor) IdleSince() time.Duration { return time.Since(a.lastAccess) }

// tenantIDForUser loads the user's tenant for skill/memory scoping.
func tenantIDForUser(db *gorm.DB, userID string) string {
	if db == nil || userID == "" {
		return ""
	}
	var tid string
	db.Table("users").Where("id = ?", userID).Select("tenant_id").Scan(&tid)
	return tid
}

// enrichMessagesWithCapabilities appends orchestrator context to the system message for this request only.
// Returns the enriched messages and any MCP tools available for function calling.
// delegatedMCPServerIDs is an optional set of MCP server IDs from delegation metadata;
// when non-nil, tools are loaded from those specific servers instead of querying agent bindings.
// toolCallMode indicates the caller will use the returned tools for function calling,
// so tool descriptions should be omitted from the system prompt to avoid redundant tokens.
func (a *Actor) enrichMessagesWithCapabilities(ctx context.Context, convID, userMsg string, messages []provider.Message, delegatedMCPServerIDs map[string]struct{}, toolCallMode bool) ([]provider.Message, []pkg.Tool) {
	if a.Orchestrator == nil || a.DB == nil {
		return messages, nil
	}
	a.publishPipelineStepWithType(convID, "", "正在加载上下文...", "capability")
	tid := a.resolvedTenantID()
	topoOn := topologyEnabledFromExt(a.Config.Ext)
	ec := a.Orchestrator.BuildContext(ctx, userMsg, a.AgentID, a.UserID, tid, topoOn, a.IsPrimary, delegatedMCPServerIDs, func(msg string) {
		a.publishPipelineStepWithType(convID, "", msg, "capability")
	})
	a.syncTopologyIntentFromEC(ec)
	add := a.Orchestrator.FormatSystemPromptAdditions(ec, toolCallMode, userMsg)
	if add == "" {
		return messages, ec.MCPTools
	}
	out := make([]provider.Message, len(messages))
	copy(out, messages)
	if len(out) > 0 && out[0].Role == "system" {
		out[0].Content = out[0].Content + add
	} else {
		out = append([]provider.Message{{Role: "system", Content: strings.TrimSpace(add)}}, out...)
	}
	return out, ec.MCPTools
}

// streamChat performs an LLM streaming call, persists messages, publishes events.
func (a *Actor) streamChat(ctx context.Context, env *envelope.Envelope) string {
	convID := env.ConvID
	resetExecutionTrace(convID)

	// Latest persona / LLM selection / system prompt from DB (after 基本设置 save)
	a.reloadRuntimeConfigFromDB()

	// Save user message
	a.persistUserMessage(convID, env.Body, env.From)

	// Build messages
	a.mu.Lock()
	a.history = append(a.history, provider.Message{Role: "user", Content: env.Body})
	messages := make([]provider.Message, len(a.history))
	copy(messages, a.history)
	a.mu.Unlock()

	messages, _ = a.enrichMessagesWithCapabilities(ctx, convID, env.Body, messages, nil, false)

	full := a.streamAssistantResponse(ctx, convID, messages)

	a.mu.Lock()
	a.history = append(a.history, provider.Message{Role: "assistant", Content: full})
	a.mu.Unlock()

	return full
}

func (a *Actor) persistUserMessage(convID, content, source string) {
	if a.DB == nil {
		return
	}

	userMsg := pgstore.Message{
		ConvID:  convID,
		Role:    "user",
		Content: content,
		Source:  source,
	}
	a.DB.Create(&userMsg)
}

func (a *Actor) streamAssistantResponse(ctx context.Context, convID string, messages []provider.Message) string {
	assistantMsg := pgstore.Message{ConvID: convID, Role: "assistant", AgentID: &a.AgentID}
	if a.DB != nil {
		a.DB.Create(&assistantMsg)
	}
	logsForMessage := bindExecutionTraceMessage(convID, assistantMsg.ID)

	a.Hub.Publish(convID, map[string]any{
		"type":           "agent_thinking",
		"agent_id":       a.AgentID,
		"agent_name":     agentDisplayName(a.Config.SystemPrompt),
		"message_id":     assistantMsg.ID,
		"execution_logs": logsForMessage,
	})

	llm, model := a.resolveLLM()
	stream, err := llm.ChatStream(ctx, provider.ChatRequest{
		Messages: messages, Model: model,
	})
	if err != nil {
		slog.Error("actor stream error", "id", a.ID, "err", err)
		a.publishPipelineStepWithType(convID, assistantMsg.ID, "请求失败："+err.Error(), "error")
		finalLogs := finishExecutionTrace(convID)
		a.persistMessageExt(assistantMsg.ID, map[string]any{
			"agent_log":     finalLogs,
			"log":           finalLogs,
			"executionLogs": finalLogs,
			"error":         err.Error(),
		})
		a.Hub.Publish(convID, map[string]any{
			"type":           "agent_stream_done",
			"agent_id":       a.AgentID,
			"message_id":     assistantMsg.ID,
			"content":        "❌ Error: " + err.Error(),
			"execution_logs": finalLogs,
			"error":          err.Error(),
		})
		return ""
	}

	a.publishPipelineStep(convID, "正在生成回答...")

	var full string
	for chunk := range stream {
		if chunk.Done {
			break
		}
		full += chunk.Content
		a.Hub.Publish(convID, map[string]any{
			"type":       "agent_stream_chunk",
			"agent_id":   a.AgentID,
			"message_id": assistantMsg.ID,
			"content":    full,
			"chunk":      chunk.Content,
		})
	}

	if a.DB != nil {
		a.DB.Model(&pgstore.Message{}).Where("id = ?", assistantMsg.ID).Update("content", full)
		textData, _ := json.Marshal(map[string]string{"text": full})
		a.DB.Create(&pgstore.MessagePart{MessageID: assistantMsg.ID, Type: "text", State: "completed", Data: textData})
	}

	finalLogs := finishExecutionTrace(convID)
	a.persistMessageExt(assistantMsg.ID, map[string]any{
		"agent_log":     finalLogs,
		"log":           finalLogs,
		"executionLogs": finalLogs,
	})

	a.Hub.Publish(convID, map[string]any{
		"type":           "agent_stream_done",
		"agent_id":       a.AgentID,
		"message_id":     assistantMsg.ID,
		"content":        full,
		"execution_logs": finalLogs,
	})

	// Only PrimaryActor (Orchestrator) should manage cross-turn trace.
	// Basic Actors (like SubActors or Direct Chat) should clear it to avoid memory leak.
	if !a.IsPrimary {
		clearExecutionTrace(convID)
	}

	return full
}

// publishPipelineStep sends a user-visible backend step to the chat UI (execution_log → SplitView 日志流).
func (a *Actor) publishPipelineStep(convID, msg string) {
	a.publishPipelineStepWithType(convID, "", msg, "step")
}

func (a *Actor) publishPipelineStepWithType(convID, messageID, msg, typ string) {
	a.publishPipelineStepWithTypeDetail(convID, messageID, msg, "", typ)
}

func (a *Actor) publishPipelineStepWithDetail(convID, msg, detail string) {
	a.publishPipelineStepWithTypeDetail(convID, "", msg, detail, "step")
}

func (a *Actor) publishPipelineStepWithTypeDetail(convID, messageID, msg, detail, typ string) {
	if a.Hub == nil || strings.TrimSpace(msg) == "" {
		return
	}
	entry := ExecutionLogEntry{
		ID:        nextExecutionLogID(),
		Timestamp: time.Now().UnixMilli(),
		Type:      strings.TrimSpace(typ),
		Message:   msg,
		Detail:    strings.TrimSpace(detail),
		AgentID:   a.AgentID,
		AgentName: agentDisplayName(a.Config.SystemPrompt),
		MessageID: messageID,
	}
	if entry.Type == "" {
		entry.Type = "step"
	}
	entry = appendExecutionTrace(convID, entry)
	a.Hub.Publish(convID, map[string]any{
		"type":       "execution_log",
		"id":         entry.ID,
		"log_type":   entry.Type,
		"message":    entry.Message,
		"detail":     entry.Detail,
		"timestamp":  entry.Timestamp,
		"agent_id":   entry.AgentID,
		"agent_name": entry.AgentName,
		"message_id": entry.MessageID,
	})
}

func (a *Actor) persistMessageExt(messageID string, patch map[string]any) {
	if a.DB == nil || strings.TrimSpace(messageID) == "" || len(patch) == 0 {
		return
	}
	var msg pgstore.Message
	if err := a.DB.Where("id = ?", messageID).First(&msg).Error; err != nil {
		return
	}
	merged := map[string]any{}
	if len(msg.Ext) > 0 && string(msg.Ext) != "null" {
		_ = json.Unmarshal(msg.Ext, &merged)
	}
	for k, v := range patch {
		merged[k] = v
	}
	buf, err := json.Marshal(merged)
	if err != nil {
		slog.Warn("persist message ext marshal failed", "message_id", messageID, "err", err)
		return
	}
	if err := a.DB.Model(&pgstore.Message{}).Where("id = ?", messageID).Update("ext", json.RawMessage(buf)).Error; err != nil {
		slog.Warn("persist message ext failed", "message_id", messageID, "err", err)
	}
}

// callLLM performs a non-streaming LLM call (used for intent classification, summarization).
func (a *Actor) callLLM(ctx context.Context, messages []provider.Message) (string, error) {
	a.reloadRuntimeConfigFromDB()
	llm, model := a.resolveLLM()
	resp, err := llm.Chat(ctx, provider.ChatRequest{Messages: messages, Model: model})
	if err != nil {
		return "", err
	}
	return resp.Content, nil
}
