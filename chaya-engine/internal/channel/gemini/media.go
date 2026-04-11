package gemini

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"google.golang.org/genai"
)

// MediaItem matches legacy HTTP JSON: mimeType + base64 data.
type MediaItem struct {
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"`
}

// GenerateImage uses generateContent with image modalities (same product behavior as legacy REST).
func GenerateImage(ctx context.Context, c *genai.Client, model, prompt, aspectRatio string) ([]MediaItem, string, error) {
	model = NormalizeModel(model)
	parts := []*genai.Part{genai.NewPartFromText(prompt)}
	contents := []*genai.Content{genai.NewContentFromParts(parts, genai.RoleUser)}
	cfg := &genai.GenerateContentConfig{
		ResponseModalities: []string{"TEXT", "IMAGE"},
	}
	if aspectRatio != "" {
		cfg.ImageConfig = &genai.ImageConfig{AspectRatio: aspectRatio}
	}
	resp, err := c.Models.GenerateContent(ctx, model, contents, cfg)
	if err != nil {
		return nil, "", err
	}
	return extractMediaAndText(resp)
}

// EditImage uses multimodal generateContent with reference images (legacy-compatible).
func EditImage(ctx context.Context, c *genai.Client, model, prompt string, imagesB64 []string, aspectRatio string) ([]MediaItem, string, error) {
	model = NormalizeModel(model)
	parts := []*genai.Part{}
	if strings.TrimSpace(prompt) != "" {
		parts = append(parts, genai.NewPartFromText(prompt))
	}
	for _, b64 := range imagesB64 {
		raw, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, "", fmt.Errorf("invalid image base64: %w", err)
		}
		parts = append(parts, genai.NewPartFromBytes(raw, "image/png"))
	}
	if len(parts) == 0 {
		return nil, "", fmt.Errorf("no prompt or images")
	}
	contents := []*genai.Content{genai.NewContentFromParts(parts, genai.RoleUser)}
	cfg := &genai.GenerateContentConfig{
		ResponseModalities: []string{"TEXT", "IMAGE"},
	}
	if aspectRatio != "" {
		cfg.ImageConfig = &genai.ImageConfig{AspectRatio: aspectRatio}
	}
	resp, err := c.Models.GenerateContent(ctx, model, contents, cfg)
	if err != nil {
		return nil, "", err
	}
	return extractMediaAndText(resp)
}

func extractMediaAndText(resp *genai.GenerateContentResponse) ([]MediaItem, string, error) {
	if resp == nil {
		return nil, "", fmt.Errorf("empty response")
	}
	var media []MediaItem
	var texts []string
	for _, cand := range resp.Candidates {
		if cand.Content == nil {
			continue
		}
		for _, p := range cand.Content.Parts {
			if p.Text != "" && !p.Thought {
				texts = append(texts, p.Text)
			}
			if p.InlineData != nil && len(p.InlineData.Data) > 0 {
				media = append(media, MediaItem{
					MIMEType: p.InlineData.MIMEType,
					Data:     base64.StdEncoding.EncodeToString(p.InlineData.Data),
				})
			}
		}
	}
	if media == nil {
		media = []MediaItem{}
	}
	return media, strings.Join(texts, "\n"), nil
}
