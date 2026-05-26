// Package teahouse runs stateless "tea-chat" turns: a user picks an
// llm_config (and optional model override) and talks directly to the
// provider. No Agent / Actor / Supervisor / Topology — just the
// conversation history piped to ChatStream, with events shaped like the
// agent path so the existing frontend handler keeps working unchanged.
package teahouse

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

// Service coordinates teahouse turns. One per process.
type Service struct {
	DB  *gorm.DB
	Hub *gateway.Hub
	Reg *provider.Registry

	mu      sync.Mutex
	cancels map[string]context.CancelFunc // convID → cancel current turn
}

func NewService(db *gorm.DB, hub *gateway.Hub, reg *provider.Registry) *Service {
	return &Service{
		DB:      db,
		Hub:     hub,
		Reg:     reg,
		cancels: make(map[string]context.CancelFunc),
	}
}

// TurnRequest is the payload for a single teahouse turn.
type TurnRequest struct {
	ConvID  string
	UserID  string
	Content string
	Ext     map[string]any
}

// Start launches a turn in a background goroutine and returns immediately.
// Any previous in-flight turn for the same conv is cancelled first.
func (s *Service) Start(req TurnRequest) error {
	if strings.TrimSpace(req.ConvID) == "" {
		return fmt.Errorf("conv_id required")
	}

	var conv pgstore.Conversation
	if err := s.DB.Where("id = ? AND user_id = ?", req.ConvID, req.UserID).First(&conv).Error; err != nil {
		return fmt.Errorf("conversation not found")
	}
	if conv.Type != "teahouse" {
		return fmt.Errorf("not a teahouse conversation")
	}

	cfg := loadConfig(conv.Config)
	if cfg.LLMConfigID == "" {
		return fmt.Errorf("teahouse conversation missing llm_config_id")
	}
	llm, err := s.Reg.Get(cfg.LLMConfigID)
	if err != nil {
		return fmt.Errorf("llm config unavailable: %w", err)
	}

	// Cancel any prior turn on this conv before starting a new one.
	s.Cancel(req.ConvID)

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.cancels[req.ConvID] = cancel
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			if cur, ok := s.cancels[req.ConvID]; ok {
				// Only clear if it's still us — a newer turn may have replaced it.
				if fmt.Sprintf("%p", cur) == fmt.Sprintf("%p", cancel) {
					delete(s.cancels, req.ConvID)
				}
			}
			s.mu.Unlock()
			cancel()
		}()
		s.runTurn(ctx, &conv, cfg, llm, req)
	}()
	return nil
}

