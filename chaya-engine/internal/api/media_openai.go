package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// OpenAI Images API routes. Supports gpt-image-1 / gpt-image-2 / dall-e-3.
// Multi-image edit is supported by gpt-image-* (multipart image[]).

func RegisterOpenAIMediaRoutes(r chi.Router, db *gorm.DB) {
	a := &openaiMediaAPI{db: db}
	r.Post("/api/media/openai/image/generate", a.imageGenerate)
	r.Post("/api/media/openai/image/edit", a.imageEdit)
}

type openaiMediaAPI struct {
	db *gorm.DB
}

func (a *openaiMediaAPI) resolveConfig(r *http.Request, configID string) (apiKey, baseURL, model string, err error) {
	tenantID := middleware.TenantID(r.Context())
	var cfg pgstore.LLMConfig
	q := a.db.Where("tenant_id = ? AND enabled = true", tenantID)
	if configID != "" {
		q = q.Where("id = ?", configID)
	} else {
		q = q.Where("provider = ?", "openai")
	}
	if err := q.First(&cfg).Error; err != nil {
		return "", "", "", fmt.Errorf("openai config not found")
	}
	base := strings.TrimRight(strings.TrimSpace(cfg.APIURL), "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	return cfg.APIKey, base, cfg.Model, nil
}

// sizeForModel maps (model, aspect_ratio, raw size) → a valid OpenAI size string.
// Per OpenAI docs (image-generation guide, 2026-05):
//   - gpt-image-2: any WxH with both dims multiples of 16, max edge ≤ 3840,
//     long/short ≤ 3, total pixels ∈ [655360, 8294400]. We pick long edge =
//     1536 by default for a good quality/cost balance.
//   - gpt-image-1: fixed {1024x1024, 1536x1024, 1024x1536, auto}.
//   - dall-e-3:    fixed {1024x1024, 1792x1024, 1024x1792}.
// If the caller already passed an explicit size, we trust it (caller can
// override with anything the model accepts).
func sizeForModel(model, aspect, rawSize string) string {
	if s := strings.TrimSpace(rawSize); s != "" {
		return s
	}
	m := strings.ToLower(strings.TrimSpace(model))
	ar := strings.TrimSpace(aspect)

	switch {
	case strings.HasPrefix(m, "gpt-image-2"):
		return computeGPTImage2Size(ar)
	case strings.HasPrefix(m, "dall-e-3"):
		return mapDallE3Size(ar)
	default:
		// gpt-image-1 and unknown OpenAI-image models share the legacy size set.
		return mapGPTImage1Size(ar)
	}
}

func mapGPTImage1Size(ar string) string {
	switch ar {
	case "1:1", "":
		return "1024x1024"
	case "16:9", "3:2", "4:3", "21:9":
		return "1536x1024"
	case "9:16", "2:3", "3:4", "9:21":
		return "1024x1536"
	default:
		return "auto"
	}
}

func mapDallE3Size(ar string) string {
	switch ar {
	case "1:1", "":
		return "1024x1024"
	case "16:9", "3:2", "4:3", "21:9":
		return "1792x1024"
	case "9:16", "2:3", "3:4", "9:21":
		return "1024x1792"
	default:
		return "1024x1024"
	}
}

// computeGPTImage2Size parses "W:H", scales so the long edge is ~1536, rounds
// both edges to multiples of 16, and clamps ratio to ≤3:1 + pixel count to the
// 655,360-8,294,400 window required by gpt-image-2.
func computeGPTImage2Size(ar string) string {
	wRatio, hRatio := parseAspect(ar)
	if wRatio <= 0 || hRatio <= 0 {
		return "1024x1024"
	}
	// Clamp ratio to 3:1 / 1:3.
	r := wRatio / hRatio
	if r > 3 {
		wRatio, hRatio = 3, 1
	} else if r < 1.0/3.0 {
		wRatio, hRatio = 1, 3
	}
	// Scale so long edge = 1536.
	var w, h float64
	if wRatio >= hRatio {
		w = 1536
		h = 1536 * (hRatio / wRatio)
	} else {
		h = 1536
		w = 1536 * (wRatio / hRatio)
	}
	wi := roundTo16(int(w))
	hi := roundTo16(int(h))
	if wi < 16 {
		wi = 16
	}
	if hi < 16 {
		hi = 16
	}
	// Clamp max edge to 3840.
	if wi > 3840 {
		wi = 3840 - (3840 % 16)
	}
	if hi > 3840 {
		hi = 3840 - (3840 % 16)
	}
	// Total pixel floor: 655,360. If undersized, scale both up by sqrt ratio.
	const minPx = 655360
	if wi*hi < minPx {
		scale := 1.05 * (float64(minPx) / float64(wi*hi))
		wi = roundTo16(int(float64(wi) * sqrtApprox(scale)))
		hi = roundTo16(int(float64(hi) * sqrtApprox(scale)))
	}
	return fmt.Sprintf("%dx%d", wi, hi)
}

func parseAspect(ar string) (float64, float64) {
	parts := strings.Split(strings.TrimSpace(ar), ":")
	if len(parts) != 2 {
		return 1, 1
	}
	var w, h float64
	_, _ = fmt.Sscanf(parts[0], "%f", &w)
	_, _ = fmt.Sscanf(parts[1], "%f", &h)
	return w, h
}

func roundTo16(n int) int {
	r := (n / 16) * 16
	if n-r >= 8 {
		r += 16
	}
	return r
}

func sqrtApprox(x float64) float64 {
	// Cheap Newton iteration; we only need ~3-digit precision for sizing.
	if x <= 0 {
		return 0
	}
	g := x / 2
	for i := 0; i < 6; i++ {
		g = (g + x/g) / 2
	}
	return g
}

type openaiImageGenReq struct {
	Prompt      string `json:"prompt"`
	ConfigID    string `json:"config_id"`
	Model       string `json:"model"`
	AspectRatio string `json:"aspect_ratio"`
	Size        string `json:"size"`
	Count       int    `json:"count"`
	// Stream=true switches the response to text/event-stream forwarding
	// OpenAI's image-generation SSE events as our own SSE protocol — used by
	// the frontend create-mode to render partial frames before the final image.
	Stream        bool `json:"stream"`
	PartialImages int  `json:"partial_images"`
}

// Dedicated client with a 5-minute outbound timeout. gpt-image-2 high-quality
// requests can run 30-120s; without an explicit timeout the call could hang
// indefinitely on TCP-level stalls, which is what we observed (OpenAI billed,
// browser kept spinning, no error surfaced).
var openaiHTTPClient = &http.Client{Timeout: 5 * time.Minute}

// openaiImageRespDatum is intentionally permissive — some self-hosted proxies
// to OpenAI image APIs rename or duplicate the b64 field. We accept all known
// aliases and fall back to whichever is non-empty.
type openaiImageRespDatum struct {
	B64JSON       string `json:"b64_json"`
	URL           string `json:"url"`
	ImageBase64   string `json:"image_base64"`   // legacy / proxy variant
	Image         string `json:"image"`          // bare-image variant
	RevisedPrompt string `json:"revised_prompt"` // diagnostic only
}
type openaiImageResp struct {
	Data  []openaiImageRespDatum `json:"data"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    string `json:"code"`
	} `json:"error"`
}

func (a *openaiMediaAPI) imageGenerate(w http.ResponseWriter, r *http.Request) {
	var req openaiImageGenReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		Fail(w, CodeBadRequest, "prompt is required")
		return
	}
	apiKey, base, cfgModel, err := a.resolveConfig(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = cfgModel
	}
	if model == "" {
		model = "gpt-image-1"
	}
	size := sizeForModel(model, req.AspectRatio, req.Size)
	count := req.Count
	if count <= 0 {
		count = 1
	}
	if count > 8 {
		count = 8
	}

	body := map[string]any{
		"model":  model,
		"prompt": req.Prompt,
		"n":      count,
		"size":   size,
	}
	// dall-e-* needs response_format=b64_json; gpt-image-* returns b64 by default.
	if strings.HasPrefix(strings.ToLower(model), "dall-e") {
		body["response_format"] = "b64_json"
	}
	// gpt-image-* generation time scales sharply with quality. Without an
	// explicit value the model can pick "high" and take 2+ minutes; pin a
	// sensible default so we stay under the client timeout. Callers can
	// override later if we add a quality picker to the UI.
	if strings.HasPrefix(strings.ToLower(model), "gpt-image") {
		body["quality"] = "medium"
	}

	if req.Stream && strings.HasPrefix(strings.ToLower(model), "gpt-image") {
		body["stream"] = true
		body["partial_images"] = clampPartials(req.PartialImages)
		bts, _ := json.Marshal(body)
		a.streamOpenAIImage(w, r, apiKey, base+"/images/generations", "application/json", bytes.NewReader(bts), model, req.Prompt, "create-mode-generate")
		return
	}

	media, content, err := callOpenAIImagesJSON(r.Context(), apiKey, base+"/images/generations", body)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"media": media, "content": content})
}

type openaiImageEditReq struct {
	Prompt        string   `json:"prompt"`
	ImageB64      string   `json:"image_b64"`
	ImagesB64     []string `json:"images_b64"`
	ConfigID      string   `json:"config_id"`
	Model         string   `json:"model"`
	AspectRatio   string   `json:"aspect_ratio"`
	Size          string   `json:"size"`
	Count         int      `json:"count"`
	Stream        bool     `json:"stream"`
	PartialImages int      `json:"partial_images"`
}

func (a *openaiMediaAPI) imageEdit(w http.ResponseWriter, r *http.Request) {
	var req openaiImageEditReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		Fail(w, CodeBadRequest, "prompt is required")
		return
	}
	imgs := req.ImagesB64
	if len(imgs) == 0 && strings.TrimSpace(req.ImageB64) != "" {
		imgs = []string{req.ImageB64}
	}
	if len(imgs) == 0 {
		Fail(w, CodeBadRequest, "at least one reference image is required")
		return
	}

	apiKey, base, cfgModel, err := a.resolveConfig(r, req.ConfigID)
	if err != nil {
		Fail(w, CodeBadRequest, err.Error())
		return
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		model = cfgModel
	}
	if model == "" {
		model = "gpt-image-1"
	}
	// /images/edits multi-image only works on gpt-image-* family.
	if len(imgs) > 1 && !strings.HasPrefix(strings.ToLower(model), "gpt-image") {
		Fail(w, CodeBadRequest, "multi-image edit requires gpt-image-* model")
		return
	}
	size := sizeForModel(model, req.AspectRatio, req.Size)
	count := req.Count
	if count <= 0 {
		count = 1
	}
	if count > 8 {
		count = 8
	}

	// Build multipart body.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("model", model)
	_ = mw.WriteField("prompt", req.Prompt)
	_ = mw.WriteField("n", fmt.Sprintf("%d", count))
	if size != "" && size != "auto" {
		_ = mw.WriteField("size", size)
	}
	if strings.HasPrefix(strings.ToLower(model), "dall-e") {
		_ = mw.WriteField("response_format", "b64_json")
	}
	if strings.HasPrefix(strings.ToLower(model), "gpt-image") {
		_ = mw.WriteField("quality", "medium")
	}
	streamMode := req.Stream && strings.HasPrefix(strings.ToLower(model), "gpt-image")
	if streamMode {
		_ = mw.WriteField("stream", "true")
		_ = mw.WriteField("partial_images", fmt.Sprintf("%d", clampPartials(req.PartialImages)))
	}
	for i, b64 := range imgs {
		raw := stripDataURI(b64)
		bin, derr := base64.StdEncoding.DecodeString(raw)
		if derr != nil {
			Fail(w, CodeBadRequest, fmt.Sprintf("image #%d invalid base64: %v", i+1, derr))
			return
		}
		// OpenAI accepts repeated "image[]" or single "image" field. Use image[]
		// for >1, image for 1 — both forms work for gpt-image-*.
		field := "image"
		if len(imgs) > 1 {
			field = "image[]"
		}
		// OpenAI rejects application/octet-stream (the default from CreateFormFile).
		// Sniff the actual mime from magic bytes and emit a proper Content-Type +
		// matching filename extension. Only png/jpeg/webp are accepted.
		mime, ext := sniffImageMime(bin)
		hdr := make(textproto.MIMEHeader)
		hdr.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, field, fmt.Sprintf("ref_%d.%s", i+1, ext)))
		hdr.Set("Content-Type", mime)
		part, perr := mw.CreatePart(hdr)
		if perr != nil {
			Fail(w, CodeInternal, perr.Error())
			return
		}
		if _, werr := part.Write(bin); werr != nil {
			Fail(w, CodeInternal, werr.Error())
			return
		}
	}
	if err := mw.Close(); err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	if streamMode {
		a.streamOpenAIImage(w, r, apiKey, base+"/images/edits", mw.FormDataContentType(), &buf, model, req.Prompt, "create-mode-edit")
		return
	}

	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, base+"/images/edits", &buf)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := openaiHTTPClient.Do(httpReq)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	defer resp.Body.Close()
	rawBody, _ := io.ReadAll(resp.Body)
	media, content, perr := parseOpenAIImageResponse(rawBody, resp.StatusCode)
	if perr != nil {
		Fail(w, CodeInternal, perr.Error())
		return
	}
	OK(w, M{"media": media, "content": content})
}

func clampPartials(n int) int {
	if n <= 0 {
		return 2
	}
	if n > 3 {
		return 3
	}
	return n
}

// streamOpenAIImage forwards OpenAI image-generation SSE events to the client
// as a simpler SSE protocol the frontend can consume with a single fetch +
// ReadableStream reader. Events emitted (one JSON per `data: ...` line):
//
//	{"type":"partial","index":N,"data":"<b64>","mimeType":"image/png"}
//	{"type":"done","data":"<b64>","mimeType":"image/png"}
//	{"type":"error","message":"..."}
//
// As a safety net against frontend parser bugs / network drops, this method
// ALSO writes the final image directly to media_outputs the moment the
// `.completed` event arrives. That way the user sees their image in the
// gallery even if the frontend never gets the SSE frame — billed work is
// never lost again.
func (a *openaiMediaAPI) streamOpenAIImage(w http.ResponseWriter, r *http.Request, apiKey, url, contentType string, body io.Reader, model, prompt, source string) {
	ctx := r.Context()
	userID := middleware.UserID(ctx)
	tenantID := middleware.TenantID(ctx)
	fl, ok := w.(http.Flusher)
	if !ok {
		Fail(w, CodeInternal, "streaming not supported by transport")
		return
	}
	// Commit to SSE response headers up-front so any later error can be sent
	// as an SSE event instead of bubbling up as a half-baked 500.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	writeEvent := func(obj any) {
		b, _ := json.Marshal(obj)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		writeEvent(M{"type": "error", "message": err.Error()})
		return
	}
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)
	httpReq.Header.Set("Content-Type", contentType)
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := openaiHTTPClient.Do(httpReq)
	if err != nil {
		writeEvent(M{"type": "error", "message": err.Error()})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		msg := truncateForErr(raw)
		var p openaiImageResp
		if json.Unmarshal(raw, &p) == nil && p.Error != nil && p.Error.Message != "" {
			msg = p.Error.Message
		}
		log.Printf("[media/openai/stream] upstream http=%d msg=%s", resp.StatusCode, msg)
		writeEvent(M{"type": "error", "message": msg})
		return
	}

	scanner := bufio.NewScanner(resp.Body)
	// b64 of a 1024² PNG is ~1.5 MB → a single SSE line can be big. 16 MB cap
	// is generous and bounded.
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	emittedFinal := false
	loggedFirst := false
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		// SSE has both `event: <name>` and `data: {json}` lines. We key off
		// the `data:` payload (the JSON has its own `type` field), so the
		// `event:` line is informative but redundant — skip it.
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(line, "data: ")
		if payload == "[DONE]" {
			break
		}
		var ev struct {
			Type              string `json:"type"`
			B64JSON           string `json:"b64_json"`
			PartialImageIndex int    `json:"partial_image_index"`
		}
		if err := json.Unmarshal([]byte(payload), &ev); err != nil {
			continue
		}
		if !loggedFirst {
			// Diagnostic: surface the first event type we see so unfamiliar
			// future variants (image_edit, image.* etc.) are spotted in logs.
			log.Printf("[media/openai/stream] first event type=%s payload_bytes=%d", ev.Type, len(payload))
			loggedFirst = true
		}
		// Match by suffix to cover both /images/generations (image_generation.*)
		// AND /images/edits (image_edit.*) — and any future variants OpenAI
		// adds like image.* — without having to enumerate every prefix here.
		switch {
		case strings.HasSuffix(ev.Type, ".partial_image"):
			writeEvent(M{"type": "partial", "index": ev.PartialImageIndex, "data": ev.B64JSON, "mimeType": "image/png"})
		case strings.HasSuffix(ev.Type, ".completed"):
			emittedFinal = true
			writeEvent(M{"type": "done", "data": ev.B64JSON, "mimeType": "image/png"})
			// Persist immediately, before the client even ACKs. This is the
			// safety net: if the browser drops the frame, the image still
			// lives in media_outputs and surfaces in the user's gallery.
			// Best-effort — a DB error here must not break the stream.
			if ev.B64JSON != "" && userID != "" {
				entry := MediaOutput{
					UserID:    userID,
					TenantID:  tenantID,
					MediaType: "image",
					MimeType:  "image/png",
					Prompt:    prompt,
					Model:     model,
					Provider:  "openai",
					Source:    source + "-stream-safety",
					B64Data:   ev.B64JSON,
					FileSize:  len(ev.B64JSON) * 3 / 4,
				}
				if err := a.db.Create(&entry).Error; err != nil {
					log.Printf("[media/openai/stream] safety-net save failed: %v", err)
				} else {
					log.Printf("[media/openai/stream] safety-net saved output id=%s bytes=%d", entry.ID, entry.FileSize)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		writeEvent(M{"type": "error", "message": "stream read: " + err.Error()})
		return
	}
	if !emittedFinal {
		writeEvent(M{"type": "error", "message": "openai: stream ended without final image"})
	}
}

func callOpenAIImagesJSON(ctx context.Context, apiKey, url string, body map[string]any) ([]M, string, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := openaiHTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return parseOpenAIImageResponse(raw, resp.StatusCode)
}

func parseOpenAIImageResponse(raw []byte, status int) ([]M, string, error) {
	log.Printf("[media/openai] response http=%d bytes=%d", status, len(raw))
	var parsed openaiImageResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "", fmt.Errorf("openai: invalid json (http %d): %s", status, truncateForErr(raw))
	}
	if parsed.Error != nil && parsed.Error.Message != "" {
		return nil, "", fmt.Errorf("openai: %s", parsed.Error.Message)
	}
	if status < 200 || status >= 300 {
		return nil, "", fmt.Errorf("openai images: http %d: %s", status, truncateForErr(raw))
	}
	out := make([]M, 0, len(parsed.Data))
	for i, d := range parsed.Data {
		// Accept any of the known b64 field names. Some OpenAI-compatible
		// proxies (esp. self-hosted gateways) rename b64_json → image_base64
		// or stash the bare base64 in `image` — without these aliases the
		// frontend sees "empty image data" while OpenAI has already billed.
		b64 := firstNonEmpty(d.B64JSON, d.ImageBase64, d.Image)
		if b64 != "" {
			// Strip data URI prefix if a proxy wrapped it.
			out = append(out, M{"mimeType": "image/png", "data": stripDataURI(b64)})
			continue
		}
		if d.URL != "" {
			// Fetch URL and re-encode as base64 so the front-end pipeline (which
			// already expects {mimeType, data}) doesn't have to special-case URLs.
			if b64, mime, err := fetchAsBase64(d.URL); err == nil {
				out = append(out, M{"mimeType": mime, "data": b64})
			} else {
				log.Printf("[media/openai] data[%d] url fetch failed: %v", i, err)
			}
		}
	}
	if len(out) == 0 {
		// Log enough of the body that a future server-log lookup can identify
		// why parsing produced nothing — empty Data array, unknown field
		// names, content-policy soft-refusal, etc.
		log.Printf("[media/openai] empty image data; data_len=%d sample=%s", len(parsed.Data), truncateForErr(raw))
		return nil, "", fmt.Errorf("openai: empty image data — see server log for response shape")
	}
	return out, "", nil
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func fetchAsBase64(url string) (string, string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("fetch %s: http %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = "image/png"
	}
	return base64.StdEncoding.EncodeToString(b), mime, nil
}

// sniffImageMime returns (mime, ext) for an image blob. Defaults to png if
// the magic bytes are unknown (OpenAI will reject application/octet-stream).
func sniffImageMime(b []byte) (string, string) {
	if len(b) >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' {
		return "image/png", "png"
	}
	if len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
		return "image/jpeg", "jpg"
	}
	if len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		return "image/webp", "webp"
	}
	return "image/png", "png"
}

func stripDataURI(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "base64,"); i >= 0 {
		return strings.TrimSpace(s[i+7:])
	}
	return s
}

func truncateForErr(b []byte) string {
	s := string(b)
	if len(s) > 240 {
		return s[:240] + "..."
	}
	return s
}
