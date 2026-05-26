package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence/topology"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// HistoryInvalidator lets the conversation API tell the actor runtime to drop a
// conversation's cached in-memory history after a truncate, so a live agent
// stops re-sending messages the user just deleted. Implemented by
// *runtime.ActorPool; the api package can't import runtime (cycle), hence this
// minimal interface. Always nil-safe at the call site.
type HistoryInvalidator interface {
	InvalidateConvHistory(userID, convID string)
}

type ConversationAPI struct {
	db  *gorm.DB
	reg *provider.Registry
	inv HistoryInvalidator
}

func (a *ConversationAPI) resolvePrimaryConversation(userID, tenantID string) (*pgstore.Conversation, error) {
	q := a.db.Model(&pgstore.Agent{}).
		Joins("INNER JOIN users u ON u.id = agents.user_id").
		Where("agents.user_id = ? AND agents.is_primary = ?", userID, true)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	var agent pgstore.Agent
	if err := q.First(&agent).Error; err != nil {
		return nil, err
	}

	var conv pgstore.Conversation
	var link pgstore.ConversationAgent
	if err := a.db.Where("agent_id = ?", agent.ID).First(&link).Error; err == nil {
		if ConversationAccessForUser(a.db, link.ConversationID, userID, tenantID) {
			if err := a.db.Where("id = ?", link.ConversationID).First(&conv).Error; err == nil {
				return &conv, nil
			}
		}
	}

	newConv := pgstore.Conversation{
		UserID: agent.UserID,
		Title:  agent.Name,
		Type:   "agent",
	}
	if err := a.db.Create(&newConv).Error; err != nil {
		return nil, err
	}
	if err := a.db.Create(&pgstore.ConversationAgent{
		ConversationID: newConv.ID,
		AgentID:        agent.ID,
	}).Error; err != nil {
		return nil, err
	}
	return &newConv, nil
}

func (a *ConversationAPI) resolveConversation(id, userID, tenantID string) (*pgstore.Conversation, error) {
	if id == "agent_chaya" {
		return a.resolvePrimaryConversation(userID, tenantID)
	}

	parsedID, parseErr := uuid.Parse(id)
	if parseErr != nil {
		return nil, gorm.ErrRecordNotFound
	}
	id = parsedID.String()

	var conv pgstore.Conversation
	cq := a.db.Model(&pgstore.Conversation{}).
		Joins("INNER JOIN users u ON u.id = conversations.user_id").
		Where("conversations.id = ? AND conversations.user_id = ?", id, userID)
	if tenantID != "" {
		cq = cq.Where("u.tenant_id = ?", tenantID)
	}
	if err := cq.First(&conv).Error; err == nil {
		return &conv, nil
	}

	if !agentAccessForUser(a.db, id, userID, tenantID) {
		return nil, gorm.ErrRecordNotFound
	}
	var agent pgstore.Agent
	if err := a.db.Where("id = ?", id).First(&agent).Error; err != nil {
		return nil, err
	}

	var link pgstore.ConversationAgent
	if err := a.db.Where("agent_id = ?", agent.ID).First(&link).Error; err == nil {
		if ConversationAccessForUser(a.db, link.ConversationID, userID, tenantID) {
			if err := a.db.Where("id = ?", link.ConversationID).First(&conv).Error; err == nil {
				return &conv, nil
			}
		}
	}

	newConv := pgstore.Conversation{
		UserID: agent.UserID,
		Title:  agent.Name,
		Type:   "agent",
	}
	if err := a.db.Create(&newConv).Error; err != nil {
		return nil, err
	}
	if err := a.db.Create(&pgstore.ConversationAgent{
		ConversationID: newConv.ID,
		AgentID:        agent.ID,
	}).Error; err != nil {
		return nil, err
	}
	return &newConv, nil
}

