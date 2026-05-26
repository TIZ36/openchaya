package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// TeahouseAPI — 「茶话」临时会话：直接用某个 llm_config 与模型对话，不经过 Agent。
// 复用 conversations 表，Type="teahouse"；llm_config_id / model 持久化在 Config jsonb。
type TeahouseAPI struct {
	db *gorm.DB
}

const TeahouseType = "teahouse"

func RegisterTeahouseRoutes(r chi.Router, db *gorm.DB) {
	a := &TeahouseAPI{db: db}
	r.Get("/api/teahouse/conversations", a.list)
	r.Post("/api/teahouse/conversations", a.create)
	r.Patch("/api/teahouse/conversations/{id}", a.patch)
}

// TeahouseConfig is the shape we serialize into Conversation.Config for teahouse rows.
type TeahouseConfig struct {
	LLMConfigID string `json:"llm_config_id"`
	Model       string `json:"model,omitempty"`
}

// LoadTeahouseConfig parses Conversation.Config; returns zero value if not a teahouse conv.
func LoadTeahouseConfig(conv *pgstore.Conversation) TeahouseConfig {
	var c TeahouseConfig
	if conv == nil || len(conv.Config) == 0 {
		return c
	}
	_ = json.Unmarshal(conv.Config, &c)
	return c
}

func (a *TeahouseAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	q := a.db.Model(&pgstore.Conversation{}).
		Joins("INNER JOIN users u ON u.id = conversations.user_id").
		Where("conversations.user_id = ? AND conversations.type = ?", userID, TeahouseType)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	var convs []pgstore.Conversation
	q.Order("conversations.updated_at desc").Find(&convs)
	OK(w, convs)
}

func (a *TeahouseAPI) create(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title       string `json:"title"`
		LLMConfigID string `json:"llm_config_id"`
		Model       string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}
	req.LLMConfigID = strings.TrimSpace(req.LLMConfigID)
	if req.LLMConfigID == "" {
		Fail(w, CodeInvalidParam, "llm_config_id required")
		return
	}
	if _, err := uuid.Parse(req.LLMConfigID); err != nil {
		Fail(w, CodeInvalidParam, "llm_config_id must be uuid")
		return
	}

	// Ownership check on the LLM config (defense in depth — config keys are sensitive).
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	if !llmConfigBelongsToUser(a.db, req.LLMConfigID, userID, tenantID) {
		Fail(w, CodeForbidden, "llm config not accessible")
		return
	}

	cfg, _ := json.Marshal(TeahouseConfig{LLMConfigID: req.LLMConfigID, Model: strings.TrimSpace(req.Model)})
	conv := pgstore.Conversation{
		UserID: userID,
		Title:  strings.TrimSpace(req.Title),
		Type:   TeahouseType,
		Config: cfg,
	}
	if conv.Title == "" {
		conv.Title = "新聊天"
	}
	if err := a.db.Create(&conv).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, conv)
}

func (a *TeahouseAPI) patch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := uuid.Parse(id); err != nil {
		Fail(w, CodeInvalidParam, "invalid id")
		return
	}
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	if !ConversationAccessForUser(a.db, id, userID, tenantID) {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var conv pgstore.Conversation
	if err := a.db.Where("id = ? AND type = ?", id, TeahouseType).First(&conv).Error; err != nil {
		Fail(w, CodeNotFound, "not a teahouse conversation")
		return
	}

	var req struct {
		Title       *string `json:"title"`
		LLMConfigID *string `json:"llm_config_id"`
		Model       *string `json:"model"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}

	updates := map[string]any{}
	if req.Title != nil {
		updates["title"] = strings.TrimSpace(*req.Title)
	}
	if req.LLMConfigID != nil || req.Model != nil {
		current := LoadTeahouseConfig(&conv)
		if req.LLMConfigID != nil {
			next := strings.TrimSpace(*req.LLMConfigID)
			if next != "" {
				if _, err := uuid.Parse(next); err != nil {
					Fail(w, CodeInvalidParam, "llm_config_id must be uuid")
					return
				}
				if !llmConfigBelongsToUser(a.db, next, userID, tenantID) {
					Fail(w, CodeForbidden, "llm config not accessible")
					return
				}
			}
			current.LLMConfigID = next
		}
		if req.Model != nil {
			current.Model = strings.TrimSpace(*req.Model)
		}
		cfg, _ := json.Marshal(current)
		updates["config"] = cfg
	}
	if len(updates) > 0 {
		a.db.Table("conversations").Where("id = ?", conv.ID).Updates(updates)
	}
	a.db.Where("id = ?", conv.ID).First(&conv)
	OK(w, conv)
}

// llmConfigBelongsToUser ensures the llm_config is reachable for this user.
// llm_configs are tenant-scoped (not user-scoped), so when tenantID is set we
// require config.tenant_id to match; without a tenant context we only verify
// the row exists and is enabled.
func llmConfigBelongsToUser(db *gorm.DB, configID, userID, tenantID string) bool {
	_ = userID
	if configID == "" {
		return false
	}
	q := db.Table("llm_configs").Where("id = ? AND enabled = true", configID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	var n int64
	if err := q.Count(&n).Error; err != nil {
		return false
	}
	return n > 0
}
