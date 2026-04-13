package gemini

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"google.golang.org/genai"
)

// generateContentRESTMap POSTs generateContent and returns the top-level JSON object.
// Uses the same base URL + API key as the genai client (Developer API).
func generateContentRESTMap(ctx context.Context, cfg genai.ClientConfig, model string, body map[string]any) (map[string]any, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, fmt.Errorf("gemini: api key required")
	}
	base := strings.TrimSuffix(strings.TrimSpace(cfg.HTTPOptions.BaseURL), "/")
	if base == "" {
		base = strings.TrimSuffix(DefaultAPIBase, "/")
	}
	model = NormalizeModel(model)
	u := fmt.Sprintf("%s/v1beta/models/%s:generateContent?key=%s",
		base, url.PathEscape(model), url.QueryEscape(cfg.APIKey))

	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("gemini: invalid json (http %d): %w", resp.StatusCode, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if errObj, ok := out["error"].(map[string]any); ok {
			return nil, fmt.Errorf("gemini generateContent: %v", errObj["message"])
		}
		return nil, fmt.Errorf("gemini generateContent: http %d", resp.StatusCode)
	}
	return out, nil
}

func firstMap(m map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if sm, ok := v.(map[string]any); ok {
				return sm
			}
		}
	}
	return nil
}

func strFrom(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
	}
	return ""
}

func truthy(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true") || t == "1"
	default:
		return false
	}
}

// extractMediaFromResponseMap reads image parts from the raw generateContent JSON.
// Handles camelCase + snake_case (inlineData / inline_data) and optional file references (download via client).
func extractMediaFromResponseMap(ctx context.Context, c *genai.Client, root map[string]any) ([]MediaItem, string, error) {
	if root == nil {
		return nil, "", fmt.Errorf("empty response")
	}
	var media []MediaItem
	var texts []string

	cands, _ := root["candidates"].([]any)
	for _, ca := range cands {
		cmap, ok := ca.(map[string]any)
		if !ok {
			continue
		}
		content, _ := cmap["content"].(map[string]any)
		if content == nil {
			continue
		}
		parts, _ := content["parts"].([]any)
		for _, pt := range parts {
			pmap, ok := pt.(map[string]any)
			if !ok {
				continue
			}
			if txt := strFrom(pmap, "text"); txt != "" && !truthy(pmap, "thought") {
				texts = append(texts, txt)
			}
			if im := firstMap(pmap, "inlineData", "inline_data"); im != nil {
				dataStr := strFrom(im, "data")
				if dataStr != "" {
					mime := strFrom(im, "mimeType", "mime_type")
					if mime == "" {
						mime = "image/png"
					}
					media = append(media, MediaItem{MIMEType: mime, Data: dataStr})
				}
			}
			if fd := firstMap(pmap, "fileData", "file_data"); fd != nil && c != nil {
				uri := strFrom(fd, "fileUri", "file_uri")
				mime := strFrom(fd, "mimeType", "mime_type")
				if uri != "" {
					b, err := c.Files.Download(ctx, genai.NewDownloadURIFromFile(&genai.File{DownloadURI: uri}), nil)
					if err == nil && len(b) > 0 {
						if mime == "" {
							mime = "image/png"
						}
						media = append(media, MediaItem{
							MIMEType: mime,
							Data:     base64.StdEncoding.EncodeToString(b),
						})
					}
				}
			}
			// Vertex-style single field on the part
			if b64 := strFrom(pmap, "bytesBase64Encoded"); b64 != "" {
				mime := strFrom(pmap, "mimeType", "mime_type")
				if mime == "" {
					mime = "image/png"
				}
				media = append(media, MediaItem{MIMEType: mime, Data: b64})
			}
		}
	}
	if media == nil {
		media = []MediaItem{}
	}
	return media, strings.Join(texts, "\n"), nil
}

func buildGenerateImageRESTBody(prompt, aspectRatio string) map[string]any {
	gen := map[string]any{
		"responseModalities": []any{"TEXT", "IMAGE"},
	}
	if ar := strings.TrimSpace(aspectRatio); ar != "" {
		gen["imageConfig"] = map[string]any{"aspectRatio": ar}
	}
	return map[string]any{
		"contents": []any{
			map[string]any{
				"role": "user",
				"parts": []any{
					map[string]any{"text": strings.TrimSpace(prompt)},
				},
			},
		},
		"generationConfig": gen,
	}
}

func buildEditImageRESTBody(prompt string, imagesB64 []string, aspectRatio string) (map[string]any, error) {
	parts := []any{}
	if strings.TrimSpace(prompt) != "" {
		parts = append(parts, map[string]any{"text": strings.TrimSpace(prompt)})
	}
	for _, b64 := range imagesB64 {
		s := strings.TrimSpace(b64)
		if s == "" {
			continue
		}
		if i := strings.Index(s, ","); i > 0 && strings.HasPrefix(s[:i], "data:") {
			s = strings.TrimSpace(s[i+1:])
		}
		if _, err := base64.StdEncoding.DecodeString(s); err != nil {
			return nil, fmt.Errorf("invalid image base64: %w", err)
		}
		parts = append(parts, map[string]any{
			"inlineData": map[string]any{
				"mimeType": "image/png",
				"data":     s,
			},
		})
	}
	if len(parts) == 0 {
		return nil, fmt.Errorf("no prompt or images")
	}
	gen := map[string]any{
		"responseModalities": []any{"TEXT", "IMAGE"},
	}
	if ar := strings.TrimSpace(aspectRatio); ar != "" {
		gen["imageConfig"] = map[string]any{"aspectRatio": ar}
	}
	return map[string]any{
		"contents": []any{
			map[string]any{
				"role":  "user",
				"parts": parts,
			},
		},
		"generationConfig": gen,
	}, nil
}
