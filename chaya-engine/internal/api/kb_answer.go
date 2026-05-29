package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// RegisterKBAnswerRoutes wires the knowledge-base "answer with citations"
// endpoint. Given a query + the chunks the frontend already retrieved from
// Smartnote Cloud, it runs ONE LLM completion that synthesizes a grounded
// answer citing [N]. Provider-agnostic: uses the user's chosen LLM config
// (or any enabled one as fallback), same as chat followups.
func RegisterKBAnswerRoutes(r chi.Router, db *gorm.DB, reg *provider.Registry) {
	h := &kbAnswerAPI{db: db, reg: reg}
	r.Post("/api/kb/answer", h.answer)
}

type kbAnswerAPI struct {
	db  *gorm.DB
	reg *provider.Registry
}

type kbAnswerChunk struct {
	N            int    `json:"n"`             // citation index shown to the user
	DocumentName string `json:"document_name"` // source doc title
	Text         string `json:"text"`          // chunk body
}

type kbAnswerReq struct {
	Query    string          `json:"query"`
	Chunks   []kbAnswerChunk `json:"chunks"`
	ConfigID string          `json:"config_id"` // optional; preferred LLM config
}

func (a *kbAnswerAPI) answer(w http.ResponseWriter, r *http.Request) {
	var req kbAnswerReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid request body")
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		Fail(w, CodeBadRequest, "query required")
		return
	}
	if len(req.Chunks) == 0 {
		OK(w, M{"answer": "没有检索到相关内容，无法作答。"})
		return
	}

	prov, model, err := a.resolve(req.ConfigID)
	if err != nil || prov == nil {
		slog.Warn("kb answer: no provider", "err", err)
		Fail(w, CodeLLMError, "no LLM provider available")
		return
	}

	prompt := buildKBAnswerPrompt(query, req.Chunks)
	temp := 0.2
	resp, err := prov.Chat(r.Context(), provider.ChatRequest{
		Messages:    []provider.Message{{Role: "user", Content: prompt}},
		Model:       model,
		Temperature: &temp,
		MaxTokens:   1200,
	})
	if err != nil || resp == nil {
		slog.Warn("kb answer: llm call failed", "model", model, "err", err)
		Fail(w, CodeLLMError, "answer generation failed")
		return
	}
	OK(w, M{"answer": strings.TrimSpace(resp.Content)})
}

// resolve picks (provider, model): the requested config if usable, else any
// enabled config. Mirrors the followups fallback intent but single-shot.
func (a *kbAnswerAPI) resolve(configID string) (provider.LLMProvider, string, error) {
	if strings.TrimSpace(configID) != "" {
		var row provider.LLMConfigRow
		if err := a.db.Where("id = ? AND enabled = true", configID).First(&row).Error; err == nil {
			if p, err := a.reg.Get(configID); err == nil && p != nil {
				return p, row.Model, nil
			}
		}
	}
	return a.reg.GetAny()
}

func buildKBAnswerPrompt(query string, chunks []kbAnswerChunk) string {
	var b strings.Builder
	b.WriteString("你是知识库问答助手。仅根据下面提供的「资料片段」回答用户问题。\n")
	b.WriteString("要求：\n")
	b.WriteString("1. 答案必须基于资料，不要编造；资料不足时直说「资料中没有足够信息」。\n")
	b.WriteString("2. 在引用某条资料的句子末尾用 [N] 标注来源编号（N 为片段编号），可多条 [1][3]。\n")
	b.WriteString("3. 简洁、结构化，中文回答（除非问题是英文）。\n\n")
	b.WriteString("资料片段：\n")
	for _, c := range chunks {
		text := c.Text
		if len(text) > 1600 {
			text = text[:1600] + "…"
		}
		b.WriteString(fmt.Sprintf("[%d] 《%s》\n%s\n\n", c.N, c.DocumentName, text))
	}
	b.WriteString("用户问题：")
	b.WriteString(query)
	b.WriteString("\n\n请作答：")
	return b.String()
}
