package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

const toolsCacheTTL = 5 * time.Minute

// ServerConfig mirrors the mcp_servers DB table.
type ServerConfig struct {
	ID       string          `gorm:"column:id" json:"id"`
	TenantID string          `gorm:"column:tenant_id" json:"tenant_id"`
	Name     string          `gorm:"column:name" json:"name"`
	URL      string          `gorm:"column:url" json:"url"`
	Type     string          `gorm:"column:type" json:"type"`
	Config   json.RawMessage `gorm:"column:config" json:"config"`
	Enabled  bool            `gorm:"column:enabled" json:"enabled"`
	Healthy  bool            `gorm:"column:healthy" json:"healthy"`
}

func (ServerConfig) TableName() string { return "mcp_servers" }

// cachedTools stores cached tool lists with expiry.
type cachedTools struct {
	tools   []pkg.Tool
	expires time.Time
}

// oauthServerMeta stores config for OAuth MCP servers (per-user token, not engine-global).
type oauthServerMeta struct {
	ID       string
	TenantID string
	Name     string
	URL      string
	Config   json.RawMessage
}

// oauthCachedClient is a short-lived per-user client for OAuth MCP servers.
type oauthCachedClient struct {
	client  *Client
	headers map[string]string
	expires time.Time
}

// Registry manages all MCP server connections and provides unified tool listing.
type Registry struct {
	db           *gorm.DB
	rdb          *redis.Client
	clients      map[string]*Client          // serverID → client (static-auth servers)
	oauthServers map[string]*oauthServerMeta // serverID → config (OAuth servers)
	oauthClients map[string]*oauthCachedClient // "serverID:userID" → ephemeral client
	cache        map[string]*cachedTools      // serverID → cached tools (shared for both types)
	// Cooldown for servers whose auth / listing failed recently. Key is
	// "serverID" for static-auth failures and "serverID:userID" for OAuth
	// failures. While `time.Now() < cooldown[key]` we skip collection and
	// suppress the per-turn warn spam. Expires on its own (no explicit GC).
	cooldown map[string]time.Time
	mu       sync.RWMutex
}

// oauthCooldown is how long we'll leave a failing server alone before trying
// it again. Short enough that after the user finishes re-authorising in the
// UI, the next chat turn picks it up without needing an explicit invalidate
// call threaded through the OAuth callback.
const oauthCooldown = 90 * time.Second

type ToolsProgress struct {
	ServerName string
	FromCache  bool
	Err        error
	Done       int
	Total      int
}

func NewRegistry(db *gorm.DB, rdb *redis.Client) *Registry {
	return &Registry{
		db:           db,
		rdb:          rdb,
		clients:      make(map[string]*Client),
		oauthServers: make(map[string]*oauthServerMeta),
		oauthClients: make(map[string]*oauthCachedClient),
		cache:        make(map[string]*cachedTools),
		cooldown:     make(map[string]time.Time),
	}
}

// markCooldown records that `key` failed. Caller also decides whether to warn;
// we only warn when transitioning into cooldown, not for repeat offences.
func (r *Registry) markCooldown(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if t, ok := r.cooldown[key]; ok && now.Before(t) {
		return false // already cooling down
	}
	r.cooldown[key] = now.Add(oauthCooldown)
	return true
}

// inCooldown reports whether `key` is currently suppressed.
func (r *Registry) inCooldown(key string) bool {
	r.mu.RLock()
	t, ok := r.cooldown[key]
	r.mu.RUnlock()
	return ok && time.Now().Before(t)
}

// ClearAuthCooldown is called by the OAuth completion handler so a server
// that just got a fresh token tries immediately instead of waiting out the
// 5-minute penalty from its previous failure.
func (r *Registry) ClearAuthCooldown(serverID, userID string) {
	if serverID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.cooldown, serverID)
	if userID != "" {
		delete(r.cooldown, serverID+":"+userID)
	}
}

// LoadServers loads all tenant-enabled MCP servers and initializes connections.
// OAuth servers are skipped (per-user tokens, handled by the proxy layer).
// RemoveServer disconnects and forgets an MCP server (DB row should already be deleted or disabled).
func (r *Registry) RemoveServer(serverID string) {
	if serverID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.clients[serverID]; ok {
		c.healthy.Store(false)
		delete(r.clients, serverID)
	}
	delete(r.oauthServers, serverID)
	delete(r.cache, serverID)
	prefix := serverID + ":"
	var oauthKeys []string
	for k := range r.oauthClients {
		if strings.HasPrefix(k, prefix) {
			oauthKeys = append(oauthKeys, k)
		}
	}
	for _, k := range oauthKeys {
		delete(r.oauthClients, k)
	}
	slog.Info("mcp server removed from registry", "id", serverID)
}

