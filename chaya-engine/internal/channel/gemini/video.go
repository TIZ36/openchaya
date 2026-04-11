package gemini

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"google.golang.org/genai"
)

// VideoSubmit starts long-running video generation (Veo-style).
func VideoSubmit(ctx context.Context, c *genai.Client, model, prompt, imageB64 string) (taskName string, usedModel string, err error) {
	model = NormalizeModel(model)
	var img *genai.Image
	if strings.TrimSpace(imageB64) != "" {
		raw, decErr := base64.StdEncoding.DecodeString(strings.TrimSpace(imageB64))
		if decErr != nil {
			return "", model, fmt.Errorf("invalid image base64: %w", decErr)
		}
		img = &genai.Image{ImageBytes: raw, MIMEType: "image/png"}
	}
	op, err := c.Models.GenerateVideos(ctx, model, strings.TrimSpace(prompt), img, nil)
	if err != nil {
		return "", model, err
	}
	if op == nil || op.Name == "" {
		return "", model, fmt.Errorf("video: empty operation name")
	}
	return op.Name, model, nil
}

// VideoPollStatus returns a map matching legacy /api/media/gemini/video/status responses.
func VideoPollStatus(ctx context.Context, c *genai.Client, operationName string) (map[string]any, error) {
	op := &genai.GenerateVideosOperation{Name: operationName}
	cur, err := c.Operations.GetVideosOperation(ctx, op, nil)
	if err != nil {
		return nil, err
	}
	if cur == nil {
		return nil, fmt.Errorf("video: nil operation")
	}
	if cur.Error != nil {
		msg := ""
		if m, ok := cur.Error["message"].(string); ok && m != "" {
			msg = m
		} else if b, e := json.Marshal(cur.Error); e == nil {
			msg = string(b)
		}
		return map[string]any{"status": "FAILED", "error": msg}, nil
	}
	if !cur.Done {
		progress := 0.0
		if cur.Metadata != nil {
			if v, ok := cur.Metadata["progress"].(float64); ok {
				progress = v
			}
		}
		return map[string]any{"status": "PROCESSING", "progress": progress}, nil
	}
	videoURI := ""
	if cur.Response != nil && len(cur.Response.GeneratedVideos) > 0 && cur.Response.GeneratedVideos[0].Video != nil {
		videoURI = cur.Response.GeneratedVideos[0].Video.URI
	}
	return map[string]any{"status": "SUCCEEDED", "output": videoURI, "progress": 100}, nil
}

// VideoDownload streams video bytes using the SDK when possible, otherwise HTTPS with API key.
func VideoDownload(ctx context.Context, c *genai.Client, videoURI string, w http.ResponseWriter) error {
	videoURI = strings.TrimSpace(videoURI)
	if videoURI == "" {
		return fmt.Errorf("video_uri is required")
	}
	if c.ClientConfig().Backend == genai.BackendGeminiAPI {
		v := &genai.Video{URI: videoURI}
		data, err := c.Files.Download(ctx, genai.NewDownloadURIFromVideo(v), nil)
		if err == nil && len(data) > 0 {
			w.Header().Set("Content-Type", "video/mp4")
			w.WriteHeader(http.StatusOK)
			_, err = w.Write(data)
			return err
		}
	}
	key := c.ClientConfig().APIKey
	u := videoURI
	if key != "" {
		sep := "?"
		if strings.Contains(u, "?") {
			sep = "&"
		}
		u = u + sep + "key=" + url.QueryEscape(key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 300 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("video download failed (HTTP %d)", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "video/mp4"
	}
	w.Header().Set("Content-Type", ct)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.WriteHeader(http.StatusOK)
	_, err = io.Copy(w, resp.Body)
	return err
}
