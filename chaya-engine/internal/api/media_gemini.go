package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

const defaultGeminiBase = "https://generativelanguage.googleapis.com"

func RegisterGeminiMediaRoutes(r chi.Router, db *gorm.DB) {
	a := &geminiMediaAPI{db: db}
	r.Post("/api/media/gemini/image/generate", a.imageGenerate)
	r.Post("/api/media/gemini/image/edit", a.imageEdit)
	r.Post("/api/media/gemini/video/submit", a.videoSubmit)
	r.Get("/api/media/gemini/video/status/{taskName}", a.videoStatus)
	r.Post("/api/media/gemini/video/download", a.videoDownload)
	r.Get("/api/media/gemini/model-capabilities", a.modelCapabilities)
}

type geminiMediaAPI struct {
	db *gorm.DB
}

// resolveGeminiConfig fetches API key + base URL from the LLM config row.
func (a *geminiMediaAPI) resolveGeminiConfig(tenantID, configID string) (apiKey, baseURL, model string, err error) {
	var cfg pgstore.LLMConfig
	q := a.db.Where("tenant_id = ? AND enabled = true", tenantID)
	if configID != "" {
		q = q.Where("id = ?", configID)
	} else {
		q = q.Where("provider = ?", "gemini")
	}
	if err := q.First(&cfg).Error; err != nil {
		return "", "", "", fmt.Errorf("gemini config not found")
	}
	base := cfg.APIURL
	if base == "" {
		base = defaultGeminiBase
	}
	base = strings.TrimRight(base, "/")
	return cfg.APIKey, base, cfg.Model, nil
}

// ── Image Generate ──

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

	apiKey, baseURL, cfgModel, err := a.resolveGeminiConfig(tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}

	parts := []map[string]any{{"text": req.Prompt}}
	genCfg := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
	if req.AspectRatio != "" {
		genCfg["imageConfig"] = map[string]string{"aspectRatio": req.AspectRatio}
	}

	body := map[string]any{
		"contents":         []map[string]any{{"parts": parts}},
		"generationConfig": genCfg,
	}

	media, content, err := a.callGenerateContent(baseURL, model, apiKey, body)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"media": media, "content": content})
}

// ── Image Edit ──

type geminiImageEditReq struct {
	Prompt           string   `json:"prompt"`
	ImageB64         string   `json:"image_b64"`
	ImagesB64        []string `json:"images_b64"`
	ThoughtSignature string   `json:"thought_signature"`
	ConfigID         string   `json:"config_id"`
	Model            string   `json:"model"`
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

	apiKey, baseURL, cfgModel, err := a.resolveGeminiConfig(tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}

	parts := []map[string]any{}
	if req.Prompt != "" {
		parts = append(parts, map[string]any{"text": req.Prompt})
	}

	images := req.ImagesB64
	if len(images) == 0 && req.ImageB64 != "" {
		images = []string{req.ImageB64}
	}
	for _, img := range images {
		parts = append(parts, map[string]any{
			"inlineData": map[string]string{
				"mimeType": "image/png",
				"data":     img,
			},
		})
	}

	genCfg := map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}}
	if req.AspectRatio != "" {
		genCfg["imageConfig"] = map[string]string{"aspectRatio": req.AspectRatio}
	}

	body := map[string]any{
		"contents":         []map[string]any{{"parts": parts}},
		"generationConfig": genCfg,
	}

	media, content, err := a.callGenerateContent(baseURL, model, apiKey, body)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"media": media, "content": content})
}

// callGenerateContent calls Gemini generateContent and extracts media + text from the response.
func (a *geminiMediaAPI) callGenerateContent(baseURL, model, apiKey string, body map[string]any) (media []M, content string, err error) {
	url := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s", baseURL, model, apiKey)

	payload, _ := json.Marshal(body)
	httpReq, _ := http.NewRequest("POST", url, bytes.NewReader(payload))
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, "", fmt.Errorf("gemini api call failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		var errResp map[string]any
		json.Unmarshal(respBody, &errResp)
		msg := "gemini api error"
		if e, ok := errResp["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				msg = m
			}
		}
		return nil, "", fmt.Errorf("%s (HTTP %d)", msg, resp.StatusCode)
	}

	var geminiResp struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text       string `json:"text"`
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal(respBody, &geminiResp); err != nil {
		return nil, "", fmt.Errorf("failed to parse gemini response: %w", err)
	}

	var texts []string
	for _, c := range geminiResp.Candidates {
		for _, p := range c.Content.Parts {
			if p.InlineData != nil && p.InlineData.Data != "" {
				media = append(media, M{
					"mimeType": p.InlineData.MimeType,
					"data":     p.InlineData.Data,
				})
			}
			if p.Text != "" {
				texts = append(texts, p.Text)
			}
		}
	}
	if media == nil {
		media = []M{}
	}
	content = strings.Join(texts, "\n")
	return media, content, nil
}