func (r *Registry) LoadServers(ctx context.Context) error {
	var servers []ServerConfig
	if err := r.db.Where("enabled = true").Find(&servers).Error; err != nil {
		return err
	}
	for _, s := range servers {
		r.EnsureClient(ctx, s)
	}
	return nil
}

// EnsureClient makes sure a client exists for the given server config.
// Safe to call concurrently; idempotent for already-connected servers.
func (r *Registry) EnsureClient(ctx context.Context, s ServerConfig) {
	r.mu.RLock()
	_, exists := r.clients[s.ID]
	r.mu.RUnlock()
	if exists {
		return
	}

	var cfg struct {
		Headers  map[string]string `json:"headers"`
		Metadata struct {
			Headers map[string]string `json:"headers"`
		} `json:"metadata"`
		Ext struct {
			ServerType string `json:"server_type"`
		} `json:"ext"`
		Timeout int `json:"timeout"`
	}
	json.Unmarshal(s.Config, &cfg)

	if cfg.Ext.ServerType == "http_oauth" {
		r.mu.Lock()
		r.oauthServers[s.ID] = &oauthServerMeta{
			ID: s.ID, TenantID: s.TenantID, Name: s.Name, URL: s.URL, Config: s.Config,
		}
		r.mu.Unlock()
		slog.Info("mcp oauth server registered (per-user token)", "name", s.Name, "id", s.ID)
		return
	}

	h := cfg.Headers
	if len(h) == 0 && len(cfg.Metadata.Headers) > 0 {
		h = cfg.Metadata.Headers
	}

	timeout := time.Duration(cfg.Timeout) * time.Second
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	connectURL := ResolveMCPConnectURL(s.URL)
	client := NewClient(s.ID, s.Name, connectURL, h, timeout, s.TenantID)

	r.mu.Lock()
	if _, exists := r.clients[s.ID]; !exists {
		r.clients[s.ID] = client
	} else {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()

	// Async initialization
	go func(c *Client, name string) {
		initCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := c.Initialize(initCtx); err != nil {
			slog.Warn("mcp server init failed", "name", name, "err", err)
		} else {
			slog.Info("mcp server connected", "name", name)
		}
	}(client, s.Name)
}

// agentMCPBindingRow is a lightweight scan target for the join table.
type agentMCPBindingRow struct {
	MCPServerID string `gorm:"column:mcp_server_id"`
}

// agentMCPServerIDs returns the set of MCP server IDs bound to an agent.
// Returns nil (empty) if no bindings exist → no MCPs visible to this agent.
func (r *Registry) agentMCPServerIDs(agentID string) map[string]struct{} {
	if r.db == nil || agentID == "" {
		return nil
	}
	var rows []agentMCPBindingRow
	r.db.Table("agent_mcp_servers").
		Where("agent_id = ?", agentID).
		Find(&rows)
	if len(rows) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		set[row.MCPServerID] = struct{}{}
	}
	return set
}

// FilterServerIDsByTenant keeps only MCP server rows that belong to tenantID.
func (r *Registry) FilterServerIDsByTenant(ids map[string]struct{}, tenantID string) map[string]struct{} {
	if r.db == nil || len(ids) == 0 || tenantID == "" {
		return ids
	}
	keys := make([]string, 0, len(ids))
	for k := range ids {
		keys = append(keys, k)
	}
	var allowed []string
	if err := r.db.Model(&ServerConfig{}).Where("tenant_id = ? AND id IN ?", tenantID, keys).Pluck("id", &allowed).Error; err != nil || len(allowed) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(allowed))
	for _, id := range allowed {
		out[id] = struct{}{}
	}
	return out
}

// AgentHarnessMCPServerIDs returns MCP servers visible to this agent in harness:
// - If agent_mcp_servers has rows, only those IDs (filtered to tenant).
// - If no bindings, all enabled mcp_servers for the tenant (until user binds explicitly).
func (r *Registry) AgentHarnessMCPServerIDs(agentID, tenantID string) map[string]struct{} {
	if r.db == nil || tenantID == "" {
		return nil
	}
	bound := r.agentMCPServerIDs(agentID)
	if len(bound) > 0 {
		return r.FilterServerIDsByTenant(bound, tenantID)
	}
	var ids []string
	if err := r.db.Model(&ServerConfig{}).Where("tenant_id = ? AND enabled = ?", tenantID, true).Pluck("id", &ids).Error; err != nil || len(ids) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		out[id] = struct{}{}
	}
	return out
}

