package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/api"
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
	// lastReasoning is the reasoning_content from the most recent assistant
	// turn. Round-tripped into the next request — see streamAssistantResponse.
	lastReasoning  string
	// historyHydratedFor records which convID we already loaded from DB. Per-
	// agent actors are usually 1:1 with a conversation but the field guards
	// against multi-conv reuse just in case. Cleared on actor reconstruction.
	historyHydratedFor string
	// followupUserOverride lets the delegate path override the
	// "what was the user actually asking" string used when building
	// follow-up suggestions. Without it summarizeAndStream feeds in a
	// synthetic meta-prompt ("Based on the above work result...") and
	// the chips end up hilariously off-topic. Cleared after each turn.
	followupUserOverride string

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

// progressDirective nudges the model to narrate its plan briefly when a turn
// will likely take more than a handful of seconds. Soft — the model decides
// when to use it. Pairs with the backend silent-stream watchdog (a hard floor)
// so the user always gets *some* signal of forward motion.
const progressDirective = `

【推进约定】
- 如果这一轮看起来会超过几秒（需要查资料、调工具、或分步骤），先用一两句话说明你打算怎么做，再开始做。
- 工具返回后用一句话说命中 / 没命中，再决定下一步。
- 过程中发现换方向更合适，直接在回复里说"改一下：... "再继续，别默默重来。
- 没把握的时候先给一个初步答案，再在同一条回复里写"可以继续深入 X / Y / Z"让用户挑方向——别强塞"完美答案"。

【回答长度】
- 默认用**对话的长度**回答，不要写文章。大多数问题 2-4 句话、不超过 150 字能讲清楚就不要更长。
- 不用铺垫、不用"总之"开头、不用 markdown 标题、不用项目符号清单做装饰。就说话。
- 复杂问题：**先一句话结论 + 一句话理由**，然后在末尾反问一句，让用户挑自己关心的那个方向继续。例如："要不要我展开 X / Y / Z？"
- 只有当用户**明确说**"详细展开 / 完整 / 一步步写 / 给代码"时，才写长答案或清单。
- 技术答案：先给要点，代码用最小片段；别把整个文件贴回来。
- 不要罗列你没做的事（"未来可以考虑 A、B、C"）。信息密度 > 篇幅。`