func RegisterConversationRoutes(r chi.Router, db *gorm.DB, reg *provider.Registry, inv HistoryInvalidator) {
	a := &ConversationAPI{db: db, reg: reg, inv: inv}

	// Primary paths
	r.Get("/api/conversations", a.list)
	r.Post("/api/conversations", a.create)
	r.Get("/api/conversations/{id}", a.get)
	r.Put("/api/conversations/{id}", a.update)
	r.Delete("/api/conversations/{id}", a.del)
	r.Get("/api/conversations/{id}/messages", a.messages)
	r.Post("/api/conversations/{id}/messages", a.saveMessage)
	r.Delete("/api/conversations/{id}/messages", a.truncateMessages)
	r.Patch("/api/conversations/{id}/messages/{msgId}/feedback", a.patchMessageFeedback)
	r.Delete("/api/conversations/{id}/messages/{msgId}", a.deleteMessage)

	// Aliases — frontend uses "sessions" naming
	r.Get("/api/sessions", a.list)
	r.Post("/api/sessions", a.create)
	r.Get("/api/sessions/{id}", a.get)
	r.Put("/api/sessions/{id}", a.update)
	r.Delete("/api/sessions/{id}", a.del)
	r.Get("/api/sessions/{id}/messages", a.messages)
	r.Post("/api/sessions/{id}/messages", a.saveMessage)
	r.Delete("/api/sessions/{id}/messages", a.truncateMessages)
	r.Patch("/api/sessions/{id}/messages/{msgId}/feedback", a.patchMessageFeedback)
	r.Delete("/api/sessions/{id}/messages/{msgId}", a.deleteMessage)
	r.Get("/api/sessions/{id}/summaries", a.getSummaries) // Handle frontend 404
	r.Delete("/api/sessions/{id}/summaries/cache", a.clearSummariesCache)
}

func (a *ConversationAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	q := a.db.Model(&pgstore.Conversation{}).
		Joins("INNER JOIN users u ON u.id = conversations.user_id").
		Where("conversations.user_id = ? AND conversations.type <> ?", userID, TeahouseType)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	var convs []pgstore.Conversation
	q.Order("conversations.updated_at desc").Find(&convs)
	OK(w, convs)
}

func (a *ConversationAPI) getSummaries(w http.ResponseWriter, r *http.Request) {
	// Frontend occasionally polls /summaries for session info; return empty for now to avoid 404
	OK(w, []any{})
}

func (a *ConversationAPI) clearSummariesCache(w http.ResponseWriter, r *http.Request) {
	OK(w, M{"ok": true})
}

func (a *ConversationAPI) create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title string `json:"title"`
		Type  string `json:"type"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.Type == "" {
		req.Type = "private"
	}

	conv := pgstore.Conversation{
		UserID: middleware.UserID(r.Context()),
		Title:  req.Title,
		Type:   req.Type,
	}
	if err := a.db.Create(&conv).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, conv)
}

func (a *ConversationAPI) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	conv, err := a.resolveConversation(id, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, conv)
}

func (a *ConversationAPI) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	conv, err := a.resolveConversation(id, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var updates map[string]any
	json.NewDecoder(r.Body).Decode(&updates)
	// Frontend uses `name` for the user-visible label; the column is `title`.
	// Translate here so /api/sessions/{id} (alias) rename writes the right column.
	if v, ok := updates["name"]; ok {
		if _, hasTitle := updates["title"]; !hasTitle {
			updates["title"] = v
		}
		delete(updates, "name")
	}
	// Drop unknown / read-only fields to avoid gorm errors on bogus columns.
	allowed := map[string]struct{}{"title": {}, "type": {}, "config": {}, "updated_at": {}}
	for k := range updates {
		if _, ok := allowed[k]; !ok {
			delete(updates, k)
		}
	}
	if len(updates) > 0 {
		a.db.Table("conversations").Where("id = ?", conv.ID).Updates(updates)
	}
	a.db.Where("id = ?", conv.ID).First(conv)
	OK(w, conv)
}

func (a *ConversationAPI) del(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	conv, err := a.resolveConversation(id, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	a.db.Where("conversation_id = ?", conv.ID).Delete(&pgstore.ConversationAgent{})
	a.db.Where("id = ?", conv.ID).Delete(&pgstore.Conversation{})
	a.db.Where("conv_id = ?", conv.ID).Delete(&pgstore.Message{})
	OK(w, M{"ok": true})
}

func (a *ConversationAPI) messages(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	conv, err := a.resolveConversation(id, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var msgs []pgstore.Message
	a.db.Where("conv_id = ?", conv.ID).Order("created_at asc").Preload("Parts").Find(&msgs)
	OK(w, msgs)
}

func (a *ConversationAPI) saveMessage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	conv, err := a.resolveConversation(id, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var req struct {
		Role    string          `json:"role"`
		Content string          `json:"content"`
		Source  string          `json:"source"`
		Ext     json.RawMessage `json:"ext"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	if req.Role == "" {
		req.Role = "user"
	}
	source := req.Source
	if source == "" {
		source = "direct"
	}

	msg := pgstore.Message{
		ConvID:  conv.ID,
		Role:    req.Role,
		Content: req.Content,
		Source:  source,
	}
	if len(req.Ext) > 0 && string(req.Ext) != "null" {
		msg.Ext = req.Ext
	}
	if err := a.db.Create(&msg).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	// Update conversation's updated_at
	a.db.Table("conversations").Where("id = ?", conv.ID).Update("updated_at", msg.CreatedAt)

	OK(w, msg)
}

