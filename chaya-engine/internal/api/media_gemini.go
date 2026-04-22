package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/chaya-ai/chaya-engine/internal/channel/gemini"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
	"google.golang.org/genai"
)

// RegisterGeminiMediaRoutes registers Gemini image/video routes (business logic in internal/channel/gemini).
func RegisterGeminiMediaRoutes(r chi.Router, db *gorm.DB) {
	a := &geminiMediaAPI{db: db}
	r.Post("/api/media/gemini/image/generate", a.imageGenerate)
	r.Post("/api/media/gemini/image/edit", a.imageEdit)
	r.Post("/api/media/gemini/rewrite-prompt", a.rewritePrompt)
	r.Post("/api/media/gemini/video/submit", a.videoSubmit)
	r.Get("/api/media/gemini/video/status/{taskName}", a.videoStatus)
	r.Post("/api/media/gemini/video/download", a.videoDownload)
	r.Get("/api/media/gemini/model-capabilities", a.modelCapabilities)
}

type geminiMediaAPI struct {
	db *gorm.DB
}

func (a *geminiMediaAPI) clientForRequest(r *http.Request, configID string) (*genai.Client, error) {
	tenantID := middleware.TenantID(r.Context())
	apiKey, baseURL, _, err := gemini.ResolveLLMConfig(a.db, tenantID, configID)
	if err != nil {
		return nil, err
	}
	return gemini.NewClient(r.Context(), apiKey, baseURL)
}

type geminiImageGenReq struct {
	Prompt      string `json:"prompt"`
	ConfigID    string `json:"config_id"`
	Model       string `json:"model"`
	AspectRatio string `json:"aspect_ratio"`
	Count       int    `json:"count"`
}

func (a *geminiMediaAPI) imageGenerate(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var req geminiImageGenReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if req.Prompt == "" {
		Fail(w, CodeBadRequest, "prompt is required")
		return
	}
	_, _, cfgModel, err := gemini.ResolveLLMConfig(a.db, tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}
	c, err := a.clientForRequest(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	media, content, err := gemini.GenerateImage(r.Context(), c, model, req.Prompt, req.AspectRatio)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	out := make([]M, 0, len(media))
	for _, m := range media {
		out = append(out, M{"mimeType": m.MIMEType, "data": m.Data})
	}
	OK(w, M{"media": out, "content": content})
}

type geminiRewriteReq struct {
	Prompt      string `json:"prompt"`
	AspectRatio string `json:"aspect_ratio"`
	ConfigID    string `json:"config_id"`
	// Optional — override rewrite model. Defaults to "gemini-2.5-flash".
	Model string `json:"model"`
}

func (a *geminiMediaAPI) rewritePrompt(w http.ResponseWriter, r *http.Request) {
	var req geminiRewriteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if req.Prompt == "" {
		Fail(w, CodeBadRequest, "prompt is required")
		return
	}
	c, err := a.clientForRequest(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	text, err := gemini.RewritePrompt(r.Context(), c, req.Model, req.Prompt, req.AspectRatio)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"prompt": text})
}

type geminiImageEditReq struct {
	Prompt           string   `json:"prompt"`
	ImageB64         string   `json:"image_b64"`
	ImagesB64        []string `json:"images_b64"`
	ThoughtSignature string   `json:"thought_signature"`
	ConfigID         string   `json:"config_id"`
	Model            string `json:"model"`
	AspectRatio      string   `json:"aspect_ratio"`
	Count            int      `json:"count"`
}

func (a *geminiMediaAPI) imageEdit(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var req geminiImageEditReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	_, _, cfgModel, err := gemini.ResolveLLMConfig(a.db, tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}
	images := req.ImagesB64
	if len(images) == 0 && req.ImageB64 != "" {
		images = []string{req.ImageB64}
	}
	c, err := a.clientForRequest(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	media, content, err := gemini.EditImage(r.Context(), c, model, req.Prompt, images, req.AspectRatio)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	out := make([]M, 0, len(media))
	for _, m := range media {
		out = append(out, M{"mimeType": m.MIMEType, "data": m.Data})
	}
	OK(w, M{"media": out, "content": content})
}

type geminiVideoSubmitReq struct {
	Prompt   string `json:"prompt"`
	ImageB64 string `json:"image_b64"`
	ConfigID string `json:"config_id"`
	Model    string `json:"model"`
}

func (a *geminiMediaAPI) videoSubmit(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var req geminiVideoSubmitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	_, _, cfgModel, err := gemini.ResolveLLMConfig(a.db, tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}
	c, err := a.clientForRequest(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	task, usedModel, err := gemini.VideoSubmit(r.Context(), c, model, req.Prompt, req.ImageB64)
	if err != nil {
		Fail(w, CodeInternal, fmt.Sprintf("gemini video api call failed: %v", err))
		return
	}
	OK(w, M{"task_name": task, "model": usedModel})
}

func (a *geminiMediaAPI) videoStatus(w http.ResponseWriter, r *http.Request) {
	taskName := chi.URLParam(r, "taskName")
	configID := r.URL.Query().Get("config_id")
	c, err := a.clientForRequest(r, configID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	payload, err := gemini.VideoPollStatus(r.Context(), c, taskName)
	if err != nil {
		Fail(w, CodeInternal, fmt.Sprintf("failed to check video status: %v", err))
		return
	}
	OK(w, payload)
}

type geminiVideoDownloadReq struct {
	VideoURI string `json:"video_uri"`
	ConfigID string `json:"config_id"`
}

func (a *geminiMediaAPI) videoDownload(w http.ResponseWriter, r *http.Request) {
	var req geminiVideoDownloadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if req.VideoURI == "" {
		Fail(w, CodeBadRequest, "video_uri is required")
		return
	}
	c, err := a.clientForRequest(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	if err := gemini.VideoDownload(r.Context(), c, req.VideoURI, w); err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
}

func (a *geminiMediaAPI) modelCapabilities(w http.ResponseWriter, _ *http.Request) {
	models := []M{
		{"label": "Gemini 2.0 Flash (Image)", "image": true, "video": false, "recommended": true, "note": "Fast image generation via generateContent"},
		{"label": "Imagen 3", "image": true, "video": false, "recommended": false, "note": "High-quality image generation"},
		{"label": "Veo 2", "image": false, "video": true, "recommended": true, "note": "Video generation"},
	}
	OK(w, M{"models": models})
}