// Cancel stops any in-flight turn for convID. No-op if none.
func (s *Service) Cancel(convID string) {
	s.mu.Lock()
	cancel, ok := s.cancels[convID]
	if ok {
		delete(s.cancels, convID)
	}
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

func (s *Service) runTurn(ctx context.Context, conv *pgstore.Conversation, cfg config, llm provider.LLMProvider, req TurnRequest) {
	atts := extractAttachments(req.Ext)

	// Persist user message.
	userMsg := pgstore.Message{
		ConvID:  conv.ID,
		Role:    "user",
		Content: req.Content,
		Source:  "teahouse",
	}
	if ext := persistableUserExt(req.Ext); ext != nil {
		userMsg.Ext = ext
	}
	if err := s.DB.Create(&userMsg).Error; err != nil {
		slog.Error("teahouse: save user msg", "err", err)
		s.publishError(conv.ID, "", "保存消息失败："+err.Error())
		return
	}

	// Build messages: prior history (no system prompt — keep it "naked") + the
	// fresh user turn with attachments. Cap to last 50 to keep prompts bounded.
	// Fold a quoted message (ext.quote) in as context for THIS turn only —
	// prepended above the user's text. Persisted content stays clean (the raw
	// quote lives in the user-message ext so the chip survives reload).
	contentForLLM := req.Content
	// @域: fold frontend-retrieved knowledge (ext.knowledge) into the LLM-facing
	// turn — same as the agent path's extractKnowledgeBlock. Without this the
	// teahouse model never sees the cited domain content. Persisted content
	// stays clean (knowledge lives in the user-message ext for the chip).
	if kb := knowledgeBlockFromExt(req.Ext); kb != "" {
		contentForLLM = kb + "\n\n---\n\n" + contentForLLM
	}
	if q := quoteBlockFromExt(req.Ext); q != "" {
		contentForLLM = q + "\n\n---\n\n" + contentForLLM
	}

	hist := s.buildHistory(conv.ID, userMsg.ID)
	hist = append(hist, provider.Message{
		Role:        "user",
		Content:     contentForLLM,
		Attachments: atts,
	})

	assistant := pgstore.Message{ConvID: conv.ID, Role: "assistant", Source: "teahouse", Model: cfg.Model}
	if err := s.DB.Create(&assistant).Error; err != nil {
		slog.Error("teahouse: save assistant placeholder", "err", err)
		return
	}

	s.Hub.Publish(conv.ID, map[string]any{
		"type":       "agent_thinking",
		"agent_id":   "teahouse",
		"agent_name": "茶话",
		"message_id": assistant.ID,
	})

	stream, err := llm.ChatStream(ctx, provider.ChatRequest{
		Messages: hist,
		Model:    cfg.Model,
	})
	if err != nil {
		slog.Error("teahouse: chat stream", "err", err)
		s.Hub.Publish(conv.ID, map[string]any{
			"type":       "agent_stream_done",
			"agent_id":   "teahouse",
			"message_id": assistant.ID,
			"content":    "❌ Error: " + err.Error(),
			"error":      err.Error(),
		})
		s.DB.Model(&pgstore.Message{}).Where("id = ?", assistant.ID).Update("content", "❌ Error: "+err.Error())
		return
	}

	const (
		flushChars  = 32
		flushPeriod = 16 * time.Millisecond
	)
	var (
		full      string
		fullThink string
		pending   strings.Builder
		pendingTh strings.Builder
		lastFlush = time.Now()
		lastTh    = time.Now()
	)
	flush := func() {
		if pending.Len() == 0 {
			return
		}
		s.Hub.Publish(conv.ID, map[string]any{
			"type":       "agent_stream_chunk",
			"agent_id":   "teahouse",
			"message_id": assistant.ID,
			"content":    full,
			"chunk":      pending.String(),
		})
		pending.Reset()
		lastFlush = time.Now()
	}
	flushTh := func() {
		if pendingTh.Len() == 0 {
			return
		}
		s.Hub.Publish(conv.ID, map[string]any{
			"type":       "agent_reasoning_chunk",
			"agent_id":   "teahouse",
			"message_id": assistant.ID,
			"content":    fullThink,
			"chunk":      pendingTh.String(),
		})
		pendingTh.Reset()
		lastTh = time.Now()
	}

	for chunk := range stream {
		if chunk.Done {
			break
		}
		if chunk.Reasoning != "" {
			fullThink += chunk.Reasoning
			pendingTh.WriteString(chunk.Reasoning)
			if pendingTh.Len() >= flushChars || time.Since(lastTh) >= flushPeriod {
				flushTh()
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
	flushTh()
	flush()

	// Persist final content + reasoning (in ext).
	s.DB.Model(&pgstore.Message{}).Where("id = ?", assistant.ID).Update("content", full)
	textData, _ := json.Marshal(map[string]string{"text": full})
	s.DB.Create(&pgstore.MessagePart{MessageID: assistant.ID, Type: "text", State: "completed", Data: textData})

	if fullThink != "" {
		ext, _ := json.Marshal(map[string]any{"reasoning": fullThink})
		s.DB.Model(&pgstore.Message{}).Where("id = ?", assistant.ID).Update("ext", ext)
	}

	// Bump conversation updated_at so it sorts to the top.
	s.DB.Table("conversations").Where("id = ?", conv.ID).Update("updated_at", time.Now())

	// Auto-title: if this is the conv's first assistant turn and the user
	// hasn't picked a custom title, use the first ~24 chars of the first user
	// message so the sidebar shows something meaningful. We key on assistant-
	// message-count rather than the title literal so any default the API
	// layer chose (茶话 / 聊天 / 新聊天 / …) all qualify.
	if strings.TrimSpace(full) != "" {
		var priorAssistant int64
		s.DB.Model(&pgstore.Message{}).
			Where("conv_id = ? AND role = ? AND id <> ?", conv.ID, "assistant", assistant.ID).
			Count(&priorAssistant)
		if priorAssistant == 0 && !titleLooksCustom(conv.Title) {
			newTitle := autoTitleFrom(req.Content)
			if newTitle != "" && newTitle != strings.TrimSpace(conv.Title) {
				if err := s.DB.Table("conversations").Where("id = ?", conv.ID).Update("title", newTitle).Error; err == nil {
					conv.Title = newTitle
					s.Hub.Publish(conv.ID, map[string]any{
						"type":    "conversation_renamed",
						"conv_id": conv.ID,
						"title":   newTitle,
					})
				}
			}
		}
	}

	done := map[string]any{
		"type":       "agent_stream_done",
		"agent_id":   "teahouse",
		"message_id": assistant.ID,
		"content":    full,
	}
	if fullThink != "" {
		done["reasoning"] = fullThink
	}
	s.Hub.Publish(conv.ID, done)
}

func (s *Service) buildHistory(convID, excludeMsgID string) []provider.Message {
	var rows []pgstore.Message
	s.DB.Where("conv_id = ? AND id <> ?", convID, excludeMsgID).
		Order("created_at asc").
		Limit(50).
		Find(&rows)
	out := make([]provider.Message, 0, len(rows))
	for _, m := range rows {
		role := m.Role
		if role != "user" && role != "assistant" && role != "system" {
			continue
		}
		if strings.TrimSpace(m.Content) == "" {
			continue
		}
		out = append(out, provider.Message{Role: role, Content: m.Content})
	}
	return out
}

func (s *Service) publishError(convID, msgID, msg string) {
	s.Hub.Publish(convID, map[string]any{
		"type":       "agent_stream_done",
		"agent_id":   "teahouse",
		"message_id": msgID,
		"content":    "❌ " + msg,
		"error":      msg,
	})
}

// titleLooksCustom reports whether the title has been user-edited. Any of the
// known auto/default labels count as not-custom and may be replaced.
func titleLooksCustom(t string) bool {
	t = strings.TrimSpace(t)
	if t == "" {
		return false
	}
	switch t {
	case "茶话", "聊天", "新聊天", "新会话", "新对话":
		return false
	}
	return true
}

// autoTitleFrom returns a sidebar-friendly title from the user's first turn.
// Rune-aware (so multi-byte CJK isn't sliced mid-codepoint) and capped at
// ~24 runes; trailing whitespace stripped. Newlines flattened to spaces so
// multi-paragraph prompts don't break layout.
func autoTitleFrom(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	runes := []rune(s)
	const maxRunes = 24
	if len(runes) <= maxRunes {
		return s
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "…"
}

// ─── helpers (kept private to avoid coupling other packages to teahouse) ─────

type config struct {
	LLMConfigID string `json:"llm_config_id"`
	Model       string `json:"model,omitempty"`
}

func loadConfig(raw json.RawMessage) config {
	var c config
	if len(raw) == 0 {
		return c
	}
	_ = json.Unmarshal(raw, &c)
	return c
}

// extractAttachments mirrors the runtime's behaviour: ext.media[] → []provider.Attachment.
// Kept inline to avoid importing the runtime package (would pull in the whole actor graph).
func extractAttachments(ext map[string]any) []provider.Attachment {
	if ext == nil {
		return nil
	}
	raw, ok := ext["media"]
	if !ok {
		return nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var media []struct {
		Type     string `json:"type"`
		MimeType string `json:"mime_type"`
		Data     string `json:"data"`
		URL      string `json:"url"`
		Name     string `json:"name"`
	}
	if err := json.Unmarshal(b, &media); err != nil {
		return nil
	}
	out := make([]provider.Attachment, 0, len(media))
	for _, m := range media {
		if m.Data == "" && m.URL == "" {
			continue
		}
		out = append(out, provider.Attachment{
			Type: m.Type, MimeType: m.MimeType, Data: m.Data, URL: m.URL, Name: m.Name,
		})
	}
	return out
}

// persistableUserExt keeps only media/knowledge on the stored user message,
// dropping routing hints (agent_id etc) that don't belong on disk.
// knowledge_domains records the @-referenced domain names so the bubble can
// re-render the "引用了 …" chip on reload.
func persistableUserExt(ext map[string]any) json.RawMessage {
	if ext == nil {
		return nil
	}
	keep := map[string]any{}
	for _, k := range []string{"media", "knowledge", "quote", "knowledge_domains"} {
		if v, ok := ext[k]; ok {
			keep[k] = v
		}
	}
	if len(keep) == 0 {
		return nil
	}
	b, _ := json.Marshal(keep)
	return b
}

// quoteBlockFromExt renders ext.quote ({role, content}) into the same
// "[引用 · …]" blockquote the agent path uses, prepended to the user's turn so
// the referenced message is salient to the model. Empty if no quote attached.
func quoteBlockFromExt(ext map[string]any) string {
	if ext == nil {
		return ""
	}
	m, ok := ext["quote"].(map[string]any)
	if !ok {
		return ""
	}
	content, _ := m["content"].(string)
	content = strings.TrimSpace(content)
	if content == "" {
		return ""
	}
	role, _ := m["role"].(string)
	who := "用户"
	if role == "assistant" {
		who = "助手"
	}
	var b strings.Builder
	b.WriteString("[引用 · ")
	b.WriteString(who)
	b.WriteString("之前的消息]\n")
	for _, ln := range strings.Split(content, "\n") {
		b.WriteString("> ")
		b.WriteString(ln)
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

// knowledgeBlockFromExt renders ext.knowledge (the @域 hits the frontend
// retrieved from smartnote) into the same compact "[知识 · …]" prefix the agent
// path builds in extractKnowledgeBlock, so the teahouse model gets the cited
// domain content as context for this single turn. Empty if no knowledge.
func knowledgeBlockFromExt(ext map[string]any) string {
	if ext == nil {
		return ""
	}
	hits, ok := ext["knowledge"].([]any)
	if !ok || len(hits) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("[知识 · 来自你之前存的]")
	wrote := false
	for _, h := range hits {
		m, ok := h.(map[string]any)
		if !ok {
			continue
		}
		content, _ := m["content"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		kind, _ := m["kind"].(string)
		kind = strings.TrimSpace(kind)
		if kind == "" {
			kind = "memory"
		}
		tag := kind
		if pinned, _ := m["pinned"].(bool); pinned {
			tag = kind + " · pinned"
		}
		b.WriteString("\n- (")
		b.WriteString(tag)
		b.WriteString(") ")
		b.WriteString(content)
		wrote = true
	}
	if !wrote {
		return ""
	}
	return b.String()
}
