package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// RegisterChatFollowupRoutes wires the provider-agnostic "suggest N follow-up
// prompts" endpoint. Uses the user's own LLM config (whatever provider) so
// the feature works regardless of whether they've configured Gemini.
func RegisterChatFollowupRoutes(r chi.Router, db *gorm.DB, reg *provider.Registry) {
	h := &chatFollowupAPI{db: db, reg: reg}
	r.Post("/api/chat/followups", h.followups)
}

type chatFollowupAPI struct {
	db  *gorm.DB
	reg *provider.Registry
}

type chatFollowupsReq struct {
	UserMessage      string `json:"user_message"`
	AssistantMessage string `json:"assistant_message"`
	ConfigID         string `json:"config_id"`
	Model            string `json:"model"`
}

func (a *chatFollowupAPI) followups(w http.ResponseWriter, r *http.Request) {
	var req chatFollowupsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	assistant := strings.TrimSpace(req.AssistantMessage)
	user := strings.TrimSpace(req.UserMessage)
	if assistant == "" {
		OK(w, M{"suggestions": []string{}})
		return
	}

	// Resolve provider. Prefer the explicit config_id (frontend sends the
	// agent's own config), fall back to any available provider so the feature
	// gracefully degrades instead of silently producing nothing.
	var prov provider.LLMProvider
	var err error
	if req.ConfigID != "" {
		prov, err = a.reg.Get(req.ConfigID)
	}
	if prov == nil || err != nil {
		prov, _, err = a.reg.GetAny()
	}
	if prov == nil || err != nil {
		OK(w, M{"suggestions": []string{}, "note": "no llm provider"})
		return
	}

	sugs := GenerateFollowups(r.Context(), prov, req.Model, user, assistant)
	OK(w, M{"suggestions": sugs})
}

// GenerateFollowups runs the suggest-3-prompts call against the given provider
// and returns the parsed list. Caps output (MaxTokens=120, Temperature=0) so
// the call returns in well under a second on most providers — important
// because this fires on every assistant turn and the chips need to land
// promptly after stream_done. Empty slice on any failure (best-effort).
func GenerateFollowups(ctx context.Context, prov provider.LLMProvider, model, userMsg, assistantMsg string) []string {
	if prov == nil || strings.TrimSpace(assistantMsg) == "" {
		return []string{}
	}
	temp := 0.0
	prompt := buildFollowupPrompt(userMsg, assistantMsg)
	resp, err := prov.Chat(ctx, provider.ChatRequest{
		Messages:    []provider.Message{{Role: "user", Content: prompt}},
		Model:       model,
		Temperature: &temp,
		MaxTokens:   120,
	})
	if err != nil || resp == nil {
		slog.Warn("followups: llm call failed", "err", err)
		return []string{}
	}
	sugs := parseFollowupList(resp.Content)
	if len(sugs) == 0 {
		raw := resp.Content
		if len(raw) > 400 {
			raw = raw[:400] + "…"
		}
		slog.Info("followups: parsed 0 from model output", "raw", raw)
	}
	return sugs
}

func buildFollowupPrompt(userMsg, assistantMsg string) string {
	const maxUser = 800
	const maxAsst = 2400
	if len(userMsg) > maxUser {
		userMsg = userMsg[:maxUser]
	}
	if len(assistantMsg) > maxAsst {
		assistantMsg = assistantMsg[:maxAsst]
	}
	return "You propose follow-up user prompts for a conversation UI.\n\n" +
		"Given the last turn, emit 3 natural follow-ups the user is most likely to want to send NEXT.\n\n" +
		"Rules:\n" +
		"- Language: match the user's last message (中文 → 中文, English → English).\n" +
		"- Each suggestion ≤ 15 words / 20 汉字. First-person from the user, conversational.\n" +
		"- Extend the thread forward — clarify, drill down, or an obvious next step. Never repeat the user's own question.\n" +
		"- No greetings, no emojis, no numbering, no \"maybe\".\n" +
		"- Output ONLY a JSON array of strings. No prose, no code fences.\n\n" +
		"Last user message:\n\"\"\"" + userMsg + "\"\"\"\n\n" +
		"Last assistant reply:\n\"\"\"" + assistantMsg + "\"\"\""
}

// parseFollowupList is a forgiving parser. Tries, in order:
//  1. JSON array inside [...] (tolerates code fences + trailing commas)
//  2. Newline-split fallback — strips numbering / bullets / quotes.
// Deepseek and OpenAI sometimes ignore the "JSON only" instruction and return
// prose or numbered lists; we accept both.
func parseFollowupList(text string) []string {
	if s := parseFollowupJSON(text); len(s) > 0 {
		return s
	}
	return parseFollowupLines(text)
}

func parseFollowupJSON(text string) []string {
	i := strings.Index(text, "[")
	j := strings.LastIndex(text, "]")
	if i < 0 || j <= i {
		return nil
	}
	raw := text[i : j+1]
	// Strip trailing commas before `]` or `,` — common LLM artifact.
	raw = trailingCommaRe.ReplaceAllString(raw, "$1")
	var arr []string
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return nil
	}
	return trimAndCap(arr)
}

var (
	trailingCommaRe = regexp.MustCompile(`,(\s*[\]\}])`)
	numberingRe     = regexp.MustCompile(`^\s*(?:[-*•·]|\d+[\.\):、]|[（(]\d+[)）])\s+`)
)

func parseFollowupLines(text string) []string {
	lines := strings.Split(text, "\n")
	cleaned := make([]string, 0, len(lines))
	for _, ln := range lines {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		// Skip headings / fences / blatant prose.
		if strings.HasPrefix(ln, "#") || strings.HasPrefix(ln, "```") {
			continue
		}
		ln = numberingRe.ReplaceAllString(ln, "")
		ln = strings.Trim(ln, `"'"" `)
		if ln == "" || len([]rune(ln)) > 60 {
			continue
		}
		cleaned = append(cleaned, ln)
	}
	return trimAndCap(cleaned)
}

func trimAndCap(arr []string) []string {
	out := make([]string, 0, len(arr))
	seen := map[string]struct{}{}
	for _, s := range arr {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		if len([]rune(s)) > 60 {
			continue
		}
		out = append(out, s)
		if len(out) >= 3 {
			break
		}
	}
	return out
}
