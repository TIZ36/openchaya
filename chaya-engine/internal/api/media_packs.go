package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type mediaPackAPI struct {
	db *gorm.DB
}

type mediaPackPayload struct {
	ID            string          `json:"id,omitempty"`
	Title         string          `json:"title"`
	Pinned        bool            `json:"pinned"`
	CreatedAt     int64           `json:"createdAt,omitempty"`
	Prompt        string          `json:"prompt"`
	RefImages     json.RawMessage `json:"refImages,omitempty"`
	RefDirectives json.RawMessage `json:"refDirectives,omitempty"`
	ImageSize     json.RawMessage `json:"imageSize,omitempty"`
}

type upsertMediaPacksReq struct {
	Packs []mediaPackPayload `json:"packs"`
}

func RegisterMediaPackRoutes(r chi.Router, db *gorm.DB) {
	a := &mediaPackAPI{db: db}
	r.Get("/api/media/packs", a.list)
	r.Put("/api/media/packs", a.replaceAll)
}

func (a *mediaPackAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	var rows []pgstore.ImagePromptPack
	if err := a.db.Where("user_id = ?", userID).Order("updated_at desc, created_at desc").Find(&rows).Error; err != nil {
		Fail(w, CodeInternal, "failed to load media packs")
		return
	}
	out := make([]any, 0, len(rows))
	for _, row := range rows {
		var payload map[string]any
		if err := json.Unmarshal(row.Payload, &payload); err != nil {
			continue
		}
		payload["id"] = row.ID
		payload["title"] = row.Title
		payload["pinned"] = row.Pinned
		out = append(out, payload)
	}
	OK(w, M{"packs": out})
}

func (a *mediaPackAPI) replaceAll(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	var req upsertMediaPacksReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	rows := make([]pgstore.ImagePromptPack, 0, len(req.Packs))
	for _, pack := range req.Packs {
		title := strings.TrimSpace(pack.Title)
		prompt := strings.TrimSpace(pack.Prompt)
		if title == "" || prompt == "" {
			continue
		}
		payload, err := json.Marshal(M{
			"id":            strings.TrimSpace(pack.ID),
			"title":         title,
			"pinned":        pack.Pinned,
			"createdAt":     pack.CreatedAt,
			"prompt":        prompt,
			"refImages":     json.RawMessage(pack.RefImages),
			"refDirectives": json.RawMessage(pack.RefDirectives),
			"imageSize":     json.RawMessage(pack.ImageSize),
		})
		if err != nil {
			continue
		}
		row := pgstore.ImagePromptPack{
			ID:       strings.TrimSpace(pack.ID),
			UserID:   userID,
			TenantID: tenantID,
			Title:    title,
			Pinned:   pack.Pinned,
			Payload:  payload,
		}
		rows = append(rows, row)
	}
	err := a.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&pgstore.ImagePromptPack{}).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.Create(&rows).Error
	})
	if err != nil {
		Fail(w, CodeInternal, "failed to save media packs")
		return
	}
	OK(w, M{"saved": len(rows)})
}
