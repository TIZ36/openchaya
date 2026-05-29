package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// LocalAgentAPI 管理本地 CLI Agent（cursor / codex / gemini）的凭据。
// 凭据按用户作用域；明文落库（与现有 LLMConfig 同安全档：JWT 后 + 列表打码）。
// 仅桌面端本地驱动消费——主进程起 CLI 进程时注入对应 env（如 CURSOR_API_KEY）。
type LocalAgentAPI struct {
	db *gorm.DB
}

// 允许录入凭据的 provider 白名单（避免任意写入）。
var localAgentProviders = map[string]bool{
	"cursor": true,
	"codex":  true,
	"gemini": true,
}

func RegisterLocalAgentRoutes(r chi.Router, db *gorm.DB) {
	a := &LocalAgentAPI{db: db}
	r.Get("/api/local-agent/credentials", a.list)
	r.Put("/api/local-agent/credentials/{provider}", a.upsert)
	r.Delete("/api/local-agent/credentials/{provider}", a.del)
	r.Get("/api/local-agent/credentials/{provider}/api-key", a.getAPIKey)
}

func (a *LocalAgentAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	var creds []pgstore.LocalAgentCredential
	a.db.Where("user_id = ?", userID).Find(&creds)
	for i := range creds {
		creds[i].APIKey = maskAPIKey(creds[i].APIKey)
	}
	OK(w, creds)
}

func (a *LocalAgentAPI) upsert(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	if !localAgentProviders[provider] {
		Fail(w, CodeInvalidParam, "unsupported provider")
		return
	}
	var body struct {
		APIKey string `json:"api_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())

	var cred pgstore.LocalAgentCredential
	err := a.db.Where("user_id = ? AND provider = ?", userID, provider).First(&cred).Error
	if err == gorm.ErrRecordNotFound {
		cred = pgstore.LocalAgentCredential{
			UserID: userID, TenantID: tenantID, Provider: provider,
			APIKey: body.APIKey, CreatedAt: time.Now(), UpdatedAt: time.Now(),
		}
		if err := a.db.Create(&cred).Error; err != nil {
			Fail(w, CodeInternal, err.Error())
			return
		}
	} else if err == nil {
		if err := a.db.Model(&cred).Updates(map[string]any{
			"api_key": body.APIKey, "updated_at": time.Now(),
		}).Error; err != nil {
			Fail(w, CodeInternal, err.Error())
			return
		}
	} else {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"provider": provider, "api_key": maskAPIKey(body.APIKey)})
}

func (a *LocalAgentAPI) del(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	userID := middleware.UserID(r.Context())
	a.db.Where("user_id = ? AND provider = ?", userID, provider).Delete(&pgstore.LocalAgentCredential{})
	OK(w, M{"ok": true})
}

func (a *LocalAgentAPI) getAPIKey(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")
	userID := middleware.UserID(r.Context())
	var cred pgstore.LocalAgentCredential
	if err := a.db.Where("user_id = ? AND provider = ?", userID, provider).First(&cred).Error; err != nil {
		Fail(w, CodeNotFound, "credential not found")
		return
	}
	OK(w, M{"api_key": cred.APIKey})
}
