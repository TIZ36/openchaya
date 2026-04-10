package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

const capabilitySystemExtra = `
【能力配置模式】你是 Chaya 的能力配置执行器。仅使用内置 chaya_* 工具在数据库中新建 MCP 配置、绑定 MCP 或 Skill 到「非主助手」（custom agent）。主助手（Primary）已可见租户内全部 MCP 与 Skill，无需绑定。
新建 MCP 用 chaya_create_mcp_server（默认直连 http_stream；仅当资源方要求 OAuth 时设 is_http_oauth=true，并提示用户到前端「MCP」完成授权，可再调 chaya_notify_mcp_oauth）。绑定前用 chaya_list_* 查 id，勿编造 UUID。`

// capabilitySetupTools returns builtin tools for delegation task_kind=capability_setup.
func capabilitySetupTools(s *SubActor, convID string) []pkg.Tool {
	tid := tenantIDForUser(s.DB, s.UserID)
	return []pkg.Tool{
		{
			Name:        "chaya_list_custom_agents",
			Description: "列出当前账号下可配置的非主助手（不含 Primary）。返回 id、name。",
			Parameters:  json.RawMessage(`{"type":"object","properties":{}}`),
			Source:      "builtin",
			ExecuteFn:   func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) { return chayaListCustomAgents(ctx, s, tid) },
		},
		{
			Name:        "chaya_list_mcp_servers",
			Description: "列出当前租户已配置的 MCP 服务器（id、name、url）。",
			Parameters:  json.RawMessage(`{"type":"object","properties":{}}`),
			Source:      "builtin",
			ExecuteFn:   func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) { return chayaListMCPServers(ctx, s, tid) },
		},
		{
			Name:        "chaya_list_skills",
			Description: "列出当前租户下的技能（id、name）。",
			Parameters:  json.RawMessage(`{"type":"object","properties":{}}`),
			Source:      "builtin",
			ExecuteFn:   func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) { return chayaListSkills(ctx, s, tid) },
		},
		{
			Name:        "chaya_create_mcp_server",
			Description: "在租户下新建 MCP 服务器配置（与前端 MCP 页「添加」等效）：写入 mcp_servers 并注册连接。默认 is_http_oauth=false（HTTP Stream，直连 JSON-RPC/SSE）；OAuth 类 MCP 设 is_http_oauth=true 并引导用户在前端完成授权。",
			Parameters: json.RawMessage(`{"type":"object","properties":{
				"name":{"type":"string","description":"显示名称"},
				"url":{"type":"string","description":"MCP 端点 URL，须 http:// 或 https://"},
				"description":{"type":"string","description":"可选说明"},
				"is_http_oauth":{"type":"boolean","description":"是否为 HTTP OAuth 资源服务器（与前端「HTTP OAuth」一致；true 时须用户在前端授权后才可用工具）"}
			},"required":["name","url"]}`),
			Source: "builtin",
			ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
				return chayaCreateMCPServer(ctx, s, tid, args)
			},
		},
		{
			Name:        "chaya_bind_mcp_to_agent",
			Description: "将已存在的 MCP 服务器绑定到指定非主助手，使其在 harness 中可用。",
			Parameters: json.RawMessage(`{"type":"object","properties":{
				"target_agent_id":{"type":"string","description":"非主助手的 agents.id"},
				"mcp_server_id":{"type":"string","description":"mcp_servers.id"}
			},"required":["target_agent_id","mcp_server_id"]}`),
			Source:    "builtin",
			ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) { return chayaBindMCP(ctx, s, tid, args) },
		},
		{
			Name:        "chaya_bind_skill_to_agent",
			Description: "将技能绑定到指定非主助手。",
			Parameters: json.RawMessage(`{"type":"object","properties":{
				"target_agent_id":{"type":"string","description":"非主助手的 agents.id"},
				"skill_id":{"type":"string","description":"skills.id"}
			},"required":["target_agent_id","skill_id"]}`),
			Source:    "builtin",
			ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) { return chayaBindSkill(ctx, s, tid, args) },
		},
		{
			Name:        "chaya_notify_mcp_oauth",
			Description: "当 MCP 为 OAuth 类型需要用户授权时，向当前会话推送事件，提示用户在前端完成 OAuth。可选检查是否已有 token。",
			Parameters: json.RawMessage(`{"type":"object","properties":{
				"mcp_server_id":{"type":"string","description":"mcp_servers.id"}
			},"required":["mcp_server_id"]}`),
			Source: "builtin",
			ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
				return chayaNotifyMCPOAuth(ctx, s, convID, tid, args)
			},
		},
	}
}

