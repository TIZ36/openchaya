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
	sugs := GenerateFollowupsWithFallback(r.Context(), a.reg, req.ConfigID, user, assistant)
	OK(w, M{"suggestions": sugs})
}

// GenerateFollowupsWithFallback walks a ranked provider chain (cheap
// non-reasoning preferred, agent's own provider as last resort) until one
// returns a parseable list. Each candidate gets a budget appropriate to
// its kind: 120 tokens for direct models, 800 for reasoning models that
// must spend most of their allowance on hidden thinking.
//
// Why a chain at all: the agent's primary LLM is often a reasoning model
// (DeepSeek-Reasoner / Qwen-thinking) where MaxTokens=120 leaves zero
// room for actual content — the call returns "" and the user gets no
// suggestion chips. Falling back to a plain chat model is faster AND
// more reliable for this kind of one-shot lightweight task.
func GenerateFollowupsWithFallback(ctx context.Context, reg *provider.Registry, preferredID, userMsg, assistantMsg string) []string {
	if reg == nil || strings.TrimSpace(assistantMsg) == "" {
		return []string{}
	}
	chain := reg.FollowupChain(preferredID)
	if len(chain) == 0 {
		// Last-ditch: any enabled provider.
		if p, model, err := reg.GetAny(); err == nil && p != nil {
			chain = []provider.FallbackCandidate{{Provider: p, Model: model, Reasoning: provider.IsReasoningModel(model)}}
		}
	}
	for i, cand := range chain {
		budget := 120
		if cand.Reasoning {
			// Reasoning models spend MaxTokens on hidden thinking first,
			// content second. Need enough headroom for ~60 visible tokens
			// of suggestions on top of the thinking budget.
			budget = 800
		}
		sugs := callFollowup(ctx, cand.Provider, cand.Model, userMsg, assistantMsg, budget)
		if len(sugs) > 0 {
			if i > 0 {
				slog.Info("followups: fallback hit", "rank", i, "config", cand.ConfigID, "model", cand.Model)
			}
			return sugs
		}
	}
	return []string{}
}

// callFollowup runs the actual one-shot call. Empty slice on any failure
// — caller's job to try the next candidate in the chain.
func callFollowup(ctx context.Context, prov provider.LLMProvider, model, userMsg, assistantMsg string, maxTokens int) []string {
	if prov == nil {
		return []string{}
	}
	temp := 0.0
	resp, err := prov.Chat(ctx, provider.ChatRequest{
		Messages:    []provider.Message{{Role: "user", Content: buildFollowupPrompt(userMsg, assistantMsg)}},
		Model:       model,
		Temperature: &temp,
		MaxTokens:   maxTokens,
	})
	if err != nil || resp == nil {
		slog.Warn("followups: llm call failed", "model", model, "err", err)
		return []string{}
	}
	sugs := parseFollowupList(resp.Content)
	if len(sugs) == 0 {
		raw := resp.Content
		if len(raw) > 400 {
			raw = raw[:400] + "…"
		}
		slog.Info("followups: parsed 0 from model output", "model", model, "raw", raw, "reasoning_len", len(resp.Reasoning))
	}
	return sugs
}

// GenerateFollowups is the legacy single-provider entry point kept for the
// actor's in-process path. New code should use GenerateFollowupsWithFallback.
func GenerateFollowups(ctx context.Context, prov provider.LLMProvider, model, userMsg, assistantMsg string) []string {
	if prov == nil || strings.TrimSpace(assistantMsg) == "" {
		return []string{}
	}
	maxTokens := 120
	if provider.IsReasoningModel(model) {
		maxTokens = 800
	}
	return callFollowup(ctx, prov, model, userMsg, assistantMsg, maxTokens)
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
