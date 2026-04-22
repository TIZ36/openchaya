package gemini

import (
	"context"
	"encoding/json"
	"strings"

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

// SuggestFollowups reads the latest user+assistant turn and asks
// gemini-2.5-flash for a few natural follow-up prompts the user might want
// to send next. Tiny call (~400 tokens out), cheap and async. Failure
// returns an empty list — the caller treats it as "no suggestions".
func SuggestFollowups(ctx context.Context, c *genai.Client, model, userMsg, assistantMsg string) ([]string, error) {
	if model == "" {
		model = "gemini-2.5-flash"
	}
	meta := `You are a conversation UX helper. Given the last turn between a user and an AI assistant, propose 3 natural follow-up prompts the user is MOST likely to want next.

Rules:
- Match the language of the user's last message (中文 → 中文, English → English).
- Each suggestion ≤ 15 words / 20 chars. Conversational phrasing, first-person from the user.
- Must extend the thread forward — clarify, drill down, or ask for an obvious next step. Never repeat the user's own question.
- No greetings, no emojis, no numbering.
- Output ONLY a JSON array of strings like ["...", "...", "..."]. No prose, no markdown fence.

Last user message:
"""` + userMsg + `"""

Last assistant reply:
"""` + assistantMsg + `"""`
	body := map[string]any{
		"contents": []any{
			map[string]any{
				"role":  "user",
				"parts": []any{map[string]any{"text": meta}},
			},
		},
		"generationConfig": map[string]any{
			"responseModalities": []any{"TEXT"},
			"temperature":        0.6,
			"maxOutputTokens":    200,
		},
	}
	cfg := c.ClientConfig()
	raw, err := generateContentRESTMap(ctx, cfg, model, body)
	if err != nil {
		return nil, err
	}
	_, text, err := extractMediaFromResponseMap(ctx, c, raw)
	if err != nil {
		return nil, err
	}
	return parseFollowupJSON(text), nil
}

// parseFollowupJSON is forgiving: some models wrap the array in ```json fences
// or emit a trailing period. We extract the outermost [...] and parse.
func parseFollowupJSON(text string) []string {
	i := strings.Index(text, "[")
	j := strings.LastIndex(text, "]")
	if i < 0 || j <= i {
		return nil
	}
	var arr []string
	if err := json.Unmarshal([]byte(text[i:j+1]), &arr); err != nil {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, s := range arr {
		s = strings.TrimSpace(s)
		if s != "" && len([]rune(s)) <= 40 {
			out = append(out, s)
		}
		if len(out) >= 3 {
			break
		}
	}
	return out
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
