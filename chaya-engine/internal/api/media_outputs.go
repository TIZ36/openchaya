package api

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// MediaOutput persists user-created media from the media studio.
// B64Data stores the raw base64 string (no data: prefix) to keep PG storage
// straightforward; the API layer assembles the data URI on read.
type MediaOutput struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"output_id"`
	UserID    string          `gorm:"type:uuid;index" json:"-"`
	TenantID  string          `gorm:"type:uuid;index" json:"-"`
	MediaType string          `json:"media_type"`
	MimeType  string          `json:"mime_type"`
	Prompt    string          `json:"prompt,omitempty"`
	Model     string          `json:"model,omitempty"`
	Provider  string          `json:"provider,omitempty"`
	Source    string          `json:"source,omitempty"`
	B64Data   string          `gorm:"column:b64_data;type:text" json:"-"`
	FileSize  int             `json:"file_size,omitempty"`
	Metadata  json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"metadata,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

func (MediaOutput) TableName() string { return "media_outputs" }

func RegisterMediaOutputRoutes(r chi.Router, db *gorm.DB) {
	db.AutoMigrate(&MediaOutput{})
	a := &mediaOutputAPI{db: db}
	r.Get("/api/media/outputs", a.list)
	r.Post("/api/media/outputs", a.save)
	r.Delete("/api/media/outputs/{id}", a.del)
}

// RegisterMediaOutputPublicRoutes registers the /file endpoint outside JWT so
// <img src="..."> can load it without Authorization headers.
func RegisterMediaOutputPublicRoutes(r chi.Router, db *gorm.DB) {
	a := &mediaOutputAPI{db: db}
	r.Get("/api/media/outputs/{id}/file", a.file)
}

type mediaOutputAPI struct {
	db *gorm.DB
}

type mediaOutputOut struct {
	OutputID  string          `json:"output_id"`
	MediaType string          `json:"media_type"`
	FilePath  string          `json:"file_path"`
	MimeType  string          `json:"mime_type,omitempty"`
	Prompt    string          `json:"prompt,omitempty"`
	Model     string          `json:"model,omitempty"`
	Provider  string          `json:"provider,omitempty"`
	Source    string          `json:"source,omitempty"`
	FileSize  int             `json:"file_size,omitempty"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

func toOutputOut(m MediaOutput) mediaOutputOut {
	mime := m.MimeType
	if mime == "" {
		mime = "image/png"
	}
	return mediaOutputOut{
		OutputID:  m.ID,
		MediaType: m.MediaType,
		FilePath:  fmt.Sprintf("data:%s;base64,%s", mime, m.B64Data),
		MimeType:  m.MimeType,
		Prompt:    m.Prompt,
		Model:     m.Model,
		Provider:  m.Provider,
		Source:    m.Source,
		FileSize:  m.FileSize,
		Metadata:  m.Metadata,
		CreatedAt: m.CreatedAt,
	}
}

func (a *mediaOutputAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	q := a.db.Where("user_id = ?", userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	var items []MediaOutput
	q.Order("created_at desc").
		Limit(limit).Offset(offset).
		Find(&items)

	out := make([]mediaOutputOut, len(items))
	for i, m := range items {
		out[i] = toOutputOut(m)
	}
	OK(w, M{"items": out})
}

type saveOutputReq struct {
	Data      string          `json:"data"`
	MediaType string          `json:"media_type"`
	MimeType  string          `json:"mime_type"`
	Prompt    string          `json:"prompt"`
	Model     string          `json:"model"`
	Provider  string          `json:"provider"`
	Source    string          `json:"source"`
	Metadata  json.RawMessage `json:"metadata"`
}

func (a *mediaOutputAPI) save(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())

	var req saveOutputReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	if req.Data == "" {
		Fail(w, CodeBadRequest, "data is required")
		return
	}

	b64 := req.Data
	if idx := strings.Index(b64, ","); idx > 0 && strings.HasPrefix(b64[:idx], "data:") {
		b64 = b64[idx+1:]
	}

	mime := req.MimeType
	if mime == "" {
		if req.MediaType == "video" {
			mime = "video/mp4"
		} else {
			mime = "image/png"
		}
	}

	entry := MediaOutput{
		UserID:    userID,
		TenantID:  tenantID,
		MediaType: req.MediaType,
		MimeType:  mime,
		Prompt:    req.Prompt,
		Model:     req.Model,
		Provider:  req.Provider,
		Source:    req.Source,
		B64Data:   b64,
		FileSize:  len(b64) * 3 / 4,
	}
	if len(req.Metadata) > 0 {
		entry.Metadata = req.Metadata
	}
	if err := a.db.Create(&entry).Error; err != nil {
		Fail(w, CodeInternal, "failed to save output")
		return
	}
	OK(w, toOutputOut(entry))
}

func (a *mediaOutputAPI) del(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")
	q := a.db.Where("id = ? AND user_id = ?", id, userID)
	if tenantID != "" {
		q = q.Where("tenant_id = ?", tenantID)
	}
	if res := q.Delete(&MediaOutput{}); res.Error != nil || res.RowsAffected == 0 {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, M{"deleted": true})
}

// file decodes the stored base64 and serves the raw binary with appropriate
// Content-Type. Registered as a public route so <img src> works without JWT.
func (a *mediaOutputAPI) file(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var entry MediaOutput
	if err := a.db.Select("id, mime_type, b64_data").Where("id = ?", id).First(&entry).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(entry.B64Data)
	if err != nil {
		Fail(w, CodeInternal, "corrupt data")
		return
	}
	ct := entry.MimeType
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(200)
	w.Write(raw)
}