func mergeMessageExtMap(existing json.RawMessage, fn func(map[string]any)) (json.RawMessage, error) {
	base := map[string]any{}
	if len(existing) > 0 && string(existing) != "null" {
		_ = json.Unmarshal(existing, &base)
	}
	if base == nil {
		base = map[string]any{}
	}
	fn(base)
	return json.Marshal(base)
}

// patchMessageFeedback merges assistant_feedback into messages.ext and appends a topology trace for consolidation.
// The URL {id} param is accepted for routing but ignored: ownership is validated via the message's own conv_id,
// so session_id / agent_id / conversation_id are all accepted as {id} without error.
func (a *ConversationAPI) patchMessageFeedback(w http.ResponseWriter, r *http.Request) {
	msgID := chi.URLParam(r, "msgId")
	userID := middleware.UserID(r.Context())
	if _, err := uuid.Parse(msgID); err != nil {
		Fail(w, CodeInvalidParam, "invalid message id")
		return
	}
	tenantID := middleware.TenantID(r.Context())

	var req struct {
		Rating string `json:"rating"` // "", "up", "down"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}
	rating := strings.ToLower(strings.TrimSpace(req.Rating))
	if rating != "" && rating != "up" && rating != "down" {
		Fail(w, CodeInvalidParam, `rating must be "up", "down", or omitted to clear`)
		return
	}

	// Look up message by its ID alone; validate ownership via the message's actual conv_id.
	var msg pgstore.Message
	if err := a.db.Where("id = ?", msgID).First(&msg).Error; err != nil {
		Fail(w, CodeNotFound, "message not found")
		return
	}
	if !ConversationAccessForUser(a.db, msg.ConvID, userID, tenantID) {
		Fail(w, CodeForbidden, "no access to this message")
		return
	}
	if msg.Role != "assistant" {
		Fail(w, CodeInvalidParam, "only assistant messages can be rated")
		return
	}

	newExt, err := mergeMessageExtMap(msg.Ext, func(m map[string]any) {
		if rating == "" {
			delete(m, "assistant_feedback")
			delete(m, "assistant_feedback_at")
			return
		}
		m["assistant_feedback"] = rating
		m["assistant_feedback_at"] = time.Now().UTC().Format(time.RFC3339Nano)
	})
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	if err := a.db.Model(&msg).Update("ext", newExt).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	agentID := topology.AgentIDForConversation(a.db, msg.ConvID)
	if msg.AgentID != nil && strings.TrimSpace(*msg.AgentID) != "" {
		agentID = strings.TrimSpace(*msg.AgentID)
	}
	if agentID != "" && (rating == "up" || rating == "down") {
		_ = topology.AppendAssistantRatingTrace(a.db, agentID, msgID, rating == "up")
		// Thumbs-up: trigger async topology rebuild to reinforce this successful interaction.
		if rating == "up" {
			AsyncRebuildTopology(a.db, a.reg, agentID)
		}
	}

	var out pgstore.Message
	_ = a.db.Where("id = ?", msgID).First(&out).Error
	OK(w, out)
}

func (a *ConversationAPI) deleteMessage(w http.ResponseWriter, r *http.Request) {
	convKey := chi.URLParam(r, "id")
	msgID := chi.URLParam(r, "msgId")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	// Verify msgID is a valid UUID to avoid GORM/Postgres syntax errors for temporary frontend IDs
	if _, err := uuid.Parse(msgID); err != nil {
		slog.Warn("ignoring delete for non-uuid message id", "id", msgID)
		OK(w, M{"ok": true, "ignored": true})
		return
	}
	conv, err := a.resolveConversation(convKey, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	// 必须先删 message_parts：存在 FK(message_id -> messages.id) 时先删父行会失败（助手消息常有 reasoning/tool 等 part）
	a.db.Where("message_id = ?", msgID).Delete(&pgstore.MessagePart{})
	res := a.db.Where("id = ? AND conv_id = ?", msgID, conv.ID).Delete(&pgstore.Message{})
	if res.Error != nil {
		Fail(w, CodeInternal, res.Error.Error())
		return
	}
	OK(w, M{"ok": true})
}

// truncateMessages rewinds a conversation to an anchor message: it deletes the
// anchor (when inclusive, the default) plus every message created after it.
// Backs the frontend "回退到某消息 / 回退并编辑" actions. Query params:
//
//	from       — anchor message id (uuid, required)
//	inclusive  — "false" keeps the anchor and only deletes what follows; any
//	             other value (or omitted) deletes the anchor too (default)
//
// After deletion the live agent actor's cached history is invalidated so the
// next turn re-hydrates from the truncated DB rather than re-sending the gone
// messages. (Teahouse rebuilds history from DB each turn, so it needs nothing.)
func (a *ConversationAPI) truncateMessages(w http.ResponseWriter, r *http.Request) {
	convKey := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())

	fromID := strings.TrimSpace(r.URL.Query().Get("from"))
	if fromID == "" {
		Fail(w, CodeInvalidParam, "missing 'from' message id")
		return
	}
	if _, err := uuid.Parse(fromID); err != nil {
		Fail(w, CodeInvalidParam, "invalid 'from' message id")
		return
	}
	inclusive := r.URL.Query().Get("inclusive") != "false"

	conv, err := a.resolveConversation(convKey, userID, tenantID)
	if err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}

	var anchor pgstore.Message
	if err := a.db.Where("id = ? AND conv_id = ?", fromID, conv.ID).First(&anchor).Error; err != nil {
		Fail(w, CodeNotFound, "anchor message not found")
		return
	}

	// Everything strictly after the anchor, by creation time. Persists are
	// sequential (user turn, then network round-trip, then assistant placeholder),
	// so created_at reliably separates them — ties between distinct turns don't occur.
	var ids []string
	a.db.Model(&pgstore.Message{}).
		Where("conv_id = ? AND created_at > ?", conv.ID, anchor.CreatedAt).
		Pluck("id", &ids)
	if inclusive {
		ids = append(ids, anchor.ID)
	}
	if len(ids) == 0 {
		OK(w, M{"ok": true, "deleted": 0})
		return
	}

	// Parts first — FK(message_id -> messages.id) blocks deleting parent rows.
	a.db.Where("message_id IN ?", ids).Delete(&pgstore.MessagePart{})
	res := a.db.Where("id IN ?", ids).Delete(&pgstore.Message{})
	if res.Error != nil {
		Fail(w, CodeInternal, res.Error.Error())
		return
	}
	a.db.Table("conversations").Where("id = ?", conv.ID).Update("updated_at", time.Now())

	if a.inv != nil {
		a.inv.InvalidateConvHistory(conv.UserID, conv.ID)
	}
	OK(w, M{"ok": true, "deleted": len(ids)})
}