// MCPServerStatus describes why a bound MCP server is currently unusable.
type MCPServerStatus struct {
	ID        string
	Name      string
	Reason    string // human-readable, e.g. "access token 已过期，请重新授权"
	NeedsAuth bool   // true when re-authorizing in the UI would fix it
}

// serverName resolves a server's display name from the DB; falls back to the ID.
func (r *Registry) serverName(id string) string {
	if r.db == nil {
		return id
	}
	var name string
	r.db.Model(&ServerConfig{}).Where("id = ?", id).Pluck("name", &name)
	if name == "" {
		return id
	}
	return name
}

// AgentBrokenMCPServers returns the agent's EXPLICITLY bound MCP servers that
// currently can't serve tools, each with a human-readable reason. Cheap: OAuth
// servers do a Redis token check (no network), static servers check in-memory
// health. Returns nil when the agent has no explicit bindings — the tenant-wide
// fallback is best-effort and not worth warning about. Lets callers tell the
// user WHY a bound tool is silent instead of pretending it has no tools.
func (r *Registry) AgentBrokenMCPServers(ctx context.Context, agentID, userID, tenantID string) []MCPServerStatus {
	if r.db == nil {
		return nil
	}
	bound := r.agentMCPServerIDs(agentID)
	if len(bound) == 0 {
		return nil
	}
	bound = r.FilterServerIDsByTenant(bound, tenantID)
	if len(bound) == 0 {
		return nil
	}

	r.mu.RLock()
	clients := make(map[string]*Client, len(r.clients))
	for id, c := range r.clients {
		clients[id] = c
	}
	oauthMetas := make(map[string]*oauthServerMeta, len(r.oauthServers))
	for id, m := range r.oauthServers {
		oauthMetas[id] = m
	}
	r.mu.RUnlock()

	var broken []MCPServerStatus
	for id := range bound {
		if meta, ok := oauthMetas[id]; ok {
			tok, err := r.loadOAuthToken(ctx, tenantID, userID, meta.URL)
			if err != nil {
				broken = append(broken, MCPServerStatus{ID: id, Name: meta.Name, Reason: err.Error(), NeedsAuth: true})
			} else if tok == "" {
				broken = append(broken, MCPServerStatus{ID: id, Name: meta.Name, Reason: "尚未完成 OAuth 授权", NeedsAuth: true})
			}
			continue
		}
		if c, ok := clients[id]; ok {
			if !c.Healthy() {
				broken = append(broken, MCPServerStatus{ID: id, Name: c.Name, Reason: "无法连接到 MCP 服务", NeedsAuth: false})
			}
			continue
		}
		// Bound but not loaded into the registry (disabled or never connected).
		broken = append(broken, MCPServerStatus{ID: id, Name: r.serverName(id), Reason: "MCP 服务未连接", NeedsAuth: false})
	}
	return broken
}

// ListToolsForHarness lists tools from MCP servers allowed for this agent and tenant.
func (r *Registry) ListToolsForHarness(ctx context.Context, agentID string, timeout time.Duration, onProgress func(ToolsProgress), userID, tenantID string) []pkg.Tool {
	allow := r.AgentHarnessMCPServerIDs(agentID, tenantID)
	if len(allow) == 0 {
		return nil
	}
	return r.listToolsWithProgress(ctx, timeout, allow, onProgress, userID, tenantID)
}

// ListToolsForAgent lists tools from MCP servers bound to the given agent.
func (r *Registry) ListToolsForAgent(ctx context.Context, agentID string, timeout time.Duration, userID, tenantID string) []pkg.Tool {
	allowed := r.agentMCPServerIDs(agentID)
	if len(allowed) == 0 {
		return nil
	}
	return r.listToolsWithProgress(ctx, timeout, allowed, nil, userID, tenantID)
}

// ListAllTools lists tools from all healthy servers (no per-agent filter).
func (r *Registry) ListAllTools(ctx context.Context, timeout time.Duration, userID, tenantID string) []pkg.Tool {
	return r.listToolsWithProgress(ctx, timeout, nil, nil, userID, tenantID)
}

