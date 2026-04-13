package gemini

import (
	"context"

	"google.golang.org/genai"
)

// MediaItem matches legacy HTTP JSON: mimeType + base64 data.
type MediaItem struct {
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"`
}

// GenerateImage uses generateContent (REST) with image modalities.
// Parses the JSON map directly so inline_data / file_data shapes are not dropped by struct unmarshaling.
func GenerateImage(ctx context.Context, c *genai.Client, model, prompt, aspectRatio string) ([]MediaItem, string, error) {
	model = NormalizeModel(model)
	cfg := c.ClientConfig()
	body := buildGenerateImageRESTBody(prompt, aspectRatio)
	raw, err := generateContentRESTMap(ctx, cfg, model, body)
	if err != nil {
		return nil, "", err
	}
	return extractMediaFromResponseMap(ctx, c, raw)
}

// EditImage uses multimodal generateContent (REST) with reference images (legacy-compatible).
func EditImage(ctx context.Context, c *genai.Client, model, prompt string, imagesB64 []string, aspectRatio string) ([]MediaItem, string, error) {
	model = NormalizeModel(model)
	body, err := buildEditImageRESTBody(prompt, imagesB64, aspectRatio)
	if err != nil {
		return nil, "", err
	}
	cfg := c.ClientConfig()
	raw, err := generateContentRESTMap(ctx, cfg, model, body)
	if err != nil {
		return nil, "", err
	}
	return extractMediaFromResponseMap(ctx, c, raw)
}