// combinedSystemPromptFromConfig merges system_prompt with persona hints from ext (frontend ChayaConfigPanel).
func combinedSystemPromptFromConfig(cfg ActorConfig) string {
	base := strings.TrimSpace(cfg.SystemPrompt)
	if base == "" {
		base = defaultSystemPrompt
	}
	extras := personaExtrasFromExt(cfg.Ext)
	out := base
	if extras != "" {
		out += "\n\n" + extras
	}
	out += progressDirective
	return out
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

// hydrateHistoryFromDB loads prior messages for convID into a.history if we
// haven't done so yet. Idempotent — second call for the same convID is a
// no-op. Limits to the last N messages to keep prompt size sane; older
// turns are assumed compacted by the intelligence layer or simply dropped.
//
// Pulls reasoning_content out of message.ext.reasoning so reasoning models
// (DeepSeek-Reasoner / Qwen-thinking) keep working across the restart —
// otherwise the next call rejects with "reasoning_content must be passed
// back in history".
const (
	hydrateDefaultMessages = 30
	hydrateMinMessages     = 4
	hydrateMaxMessages     = 200
)

// historyMaxFromExt reads the per-agent override from ext.persona.historyMaxMessages.
// Falls back to hydrateDefaultMessages when missing or out of range. Clamped
// to [4, 200] so a typo can't blow context budget or strip all memory.
func historyMaxFromExt(ext json.RawMessage) int {
	if len(ext) == 0 {
		return hydrateDefaultMessages
	}
	var wrap struct {
		Persona *struct {
			HistoryMaxMessages *int `json:"historyMaxMessages"`
		} `json:"persona"`
	}
	if err := json.Unmarshal(ext, &wrap); err != nil || wrap.Persona == nil || wrap.Persona.HistoryMaxMessages == nil {
		return hydrateDefaultMessages
	}
	n := *wrap.Persona.HistoryMaxMessages
	if n < hydrateMinMessages {
		return hydrateMinMessages
	}
	if n > hydrateMaxMessages {
		return hydrateMaxMessages
	}
	return n
}

func (a *Actor) hydrateHistoryFromDB(convID string) {
	if a.DB == nil || convID == "" {
		return
	}
	a.mu.Lock()
	if a.historyHydratedFor == convID {
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()

	type row struct {
		Role    string          `gorm:"column:role"`
		Content string          `gorm:"column:content"`
		Ext     json.RawMessage `gorm:"column:ext"`
	}
	var rows []row
	// Pull last N+1 ordered desc, then reverse — cheaper than ordering asc
	// and offsetting from total count.
	limit := historyMaxFromExt(a.Config.Ext)
	if err := a.DB.Table("messages").
		Select("role, content, ext").
		Where("conv_id = ? AND role IN ('user','assistant')", convID).
		Order("created_at desc").
		Limit(limit).
		Find(&rows).Error; err != nil {
		slog.Warn("hydrate history: db read failed", "conv", convID, "err", err)
		a.mu.Lock()
		a.historyHydratedFor = convID
		a.mu.Unlock()
		return
	}
	// Reverse to chronological order so the LLM sees the conversation in
	// the order it actually happened.
	loaded := make([]provider.Message, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		msg := provider.Message{Role: r.Role, Content: r.Content}
		if r.Role == "assistant" && len(r.Ext) > 0 {
			var wrap struct {
				Reasoning string `json:"reasoning"`
			}
			if json.Unmarshal(r.Ext, &wrap) == nil {
				msg.Reasoning = wrap.Reasoning
			}
		}
		loaded = append(loaded, msg)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.historyHydratedFor == convID {
		return // racy double-call; the other goroutine won
	}
	// Keep the system prompt at index 0 (set in newBaseActor); insert the
	// hydrated turns between it and any in-memory tail.
	if len(a.history) > 0 && a.history[0].Role == "system" {
		sys := a.history[0]
		tail := a.history[1:]
		a.history = append([]provider.Message{sys}, loaded...)
		a.history = append(a.history, tail...)
	} else {
		a.history = append(loaded, a.history...)
	}
	a.historyHydratedFor = convID
	slog.Info("hydrate history", "conv", convID, "loaded", len(loaded))
}

// streamChat performs an LLM streaming call, persists messages, publishes events.
func (a *Actor) streamChat(ctx context.Context, env *envelope.Envelope) string {
	convID := env.ConvID
	resetExecutionTrace(convID)

	// Latest persona / LLM selection / system prompt from DB (after 基本设置 save)
	a.reloadRuntimeConfigFromDB()

	// Save the user's clean text. Knowledge lives in ext only — not mixed
	// into the persisted content so history stays exactly what the user typed.
	a.persistUserMessageWithExt(convID, env.Body, env.From, env.Data)

	// For the LLM call, layer RAG knowledge (if any) ON TOP of the user's
	// text for this turn only. NOT persisted — next turn sees fresh history.
	userForLLM := env.Body
	if block := extractKnowledgeBlock(env.Data); block != "" {
		userForLLM = block + "\n\n---\n\n" + env.Body
	}

	// Hydrate prior conversation from DB if this is the first envelope
	// for this convID after construction (server restart, idle reaper, or
	// a brand new actor for an existing conversation). Without this the
	// agent loses all multi-turn context across server restarts.
	a.hydrateHistoryFromDB(convID)

	// Pull image / file attachments off env.Data so the LLM call gets them
	// as a true multipart message (vision input). Without this they were
	// only being persisted into ext for the UI bubble — the LLM saw the
	// user's text but no picture.
	atts := extractAttachments(env.Data)

	// Build messages
	a.mu.Lock()
	a.history = append(a.history, provider.Message{Role: "user", Content: userForLLM, Attachments: atts})
	messages := make([]provider.Message, len(a.history))
	copy(messages, a.history)
	a.mu.Unlock()

	messages, _ = a.enrichMessagesWithCapabilities(ctx, convID, env.Body, messages, nil, false)

	full := a.streamAssistantResponse(ctx, convID, messages)

	a.mu.Lock()
	a.history = append(a.history, provider.Message{
		Role:      "assistant",
		Content:   full,
		Reasoning: a.lastReasoning,
	})
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

// persistUserMessageWithExt is the ext-aware variant. The frontend now stores
// retrieved knowledge in ext.knowledge (chip in the bubble) and no longer
// mixes it into content — so we pass ext through to the row so the history
// re-render shows the same chip on reload.
func (a *Actor) persistUserMessageWithExt(convID, content, source string, data json.RawMessage) {
	if a.DB == nil {
		return
	}
	userMsg := pgstore.Message{
		ConvID:  convID,
		Role:    "user",
		Content: content,
		Source:  source,
	}
	if ext := extractPersistableExt(data); ext != nil {
		userMsg.Ext = ext
	}
	a.DB.Create(&userMsg)
}

// extractAttachments pulls the frontend-supplied media[] off env.Data and
// converts it into provider.Attachment values for the LLM call. Frontend
// shape: ext.media = [{type, mime_type, data, name, output_id?}, ...]
//
// We accept either base64 in `data` (uploaded files / pasted images) or
// an `output_id` referencing a stored gallery item — for the latter we
// don't load bytes here (the engine doesn't host a fetch path tied to
// the user identity yet); skipped with a log so the user sees that
// gallery references aren't reaching the model. Direct uploads work.
func extractAttachments(data json.RawMessage) []provider.Attachment {
	if len(data) == 0 {
		return nil
	}
	var wrap struct {
		Media []struct {
			Type     string `json:"type"`
			MimeType string `json:"mime_type"`
			Data     string `json:"data"`
			URL      string `json:"url"`
			Name     string `json:"name"`
			OutputID string `json:"output_id"`
		} `json:"media"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil || len(wrap.Media) == 0 {
		return nil
	}
	out := make([]provider.Attachment, 0, len(wrap.Media))
	for _, m := range wrap.Media {
		if m.Data == "" && m.URL == "" {
			if m.OutputID != "" {
				slog.Info("attachment: gallery output_id reference not yet inlined", "output_id", m.OutputID)
			}
			continue
		}
		out = append(out, provider.Attachment{
			Type:     m.Type,
			MimeType: m.MimeType,
			Data:     m.Data,
			URL:      m.URL,
			Name:     m.Name,
		})
	}
	return out
}

// extractKnowledgeBlock formats the frontend-supplied knowledge hits into a
// compact prefix the model can use as context for this single turn. Kept
// short — one line per hit — to stay inside prompt budgets.
func extractKnowledgeBlock(data json.RawMessage) string {
	if len(data) == 0 {
		return ""
	}
	var payload struct {
		Knowledge []struct {
			Kind    string `json:"kind"`
			Content string `json:"content"`
			Pinned  bool   `json:"pinned"`
		} `json:"knowledge"`
	}
	if err := json.Unmarshal(data, &payload); err != nil || len(payload.Knowledge) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("[知识 · 来自你之前存的]")
	for _, k := range payload.Knowledge {
		c := strings.TrimSpace(k.Content)
		if c == "" {
			continue
		}
		kind := strings.TrimSpace(k.Kind)
		if kind == "" {
			kind = "memory"
		}
		tag := kind
		if k.Pinned {
			tag = kind + " · pinned"
		}
		b.WriteString("\n- (")
		b.WriteString(tag)
		b.WriteString(") ")
		b.WriteString(c)
	}
	return b.String()
}

// extractPersistableExt keeps the pieces of the envelope payload that should
// live on the user message row (knowledge chip, media). Drops ephemerals like
// agent_id and enable_tool_calling that are purely routing/runtime hints.
func extractPersistableExt(data json.RawMessage) json.RawMessage {
	if len(data) == 0 {
		return nil
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return nil
	}
	keep := map[string]json.RawMessage{}
	for _, k := range []string{"knowledge", "media"} {
		if v, ok := all[k]; ok && len(v) > 0 {
			keep[k] = v
		}
	}
	if len(keep) == 0 {
		return nil
	}
	b, err := json.Marshal(keep)
	if err != nil {
		return nil
	}
	return b
}

// streamAssistantResponse runs one streaming LLM call and returns the
// final assistant content. Reasoning (if any) is persisted to message.ext
// and exposed for the next-turn round-trip via the lastReasoning field.
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

	// Silent-stream watchdog: if no chunk arrives for ~7s, surface a
	// "still working" progress log so the user sees the turn is alive.
	// Every real chunk bumps lastChunkAt, so active streams never spam.
	var (
		lastChunkAt atomic.Int64
		full        string
		streamStart = time.Now()
	)
	lastChunkAt.Store(streamStart.UnixNano())
	watchCtx, cancelWatch := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		const quietWindow = 7 * time.Second
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				last := time.Unix(0, lastChunkAt.Load())
				if time.Since(last) >= quietWindow {
					elapsed := int(time.Since(streamStart).Seconds())
					a.publishPipelineStep(convID, fmt.Sprintf("还在想…（%ds）", elapsed))
					// Reset so we space subsequent ticks by another quietWindow.
					lastChunkAt.Store(time.Now().UnixNano())
				}
			}
		}
	}()

	// Coalesce per-token chunks into ~one-frame batches. Fast providers (e.g.
	// Deepseek) emit 30-60 tokens/sec; without batching every token = a JSON
	// encode + WS frame + frontend setState. We flush when the pending delta
	// crosses ~32 chars OR ~16ms (≈ one render frame), whichever first.
	const (
		flushChars  = 32
		flushPeriod = 16 * time.Millisecond
	)
	var (
		pending      strings.Builder
		pendingThink strings.Builder
		fullThink    string
		lastFlush    = time.Now()
		lastFlushTh  = time.Now()
	)
	flush := func() {
		if pending.Len() == 0 {
			return
		}
		a.Hub.Publish(convID, map[string]any{
			"type":       "agent_stream_chunk",
			"agent_id":   a.AgentID,
			"message_id": assistantMsg.ID,
			"content":    full,
			"chunk":      pending.String(),
		})
		pending.Reset()
		lastFlush = time.Now()
	}
	// Thinking/reasoning is published on its own event so the UI can render
	// it as a folded gray block — distinct from the final answer. Same
	// batching strategy as content; reasoning streams can be fast (DeepSeek
	// reasoner emits ~80 tok/sec while thinking).
	flushThink := func() {
		if pendingThink.Len() == 0 {
			return
		}
		a.Hub.Publish(convID, map[string]any{
			"type":       "agent_reasoning_chunk",
			"agent_id":   a.AgentID,
			"message_id": assistantMsg.ID,
			"content":    fullThink,
			"chunk":      pendingThink.String(),
		})
		pendingThink.Reset()
		lastFlushTh = time.Now()
	}
	for chunk := range stream {
		lastChunkAt.Store(time.Now().UnixNano())
		if chunk.Done {
			break
		}
		if chunk.Reasoning != "" {
			fullThink += chunk.Reasoning
			pendingThink.WriteString(chunk.Reasoning)
			if pendingThink.Len() >= flushChars || time.Since(lastFlushTh) >= flushPeriod {
				flushThink()
			}
		}
		if chunk.Content != "" {
			full += chunk.Content
			pending.WriteString(chunk.Content)
			if pending.Len() >= flushChars || time.Since(lastFlush) >= flushPeriod {
				flush()
			}
		}
	}
	flushThink()
	flush() // emit any tail before stream_done so the UI lands on full content.
	cancelWatch()

	if a.DB != nil {
		a.DB.Model(&pgstore.Message{}).Where("id = ?", assistantMsg.ID).Update("content", full)
		textData, _ := json.Marshal(map[string]string{"text": full})
		a.DB.Create(&pgstore.MessagePart{MessageID: assistantMsg.ID, Type: "text", State: "completed", Data: textData})
	}

	finalLogs := finishExecutionTrace(convID)
	ext := map[string]any{
		"agent_log":     finalLogs,
		"log":           finalLogs,
		"executionLogs": finalLogs,
	}
	if fullThink != "" {
		ext["reasoning"] = fullThink
	}
	a.persistMessageExt(assistantMsg.ID, ext)

	doneEvt := map[string]any{
		"type":           "agent_stream_done",
		"agent_id":       a.AgentID,
		"message_id":     assistantMsg.ID,
		"content":        full,
		"execution_logs": finalLogs,
	}
	if fullThink != "" {
		doneEvt["reasoning"] = fullThink
	}
	a.Hub.Publish(convID, doneEvt)

	// Fire follow-up suggestions in the background. Uses the same provider
	// the agent just answered with (capped to 120 tokens / temp=0 in
	// GenerateFollowups so it lands in <1s on most providers). Pushed back
	// to the UI as `agent_followups` so the front-end has zero HTTP wait.
	userMsgForFollowup := lastUserText(messages)
	a.mu.Lock()
	if a.followupUserOverride != "" {
		userMsgForFollowup = a.followupUserOverride
		a.followupUserOverride = ""
	}
	a.mu.Unlock()
	go a.publishFollowups(convID, assistantMsg.ID, userMsgForFollowup, full)

	// Only PrimaryActor (Orchestrator) should manage cross-turn trace.
	// Basic Actors (like SubActors or Direct Chat) should clear it to avoid memory leak.
	if !a.IsPrimary {
		clearExecutionTrace(convID)
	}

	// Stash for the next-turn history append. DeepSeek-Reasoner / Qwen-thinking
	// require the previous turn's reasoning_content to be passed back in the
	// follow-up request — we keep it here and read it in streamChat.
	a.mu.Lock()
	a.lastReasoning = fullThink
	a.mu.Unlock()

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

// lastUserText returns the most recent user message content from the message
// slice, or "" if none. Used to pair user → assistant for followup prompting.
func lastUserText(msgs []provider.Message) string {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == "user" {
			return msgs[i].Content
		}
	}
	return ""
}

// publishFollowups runs the suggestion call in the background and emits an
// `agent_followups` event on the conversation hub when results arrive. Empty
// list ⇒ no event (the UI keeps the slot empty rather than rendering nothing).
//
// Routes through GenerateFollowupsWithFallback so a reasoning-model agent
// (DeepSeek-Reasoner / Qwen-thinking) doesn't silently lose followups when
// the 120-token budget gets eaten by hidden thinking. The chain prefers a
// non-reasoning sibling config; falls back to the agent's own model with
// a relaxed budget if that's the only one available.
func (a *Actor) publishFollowups(convID, msgID, userMsg, asstMsg string) {
	defer func() {
		if r := recover(); r != nil {
			slog.Warn("publishFollowups panic", "err", r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	var sugs []string
	if a.Registry != nil {
		sugs = api.GenerateFollowupsWithFallback(ctx, a.Registry, a.Config.LLMConfigID, userMsg, asstMsg)
	} else {
		// No registry → fall back to the actor's directly-injected provider.
		prov, model := a.resolveLLM()
		sugs = api.GenerateFollowups(ctx, prov, model, userMsg, asstMsg)
	}
	if len(sugs) == 0 {
		return
	}
	a.Hub.Publish(convID, map[string]any{
		"type":        "agent_followups",
		"agent_id":    a.AgentID,
		"message_id":  msgID,
		"suggestions": sugs,
	})
}