func chayaListCustomAgents(ctx context.Context, s *SubActor, tenantID string) (*pkg.ToolResult, error) {
	if s.DB == nil {
		return failTool("no database")
	}
	var rows []struct {
		ID   string `gorm:"column:id"`
		Name string `gorm:"column:name"`
	}
	err := s.DB.Table("agents").
		Select("agents.id, agents.name").
		Joins("INNER JOIN users u ON u.id = agents.user_id").
		Where("agents.user_id = ? AND agents.is_primary = false AND u.tenant_id = ?", s.UserID, tenantID).
		Order("agents.created_at DESC").Limit(50).
		Scan(&rows).Error
	if err != nil {
		return failTool(err.Error())
	}
	b, _ := json.MarshalIndent(rows, "", "  ")
	return &pkg.ToolResult{Success: true, Body: string(b)}, nil
}

func chayaListMCPServers(ctx context.Context, s *SubActor, tenantID string) (*pkg.ToolResult, error) {
	if s.DB == nil {
		return failTool("no database")
	}
	var servers []pgstore.MCPServer
	if err := s.DB.Where("tenant_id = ? AND enabled = true", tenantID).Order("name").Limit(80).Find(&servers).Error; err != nil {
		return failTool(err.Error())
	}
	type row struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	out := make([]row, 0, len(servers))
	for _, x := range servers {
		out = append(out, row{ID: x.ID, Name: x.Name, URL: x.URL})
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	return &pkg.ToolResult{Success: true, Body: string(b)}, nil
}

func validateChayaMCPURL(urlStr string) error {
	urlStr = strings.TrimSpace(urlStr)
	if urlStr == "" {
		return fmt.Errorf("url 不能为空")
	}
	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		return fmt.Errorf("url 必须以 http:// 或 https:// 开头")
	}
	return nil
}

