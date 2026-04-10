package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/media"
	"gorm.io/gorm"
)

type GalleryAPI struct {
	db *gorm.DB
}

func RegisterGalleryRoutes(r chi.Router, db *gorm.DB) {
	a := &GalleryAPI{db: db}
	r.Get("/api/gallery", a.list)
	r.Get("/api/gallery/{id}", a.get)
	r.Delete("/api/gallery/{id}", a.del)
}

func (a *GalleryAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	mediaType := r.URL.Query().Get("media_type")

	q := a.db.Where("user_id = ?", userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	if mediaType != "" {
		q = q.Where("media_type = ?", mediaType)
	}

	var entries []media.GalleryEntry
	q.Order("created_at desc").Limit(50).Find(&entries)
	OK(w, entries)
}

func (a *GalleryAPI) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	var entry media.GalleryEntry
	q := a.db.Where("id = ? AND user_id = ?", id, userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	if err := q.First(&entry).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, entry)
}

func (a *GalleryAPI) del(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	q := a.db.Where("id = ? AND user_id = ?", id, userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	if res := q.Delete(&media.GalleryEntry{}); res.Error != nil || res.RowsAffected == 0 {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, M{"ok": true})
}