// ── Video Submit (Veo) ──

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

	apiKey, baseURL, cfgModel, err := a.resolveGeminiConfig(tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := req.Model
	if model == "" {
		model = cfgModel
	}

	instance := map[string]any{}
	if req.Prompt != "" {
		instance["prompt"] = req.Prompt
	}
	if req.ImageB64 != "" {
		instance["image"] = map[string]string{
			"bytesBase64Encoded": req.ImageB64,
		}
	}

	body := map[string]any{
		"instances":  []map[string]any{instance},
		"parameters": map[string]any{},
	}

	url := fmt.Sprintf("%s/v1beta/models/%s:predictLongRunning?key=%s", baseURL, model, apiKey)

	payload, _ := json.Marshal(body)
	httpReq, _ := http.NewRequest("POST", url, bytes.NewReader(payload))
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		Fail(w, CodeInternal, fmt.Sprintf("gemini video api call failed: %v", err))
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 {
		var errResp map[string]any
		json.Unmarshal(respBody, &errResp)
		msg := "gemini video api error"
		if e, ok := errResp["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				msg = m
			}
		}
		Fail(w, CodeInternal, fmt.Sprintf("%s (HTTP %d)", msg, resp.StatusCode))
		return
	}

	var opResp struct {
		Name string `json:"name"`
	}
	json.Unmarshal(respBody, &opResp)
	OK(w, M{"task_name": opResp.Name, "model": model})
}

// ── Video Status ──

func (a *geminiMediaAPI) videoStatus(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	taskName := chi.URLParam(r, "taskName")
	configID := r.URL.Query().Get("config_id")

	apiKey, baseURL, _, err := a.resolveGeminiConfig(tenantID, configID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}

	url := fmt.Sprintf("%s/v1beta/%s?key=%s", baseURL, taskName, apiKey)

	httpReq, _ := http.NewRequest("GET", url, nil)
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		Fail(w, CodeInternal, fmt.Sprintf("failed to check video status: %v", err))
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		Fail(w, CodeInternal, fmt.Sprintf("video status check failed (HTTP %d)", resp.StatusCode))
		return
	}

	var opResp struct {
		Name     string `json:"name"`
		Done     bool   `json:"done"`
		Response struct {
			GenerateVideoResponse struct {
				GeneratedSamples []struct {
					Video struct {
						URI string `json:"uri"`
					} `json:"video"`
				} `json:"generatedSamples"`
			} `json:"generateVideoResponse"`
		} `json:"response"`
		Metadata struct {
			Progress float64 `json:"progress"`
		} `json:"metadata"`
		Error *struct {
			Message string `json:"message"`
			Code    int    `json:"code"`
		} `json:"error"`
	}
	json.Unmarshal(respBody, &opResp)

	if opResp.Error != nil {
		OK(w, M{"status": "FAILED", "error": opResp.Error.Message})
		return
	}

	if opResp.Done {
		videoURI := ""
		samples := opResp.Response.GenerateVideoResponse.GeneratedSamples
		if len(samples) > 0 {
			videoURI = samples[0].Video.URI
		}
		OK(w, M{"status": "SUCCEEDED", "output": videoURI, "progress": 100})
		return
	}

	OK(w, M{"status": "PROCESSING", "progress": opResp.Metadata.Progress})
}

// ── Video Download ──

type geminiVideoDownloadReq struct {
	VideoURI string `json:"video_uri"`
	ConfigID string `json:"config_id"`
}

func (a *geminiMediaAPI) videoDownload(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var req geminiVideoDownloadReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if req.VideoURI == "" {
		Fail(w, CodeBadRequest, "video_uri is required")
		return
	}

	apiKey, _, _, err := a.resolveGeminiConfig(tenantID, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}

	sep := "?"
	if strings.Contains(req.VideoURI, "?") {
		sep = "&"
	}
	url := req.VideoURI + sep + "key=" + apiKey

	httpReq, _ := http.NewRequest("GET", url, nil)
	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		Fail(w, CodeInternal, fmt.Sprintf("video download failed: %v", err))
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		Fail(w, CodeInternal, fmt.Sprintf("video download failed (HTTP %d)", resp.StatusCode))
		return
	}

	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "video/mp4"
	}
	w.Header().Set("Content-Type", ct)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.WriteHeader(200)
	io.Copy(w, resp.Body)
}

// ── Model Capabilities (static registry) ──

func (a *geminiMediaAPI) modelCapabilities(w http.ResponseWriter, _ *http.Request) {
	models := []M{
		{"label": "Gemini 2.0 Flash (Image)", "image": true, "video": false, "recommended": true, "note": "Fast image generation via generateContent"},
		{"label": "Imagen 3", "image": true, "video": false, "recommended": false, "note": "High-quality image generation"},
		{"label": "Veo 2", "image": false, "video": true, "recommended": true, "note": "Video generation"},
	}
	OK(w, M{"models": models})
}