func chayaCreateMCPServer(_ context.Context, s *SubActor, tenantID string, args json.RawMessage) (*pkg.ToolResult, error) {
	if s.DB == nil {
		return failTool("no database")
	}
	var req struct {
		Name          string `json:"name"`
		URL           string `json:"url"`
		Description   string `json:"description"`
		IsHTTPOAuth   bool   `json:"is_http_oauth"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return failTool("invalid json: " + err.Error())
	}
	name := strings.TrimSpace(req.Name)
	urlStr := strings.TrimSpace(req.URL)
	if name == "" || urlStr == "" {
		return failTool("name 与 url 必填")
	}
	if err := validateChayaMCPURL(urlStr); err != nil {
		return failTool(err.Error())
	}

	cfgMap := map[string]any{}
	desc := strings.TrimSpace(req.Description)
	if desc != "" {
		cfgMap["description"] = desc
	}
	if req.IsHTTPOAuth {
		cfgMap["ext"] = map[string]any{"server_type": "http_oauth"}
	}
	cfgBytes, err := json.Marshal(cfgMap)
	if err != nil {
		return failTool(err.Error())
	}

	rec := pgstore.MCPServer{
		TenantID: tenantID,
		Name:     name,
		URL:      urlStr,
		Type:     "http-stream",
		Enabled:  true,
		Healthy:  true,
		Config:   cfgBytes,
	}
	if err := s.DB.Create(&rec).Error; err != nil {
		return failTool(err.Error())
	}

	if s.Orchestrator != nil && s.Orchestrator.MCPRegistry != nil {
		sc := mcp.ServerConfig{
			ID: rec.ID, TenantID: rec.TenantID, Name: rec.Name, URL: rec.URL, Type: rec.Type,
			Config: rec.Config, Enabled: rec.Enabled, Healthy: rec.Healthy,
		}
		go s.Orchestrator.MCPRegistry.EnsureClient(context.Background(), sc)
	}

	type out struct {
		ID            string `json:"id"`
		Name          string `json:"name"`
		URL           string `json:"url"`
		IsHTTPOAuth   bool   `json:"is_http_oauth"`
		NextStep      string `json:"next_step,omitempty"`
	}
	o := out{ID: rec.ID, Name: rec.Name, URL: rec.URL, IsHTTPOAuth: req.IsHTTPOAuth}
	if req.IsHTTPOAuth {
		o.NextStep = "请用户在前端 MCP 工作区对该服务器完成 OAuth 授权；可调用 chaya_notify_mcp_oauth 推送会话内提示。"
	}
	b, _ := json.MarshalIndent(o, "", "  ")
	return &pkg.ToolResult{Success: true, Body: string(b)}, nil
}

func chayaListSkills(ctx context.Context, s *SubActor, tenantID string) (*pkg.ToolResult, error) {
	if s.DB == nil {
		return failTool("no database")
	}
	var skills []pgstore.Skill
	if err := s.DB.Where("tenant_id = ?", tenantID).Order("name").Limit(80).Find(&skills).Error; err != nil {
		return failTool(err.Error())
	}
	type row struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := make([]row, 0, len(skills))
	for _, x := range skills {
		out = append(out, row{ID: x.ID, Name: x.Name})
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	return &pkg.ToolResult{Success: true, Body: string(b)}, nil
}

func chayaBindMCP(ctx context.Context, s *SubActor, tenantID string, args json.RawMessage) (*pkg.ToolResult, error) {
	var req struct {
		TargetAgentID string `json:"target_agent_id"`
		MCPServerID   string `json:"mcp_server_id"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return failTool("invalid json: " + err.Error())
	}
	req.TargetAgentID = strings.TrimSpace(req.TargetAgentID)
	req.MCPServerID = strings.TrimSpace(req.MCPServerID)
	if req.TargetAgentID == "" || req.MCPServerID == "" {
		return failTool("target_agent_id 与 mcp_server_id 必填")
	}
	if err := assertCustomAgentOwned(s, tenantID, req.TargetAgentID); err != nil {
		return failTool(err.Error())
	}
	var m pgstore.MCPServer
	if err := s.DB.Where("id = ? AND tenant_id = ?", req.MCPServerID, tenantID).First(&m).Error; err != nil {
		return failTool("mcp server 不存在或不属于当前租户")
	}
	binding := pgstore.AgentMCPServer{AgentID: req.TargetAgentID, MCPServerID: req.MCPServerID}
	if err := s.DB.Where(pgstore.AgentMCPServer{AgentID: req.TargetAgentID, MCPServerID: req.MCPServerID}).
		FirstOrCreate(&binding).Error; err != nil {
		return failTool(err.Error())
	}
	if s.Orchestrator != nil && s.Orchestrator.MCPRegistry != nil {
		cfg := mcp.ServerConfig{
			ID: m.ID, TenantID: m.TenantID, Name: m.Name, URL: m.URL, Type: m.Type,
			Config: m.Config, Enabled: m.Enabled, Healthy: m.Healthy,
		}
		go s.Orchestrator.MCPRegistry.EnsureClient(context.Background(), cfg)
	}
	msg := fmt.Sprintf("已绑定 MCP「%s」到助手 %s。若该 MCP 为 OAuth 且尚未授权，请调用 chaya_notify_mcp_oauth。", m.Name, req.TargetAgentID)
	return &pkg.ToolResult{Success: true, Body: msg}, nil
}