func (r *Registry) ListAllToolsWithProgress(ctx context.Context, timeout time.Duration, onProgress func(ToolsProgress), userID, tenantID string) []pkg.Tool {
	return r.listToolsWithProgress(ctx, timeout, nil, onProgress, userID, tenantID)
}

func (r *Registry) ListToolsForAgentWithProgress(ctx context.Context, agentID string, timeout time.Duration, onProgress func(ToolsProgress), userID, tenantID string) []pkg.Tool {
	allowed := r.agentMCPServerIDs(agentID)
	if len(allowed) == 0 {
		return nil
	}
	return r.listToolsWithProgress(ctx, timeout, allowed, onProgress, userID, tenantID)
}

// ListToolsForServerIDsWithProgress loads tools from the specified set of MCP server IDs.
func (r *Registry) ListToolsForServerIDsWithProgress(ctx context.Context, serverIDs map[string]struct{}, timeout time.Duration, onProgress func(ToolsProgress), userID, tenantID string) []pkg.Tool {
	if len(serverIDs) == 0 {
		return nil
	}
	return r.listToolsWithProgress(ctx, timeout, serverIDs, onProgress, userID, tenantID)
}

func (r *Registry) listToolsWithProgress(ctx context.Context, timeout time.Duration, allow map[string]struct{}, onProgress func(ToolsProgress), userID, tenantID string) []pkg.Tool {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	r.mu.RLock()
	clients := make([]*Client, 0, len(r.clients))
	for id, c := range r.clients {
		if allow != nil {
			if _, ok := allow[id]; !ok {
				continue
			}
		}
		clients = append(clients, c)
	}
	var oauthMetas []*oauthServerMeta
	if userID != "" && r.rdb != nil {
		for id, meta := range r.oauthServers {
			if allow != nil {
				if _, ok := allow[id]; !ok {
					continue
				}
			}
			oauthMetas = append(oauthMetas, meta)
		}
	}
	r.mu.RUnlock()

	// Tenant isolation: never list or call tools for other tenants' MCP rows.
	if tenantID != "" {
		nextClients := clients[:0]
		for _, c := range clients {
			if c != nil && c.TenantID == tenantID {
				nextClients = append(nextClients, c)
			}
		}
		clients = nextClients
		var oauthF []*oauthServerMeta
		for _, m := range oauthMetas {
			if m != nil && m.TenantID == tenantID {
				oauthF = append(oauthF, m)
			}
		}
		oauthMetas = oauthF
	}

	var wg sync.WaitGroup
	resultCh := make(chan []pkg.Tool, len(clients)+len(oauthMetas)+1)
	total := len(clients) + len(oauthMetas)
	var doneCount int32
	reportProgress := func(p ToolsProgress) {
		if onProgress == nil {
			return
		}
		done := int(atomic.AddInt32(&doneCount, 1))
		p.Done = done
		p.Total = total
		onProgress(p)
	}

	// --- Static-auth servers ---
	for _, client := range clients {
		if !client.Healthy() {
			reportProgress(ToolsProgress{ServerName: client.Name, Err: errors.New("server unhealthy")})
			continue
		}
		r.mu.RLock()
		if cached, ok := r.cache[client.ServerID]; ok && time.Now().Before(cached.expires) {
			r.mu.RUnlock()
			reportProgress(ToolsProgress{ServerName: client.Name, FromCache: true})
			resultCh <- cached.tools
			continue
		}
		r.mu.RUnlock()

		wg.Add(1)
		go func(c *Client) {
			defer wg.Done()
			rawTools, err := c.ListTools(ctx)
			if err != nil {
				slog.Warn("mcp list tools failed", "server", c.Name, "err", err)
				reportProgress(ToolsProgress{ServerName: c.Name, Err: err})
				return
			}
			tools := r.parseRawTools(rawTools, c.ServerID, c.Name)
			r.mu.Lock()
			r.cache[c.ServerID] = &cachedTools{tools: tools, expires: time.Now().Add(toolsCacheTTL)}
			r.mu.Unlock()
			reportProgress(ToolsProgress{ServerName: c.Name})
			resultCh <- tools
		}(client)
	}

	// --- OAuth servers (per-user token from Redis) ---
	for _, meta := range oauthMetas {
		r.mu.RLock()
		if cached, ok := r.cache[meta.ID]; ok && time.Now().Before(cached.expires) {
			r.mu.RUnlock()
			reportProgress(ToolsProgress{ServerName: meta.Name, FromCache: true})
			resultCh <- cached.tools
			continue
		}
		r.mu.RUnlock()

		// Skip if we tried and failed recently. Avoids the per-turn "尚未完成
		// OAuth 授权" spam: we log once on transition and again after the
		// cooldown window lapses. User-visible error surfaces via the proxy
		// layer's explicit "authorize" UI, not via chat tool-collection noise.
		cooldownKey := meta.ID + ":" + userID
		if r.inCooldown(cooldownKey) {
			reportProgress(ToolsProgress{ServerName: meta.Name, Err: errors.New("cooldown")})
			continue
		}

		wg.Add(1)
		go func(m *oauthServerMeta, cdKey string) {
			defer wg.Done()
			client, headers, err := r.getOAuthClient(ctx, m, userID, tenantID)
			if err != nil {
				if r.markCooldown(cdKey) {
					slog.Warn("mcp oauth client failed — cooldown 5m", "server", m.Name, "err", err)
				}
				reportProgress(ToolsProgress{ServerName: m.Name, Err: err})
				return
			}
			rawTools, err := client.ListToolsWithHeaders(ctx, headers)
			if err != nil {
				if r.markCooldown(cdKey) {
					slog.Warn("mcp oauth list tools failed — cooldown 5m", "server", m.Name, "err", err)
				}
				reportProgress(ToolsProgress{ServerName: m.Name, Err: err})
				return
			}
			tools := r.parseRawTools(rawTools, m.ID, m.Name)
			r.mu.Lock()
			r.cache[m.ID] = &cachedTools{tools: tools, expires: time.Now().Add(toolsCacheTTL)}
			r.mu.Unlock()
			reportProgress(ToolsProgress{ServerName: m.Name})
			resultCh <- tools
		}(meta, cooldownKey)
	}

	go func() { wg.Wait(); close(resultCh) }()

	var all []pkg.Tool
	for tools := range resultCh {
		all = append(all, tools...)
	}

	slog.Info("mcp tools collected", "count", len(all), "servers", len(clients), "oauth_servers", len(oauthMetas))
	return all
}

