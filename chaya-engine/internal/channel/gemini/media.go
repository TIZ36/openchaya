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

// RewritePrompt expands a short user idea into a rich paragraph for
// gemini-2.5-flash-image, following Google's official prompting guide
// (https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana).
// Uses a cheap text model (gemini-2.5-flash) behind the scenes. On any
// failure (timeout, quota, safety refusal) the caller should fall back to
// the original user prompt.
func RewritePrompt(ctx context.Context, c *genai.Client, model, userPrompt, aspectRatio string) (string, error) {
	if model == "" {
		model = "gemini-2.5-flash"
	}
	meta := "You rewrite short image ideas into ONE rich English paragraph " +
		"for gemini-2.5-flash-image. Keep the user's intent and any named " +
		"style or artist. Fill these slots as natural prose (70-110 words, " +
		"one paragraph, no bullets, no headings): Subject + action, " +
		"Environment, Medium/style, Lighting, Composition and camera/lens, " +
		"Mood, then 2-3 concrete sensory details.\n\n" +
		"Rules:\n" +
		"- Narrative prose, never keyword lists.\n" +
		"- Positive framing only; never write \"no X\" or \"without X\".\n" +
		"- Mirror the target aspect ratio verbally (e.g. \"vertical portrait " +
		"composition\" for 9:16, \"wide cinematic framing\" for 16:9).\n" +
		"- Do not add \"8k\", \"masterpiece\", \"trending on artstation\", " +
		"\"award winning\" — they hurt this model.\n" +
		"- Keep any proper nouns / artist names the user wrote.\n" +
		"- Output the paragraph only.\n\n" +
		"Aspect ratio: " + aspectRatio + "\n" +
		"User idea: " + userPrompt
	body := map[string]any{
		"contents": []any{
			map[string]any{
				"role":  "user",
				"parts": []any{map[string]any{"text": meta}},
			},
		},
		"generationConfig": map[string]any{
			"responseModalities": []any{"TEXT"},
			"temperature":        0.7,
			"maxOutputTokens":    400,
		},
	}
	cfg := c.ClientConfig()
	raw, err := generateContentRESTMap(ctx, cfg, model, body)
	if err != nil {
		return "", err
	}
	_, text, err := extractMediaFromResponseMap(ctx, c, raw)
	if err != nil {
		return "", err
	}
	return text, nil
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
