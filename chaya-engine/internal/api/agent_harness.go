package api

import (
	"context"
	"net/http"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// AgentHarnessAPI exposes harness status for UI (nameplate: MCP / Skill / KB).
type AgentHarnessAPI struct {
	db          *gorm.DB
	mcpRegistry *mcp.Registry
}

func RegisterAgentHarnessRoutes(r chi.Router, db *gorm.DB, mcpReg *mcp.Registry) {
	a := &AgentHarnessAPI{db: db, mcpRegistry: mcpReg}
	r.Get("/api/agents/{id}/harness-status", a.status)
}

// GET /api/agents/{id}/harness-status — bound MCP servers, tool count, skills, KB docs.
func (a *AgentHarnessAPI) status(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())

	tenantID := middleware.TenantID(r.Context())
	if !agentAccessForUser(a.db, agentID, userID, tenantID) {
		Fail(w, CodeNotFound, "not found")
		return
	}

	var mcpBound int64
	a.db.Table("agent_mcp_servers").Where("agent_id = ?", agentID).Count(&mcpBound)

	var skillBound int64
	a.db.Table("agent_skills").Where("agent_id = ?", agentID).Count(&skillBound)

	var kbReady, kbProcessing int64
	a.db.Table("kb_documents").Where("agent_id = ? AND status = ?", agentID, "ready").Count(&kbReady)
	a.db.Table("kb_documents").Where("agent_id = ? AND status = ?", agentID, "processing").Count(&kbProcessing)

	mcpToolCount := 0
	if a.mcpRegistry != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		tools := a.mcpRegistry.ListToolsForAgent(ctx, agentID, 3*time.Second, userID, middleware.TenantID(r.Context()))
		cancel()
		mcpToolCount = len(tools)
	}

	OK(w, M{
		"mcp_servers_bound": mcpBound,
		"mcp_tool_count":    mcpToolCount,
		"skills_bound":      skillBound,
		"kb_docs_ready":     kbReady,
		"kb_docs_processing": kbProcessing,
	})
}
