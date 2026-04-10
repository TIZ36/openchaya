package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

type MCPAPI struct {
	db          *gorm.DB
	mcpRegistry *mcp.Registry
}

func RegisterMCPRoutes(r chi.Router, db *gorm.DB, mcpRegistry *mcp.Registry) {
	a := &MCPAPI{db: db, mcpRegistry: mcpRegistry}
	r.Get("/api/mcp/servers", a.list)
	r.Post("/api/mcp/servers", a.create)
	r.Put("/api/mcp/servers/{id}", a.update)
	r.Delete("/api/mcp/servers/{id}", a.del)
}

func (a *MCPAPI) list(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var servers []pgstore.MCPServer
	a.db.Where("tenant_id = ?", tenantID).Find(&servers)
	out := make([]map[string]any, 0, len(servers))
	for _, s := range servers {
		out = append(out, mcpServerJSON(s))
	}
	OK(w, out)
}

func (a *MCPAPI) create(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	body, err := io.ReadAll(r.Body)
	if err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}

	name, _ := raw["name"].(string)
	urlStr, _ := raw["url"].(string)
	if name == "" || urlStr == "" {
		Fail(w, CodeInvalidParam, "name 与 url 必填")
		return
	}
	if err := validateMCPURL(urlStr); err != nil {
		Fail(w, CodeInvalidParam, err.Error())
		return
	}

	cfg, err := mergeMCPConfigFromPayload(raw)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	s := pgstore.MCPServer{
		TenantID: tenantID,
		Name:     name,
		URL:      urlStr,
		Type:     "http",
		Enabled:  true,
		Healthy:  true,
		Config:   cfg,
	}
	if v, ok := raw["type"].(string); ok && v != "" {
		s.Type = v
	}
	if v, ok := raw["enabled"].(bool); ok {
		s.Enabled = v
	}
	if v, ok := raw["healthy"].(bool); ok {
		s.Healthy = v
	}

	if err := a.db.Create(&s).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	// Auto-connect: immediately wire the new server into the engine registry
	a.autoConnect(s)

	OK(w, mcpServerJSON(s))
}

func (a *MCPAPI) update(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")

	body, err := io.ReadAll(r.Body)
	if err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}

	var existing pgstore.MCPServer
	if err := a.db.Where("id = ? AND tenant_id = ?", id, tenantID).First(&existing).Error; err != nil {
		Fail(w, CodeNotFound, "mcp server not found")
		return
	}

	mergedCfg, err := mergeMCPConfigUpdate(existing.Config, raw)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	updates := map[string]any{"config": mergedCfg}
	if v, ok := raw["name"].(string); ok && v != "" {
		updates["name"] = v
	}
	if v, ok := raw["url"].(string); ok && v != "" {
		if err := validateMCPURL(v); err != nil {
			Fail(w, CodeInvalidParam, err.Error())
			return
		}
		updates["url"] = v
	}
	if v, ok := raw["type"].(string); ok && v != "" {
		updates["type"] = v
	}
	if v, ok := raw["enabled"].(bool); ok {
		updates["enabled"] = v
	}
	if v, ok := raw["healthy"].(bool); ok {
		updates["healthy"] = v
	}

	if err := a.db.Model(&pgstore.MCPServer{}).Where("id = ? AND tenant_id = ?", id, tenantID).Updates(updates).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	var s pgstore.MCPServer
	a.db.Where("id = ?", id).First(&s)

	if a.mcpRegistry != nil && !s.Enabled {
		a.mcpRegistry.RemoveServer(id)
	} else {
		// Re-connect if URL/enabled changed
		a.autoConnect(s)
	}

	OK(w, mcpServerJSON(s))
}

func (a *MCPAPI) del(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")
	a.db.Where("mcp_server_id = ?", id).Delete(&pgstore.AgentMCPServer{})
	a.db.Where("id = ? AND tenant_id = ?", id, tenantID).Delete(&pgstore.MCPServer{})
	if a.mcpRegistry != nil {
		a.mcpRegistry.RemoveServer(id)
	}
	OK(w, M{"ok": true})
}

func (a *MCPAPI) autoConnect(s pgstore.MCPServer) {
	if a.mcpRegistry == nil || !s.Enabled {
		return
	}
	go a.mcpRegistry.EnsureClient(context.Background(), mcp.ServerConfig{
		ID:       s.ID,
		TenantID: s.TenantID,
		Name:     s.Name,
		URL:      s.URL,
		Type:     s.Type,
		Config:   s.Config,
		Enabled:  s.Enabled,
		Healthy:  s.Healthy,
	})
}