func chayaBindSkill(ctx context.Context, s *SubActor, tenantID string, args json.RawMessage) (*pkg.ToolResult, error) {
	var req struct {
		TargetAgentID string `json:"target_agent_id"`
		SkillID       string `json:"skill_id"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return failTool("invalid json: " + err.Error())
	}
	req.TargetAgentID = strings.TrimSpace(req.TargetAgentID)
	req.SkillID = strings.TrimSpace(req.SkillID)
	if req.TargetAgentID == "" || req.SkillID == "" {
		return failTool("target_agent_id 与 skill_id 必填")
	}
	if err := assertCustomAgentOwned(s, tenantID, req.TargetAgentID); err != nil {
		return failTool(err.Error())
	}
	var sk pgstore.Skill
	if err := s.DB.Where("id = ? AND tenant_id = ?", req.SkillID, tenantID).First(&sk).Error; err != nil {
		return failTool("skill 不存在或不属于当前租户")
	}
	row := pgstore.AgentSkill{AgentID: req.TargetAgentID, SkillID: req.SkillID}
	if err := s.DB.Where(pgstore.AgentSkill{AgentID: req.TargetAgentID, SkillID: req.SkillID}).FirstOrCreate(&row).Error; err != nil {
		return failTool(err.Error())
	}
	msg := fmt.Sprintf("已绑定技能「%s」到助手 %s。", sk.Name, req.TargetAgentID)
	return &pkg.ToolResult{Success: true, Body: msg}, nil
}

func chayaNotifyMCPOAuth(ctx context.Context, s *SubActor, convID, tenantID string, args json.RawMessage) (*pkg.ToolResult, error) {
	var req struct {
		MCPServerID string `json:"mcp_server_id"`
	}
	if err := json.Unmarshal(args, &req); err != nil {
		return failTool("invalid json: " + err.Error())
	}
	req.MCPServerID = strings.TrimSpace(req.MCPServerID)
	if req.MCPServerID == "" {
		return failTool("mcp_server_id 必填")
	}
	var m pgstore.MCPServer
	if err := s.DB.Where("id = ? AND tenant_id = ?", req.MCPServerID, tenantID).First(&m).Error; err != nil {
		return failTool("mcp server 未找到")
	}
	var cfg map[string]any
	_ = json.Unmarshal(m.Config, &cfg)
	var ext map[string]any
	if e, ok := cfg["ext"].(map[string]any); ok {
		ext = e
	}
	isOAuth, _ := ext["server_type"].(string)
	if isOAuth != "http_oauth" {
		return &pkg.ToolResult{Success: true, Body: "该 MCP 不是 OAuth 类型，一般无需单独授权提示。"}, nil
	}
	if s.Hub != nil && convID != "" {
		s.Hub.Publish(convID, map[string]any{
			"type":          "mcp_oauth_required",
			"agent_id":      s.AgentID,
			"mcp_server_id": m.ID,
			"mcp_url":       m.URL,
			"name":          m.Name,
			"message":       "请在前端 MCP 设置中完成 OAuth 授权后再使用该服务器。",
			"timestamp":     time.Now().UnixMilli(),
		})
	}
	return &pkg.ToolResult{Success: true, Body: fmt.Sprintf("已向会话推送 OAuth 提示事件（server_id=%s）。请用户打开设置完成授权。", m.ID)}, nil
}

func assertCustomAgentOwned(s *SubActor, tenantID, agentID string) error {
	var n int64
	err := s.DB.Table("agents ag").
		Joins("INNER JOIN users u ON u.id = ag.user_id").
		Where("ag.id = ? AND ag.user_id = ? AND u.tenant_id = ? AND ag.is_primary = false", agentID, s.UserID, tenantID).
		Count(&n).Error
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("目标助手不存在、不是当前用户的非主助手、或无权操作")
	}
	return nil
}

func failTool(msg string) (*pkg.ToolResult, error) {
	return &pkg.ToolResult{Success: false, Body: "", Error: msg}, nil
}