// CallTool executes a tool on the appropriate MCP server.
// For OAuth servers, userID and tenantID are used to resolve the per-user access token.
func (r *Registry) CallTool(ctx context.Context, serverID, toolName string, args json.RawMessage, userID, tenantID string) (*pkg.ToolResult, error) {
	// Try static-auth client first
	r.mu.RLock()
	client, ok := r.clients[serverID]
	r.mu.RUnlock()
	if ok {
		if tenantID != "" && client.TenantID != "" && client.TenantID != tenantID {
			return &pkg.ToolResult{Success: false, Error: "mcp server not in this tenant"}, nil
		}
		result, err := client.CallTool(ctx, toolName, args)
		if err != nil {
			return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
		}
		return &pkg.ToolResult{Success: true, Data: result, Body: string(result)}, nil
	}

	// Try OAuth server
	r.mu.RLock()
	meta, isOAuth := r.oauthServers[serverID]
	r.mu.RUnlock()
	if isOAuth {
		if tenantID != "" && meta.TenantID != "" && meta.TenantID != tenantID {
			return &pkg.ToolResult{Success: false, Error: "mcp server not in this tenant"}, nil
		}
		oaClient, headers, err := r.getOAuthClient(ctx, meta, userID, tenantID)
		if err != nil {
			return &pkg.ToolResult{Success: false, Error: "OAuth: " + err.Error()}, nil
		}
		result, err := oaClient.CallToolWithHeaders(ctx, toolName, args, headers)
		if err != nil {
			return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
		}
		return &pkg.ToolResult{Success: true, Data: result, Body: string(result)}, nil
	}

	return &pkg.ToolResult{Success: false, Error: "server not found"}, nil
}

// --- OAuth helpers ---

// 30 minutes is a comfortable safety net well below typical access-token
// lifetimes (most providers issue 1h+). The cache key below also embeds
// a token hash, so a re-authorize replaces the entry immediately rather
// than waiting for TTL — and Healthy() catches in-flight expirations.
// Previously this was 2 minutes, which meant rebuilding (Initialize
// handshake, ~100-500ms) every couple of turns for no reason.
const oauthClientCacheTTL = 30 * time.Minute

