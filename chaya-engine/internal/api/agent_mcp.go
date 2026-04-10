package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

// AgentMCPAPI handles /api/agents/{id}/mcp-servers
type AgentMCPAPI struct {
	db          *gorm.DB
	mcpRegistry *mcp.Registry // to auto-connect servers on bind
}

// RegisterAgentMCPRoutes mounts agent-MCP binding endpoints.
// mcpRegistry may be nil (no auto-connect side-effect).
func RegisterAgentMCPRoutes(r chi.Router, db *gorm.DB, mcpRegistry *mcp.Registry) {
	a := &AgentMCPAPI{db: db, mcpRegistry: mcpRegistry}
	r.Get("/api/agents/{agentId}/mcp-servers", a.list)
	r.Post("/api/agents/{agentId}/mcp-servers", a.bind)
	r.Delete("/api/agents/{agentId}/mcp-servers/{mcpId}", a.unbind)
}

// list returns all MCP servers bound to the agent (with full server details).
func (a *AgentMCPAPI) list(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	agentID := chi.URLParam(r, "agentId")

	if !agentBelongsToTenant(a.db, agentID, tenantID) {
		Fail(w, CodeNotFound, "agent not found")
		return
	}

	type row struct {
		MCPServerID string `gorm:"column:mcp_server_id"`
	}
	var rows []row
	a.db.Table("agent_mcp_servers").Where("agent_id = ?", agentID).Find(&rows)

	if len(rows) == 0 {
		OK(w, []any{})
		return
	}

	ids := make([]string, 0, len(rows))
	for _, rr := range rows {
		ids = append(ids, rr.MCPServerID)
	}

	var servers []pgstore.MCPServer
	a.db.Where("id IN ? AND tenant_id = ?", ids, tenantID).Find(&servers)

	out := make([]map[string]any, 0, len(servers))
	for _, s := range servers {
		out = append(out, mcpServerJSON(s))
	}
	OK(w, out)
}

// bind adds an MCP server to the agent's harness scope.
// Body: {"mcp_server_id": "<uuid>"}
// Side-effect: ensures the server connection is live in the registry.
func (a *AgentMCPAPI) bind(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	agentID := chi.URLParam(r, "agentId")

	if !agentBelongsToTenant(a.db, agentID, tenantID) {
		Fail(w, CodeNotFound, "agent not found")
		return
	}

	var req struct {
		MCPServerID string `json:"mcp_server_id"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	if req.MCPServerID == "" {
		Fail(w, CodeInvalidParam, "mcp_server_id 必填")
		return
	}

	// Verify MCP server belongs to same tenant
	var s pgstore.MCPServer
	if err := a.db.Where("id = ? AND tenant_id = ?", req.MCPServerID, tenantID).First(&s).Error; err != nil {
		Fail(w, CodeNotFound, "mcp server not found")
		return
	}

	binding := pgstore.AgentMCPServer{AgentID: agentID, MCPServerID: req.MCPServerID}
	// ON CONFLICT DO NOTHING
	if err := a.db.Where(pgstore.AgentMCPServer{AgentID: agentID, MCPServerID: req.MCPServerID}).
		FirstOrCreate(&binding).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	// Auto-connect: make sure the registry has a live client for this server
	if a.mcpRegistry != nil {
		var cfg mcp.ServerConfig
		cfg.ID = s.ID
		cfg.TenantID = s.TenantID
		cfg.Name = s.Name
		cfg.URL = s.URL
		cfg.Type = s.Type
		cfg.Config = s.Config
		cfg.Enabled = s.Enabled
		cfg.Healthy = s.Healthy
		go a.mcpRegistry.EnsureClient(context.Background(), cfg)
	}

	OK(w, M{"ok": true, "agent_id": agentID, "mcp_server_id": req.MCPServerID})
}

// unbind removes an MCP server from the agent's harness scope.
func (a *AgentMCPAPI) unbind(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	agentID := chi.URLParam(r, "agentId")
	mcpID := chi.URLParam(r, "mcpId")

	if !agentBelongsToTenant(a.db, agentID, tenantID) {
		Fail(w, CodeNotFound, "agent not found")
		return
	}

	a.db.Where("agent_id = ? AND mcp_server_id = ?", agentID, mcpID).
		Delete(&pgstore.AgentMCPServer{})
	OK(w, M{"ok": true})
}
