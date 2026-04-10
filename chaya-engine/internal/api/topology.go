package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/intelligence/topology"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type TopologyAPI struct {
	db  *gorm.DB
	reg *provider.Registry
}

func RegisterTopologyRoutes(r chi.Router, db *gorm.DB, reg *provider.Registry) {
	a := &TopologyAPI{db: db, reg: reg}
	r.Get("/api/agents/{id}/topology", a.getGraph)
	r.Get("/api/agents/{id}/topology/traces", a.getTraces)
	r.Post("/api/agents/{id}/topology/rebuild", a.rebuild)
}

func (a *TopologyAPI) getGraph(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	if !agentAccessForUser(a.db, agentID, userID, tenantID) {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var record topology.TopologyRecord
	if err := a.db.Where("agent_id = ?", agentID).First(&record).Error; err != nil {
		OK(w, M{"graph": M{}, "nodes": []any{}, "edges": []any{}, "paths": []any{}, "version": 0})
		return
	}
	OK(w, M{
		"graph":    record.GraphRaw,
		"version":  record.Version,
		"built_at": record.BuiltAt,
		"summary":  record.Summary,
	})
}

func (a *TopologyAPI) getTraces(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	if !agentAccessForUser(a.db, agentID, userID, tenantID) {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var traces []topology.InteractionTrace
	a.db.Where("agent_id = ?", agentID).Order("created_at desc").Limit(50).Find(&traces)
	OK(w, traces)
}

func (a *TopologyAPI) rebuild(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userID := middleware.UserID(ctx)
	tenantID := middleware.TenantID(ctx)
	agentID := chi.URLParam(r, "id")

	if a.reg == nil {
		Fail(w, CodeInternal, "provider registry unavailable")
		return
	}

	if !agentAccessForUser(a.db, agentID, userID, tenantID) {
		Fail(w, CodeNotFound, "agent not found")
		return
	}

	llm, model, err := a.resolveAgentLLM(agentID)
	if err != nil {
		Fail(w, CodeInvalidParam, err.Error())
		return
	}

	mgr := topology.NewManager(a.db, agentID)
	temp := 0.22
	err = mgr.Consolidate(func(prompt string) (string, error) {
		cctx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		resp, err := llm.Chat(cctx, provider.ChatRequest{
			Messages: []provider.Message{
				{Role: "system", Content: "You reply with a single JSON object only. No markdown fences."},
				{Role: "user", Content: prompt},
			},
			Model:       model,
			Temperature: &temp,
		})
		if err != nil {
			return "", err
		}
		if resp == nil {
			return "", fmt.Errorf("empty LLM response")
		}
		return resp.Content, nil
	})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "no recent traces") {
			Fail(w, CodeInvalidParam, msg)
			return
		}
		Fail(w, CodeLLMError, msg)
		return
	}

	var rec topology.TopologyRecord
	_ = a.db.Where("agent_id = ?", agentID).First(&rec).Error
	OK(w, M{"status": "ok", "agent_id": agentID, "version": rec.Version, "built_at": rec.BuiltAt})
}

func (a *TopologyAPI) resolveAgentLLM(agentID string) (provider.LLMProvider, string, error) {
	var row struct {
		LLMConfigID string `gorm:"column:llm_config_id"`
	}
	err := a.db.Table("agents").
		Select("config ->> 'llm_config_id' AS llm_config_id").
		Where("id = ?", agentID).
		Scan(&row).Error
	if err != nil {
		return nil, "", err
	}
	cfgID := strings.TrimSpace(row.LLMConfigID)
	if cfgID == "" {
		return nil, "", fmt.Errorf("agent has no llm_config_id in config")
	}
	llm, err := a.reg.Get(cfgID)
	if err != nil {
		return nil, "", err
	}
	var mrow provider.LLMConfigRow
	model := ""
	if a.db.Where("id = ? AND enabled = true", cfgID).First(&mrow).Error == nil {
		model = mrow.Model
	}
	return llm, model, nil
}