// getOAuthClient returns a cached or freshly created MCP client authenticated with the user's OAuth token.
func (r *Registry) getOAuthClient(ctx context.Context, meta *oauthServerMeta, userID, tenantID string) (*Client, map[string]string, error) {
	if tenantID == "" {
		tenantID = meta.TenantID
	}
	tok, err := r.loadOAuthToken(ctx, tenantID, userID, meta.URL)
	if err != nil {
		return nil, nil, fmt.Errorf("token load: %w", err)
	}
	if tok == "" {
		return nil, nil, errors.New("尚未完成 OAuth 授权或 token 已过期，请在前端重新授权")
	}

	// Cache key includes token hash so re-authorize (new token) immediately
	// invalidates the stale client without waiting out the TTL or relying
	// solely on Healthy() to notice 401s.
	tokHash := sha256.Sum256([]byte(tok))
	cacheKey := fmt.Sprintf("%s:%s:%x", meta.ID, userID, tokHash[:8])
	r.mu.RLock()
	if cc, ok := r.oauthClients[cacheKey]; ok && time.Now().Before(cc.expires) && cc.client.Healthy() {
		r.mu.RUnlock()
		return cc.client, cc.headers, nil
	}
	r.mu.RUnlock()

	headers := map[string]string{"Authorization": "Bearer " + tok}

	// Also merge any static headers from config
	var cfg struct {
		Headers  map[string]string `json:"headers"`
		Metadata struct {
			Headers map[string]string `json:"headers"`
		} `json:"metadata"`
	}
	_ = json.Unmarshal(meta.Config, &cfg)
	if len(cfg.Headers) > 0 {
		for k, v := range cfg.Headers {
			if !strings.EqualFold(k, "authorization") {
				headers[k] = v
			}
		}
	}
	if len(cfg.Metadata.Headers) > 0 {
		for k, v := range cfg.Metadata.Headers {
			if !strings.EqualFold(k, "authorization") {
				headers[k] = v
			}
		}
	}

	client := NewClient(meta.ID, meta.Name, meta.URL, nil, 30*time.Second, meta.TenantID)
	if err := client.InitializeWithHeaders(ctx, headers); err != nil {
		return nil, nil, fmt.Errorf("initialize: %w", err)
	}

	r.mu.Lock()
	r.oauthClients[cacheKey] = &oauthCachedClient{client: client, headers: headers, expires: time.Now().Add(oauthClientCacheTTL)}
	r.mu.Unlock()

	return client, headers, nil
}

// loadOAuthToken reads the per-user OAuth access token from Redis (same key format as the proxy layer).
func (r *Registry) loadOAuthToken(ctx context.Context, tenantID, userID, mcpURL string) (string, error) {
	if r.rdb == nil {
		return "", errors.New("redis unavailable")
	}
	norm := strings.TrimSuffix(strings.TrimSpace(mcpURL), "/")
	h := sha256.Sum256([]byte(norm))
	key := fmt.Sprintf("mcp:oauth:token:%s:%s:%x", tenantID, userID, h[:])

	raw, err := r.rdb.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var rec struct {
		AccessToken string `json:"access_token"`
		ExpiresAt   int64  `json:"expires_at,omitempty"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return "", err
	}
	if rec.AccessToken == "" {
		return "", nil
	}
	if rec.ExpiresAt > 0 && time.Now().Unix() > rec.ExpiresAt {
		return "", errors.New("access token 已过期，请重新授权")
	}
	return rec.AccessToken, nil
}

// parseRawTools converts raw JSON-RPC tool definitions to pkg.Tool slice.
func (r *Registry) parseRawTools(rawTools []json.RawMessage, serverID, serverName string) []pkg.Tool {
	tools := make([]pkg.Tool, 0, len(rawTools))
	for _, raw := range rawTools {
		var def struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			InputSchema json.RawMessage `json:"inputSchema"`
		}
		if err := json.Unmarshal(raw, &def); err != nil {
			continue
		}
		params := def.InputSchema
		if len(params) == 0 {
			params = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		desc := def.Description
		if override := descriptionFor(serverName, def.Name); override != "" {
			// User-intent override wins — the original dev-facing description
			// typically hurts model selection accuracy and wastes prompt tokens.
			desc = override
		}
		tools = append(tools, pkg.Tool{
			Name:        def.Name,
			Description: "[" + serverName + "] " + desc,
			Parameters:  params,
			ServerID:    serverID,
			Source:      "mcp",
		})
	}
	return tools
}
