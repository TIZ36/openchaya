package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

const (
	oauthStateTTL    = 15 * time.Minute
	oauthTokenTTL    = 90 * 24 * time.Hour
)

func normalizeMCPURL(raw string) string {
	return strings.TrimSuffix(strings.TrimSpace(raw), "/")
}

func oauthTokenKey(tenantID, userID, mcpURLNorm string) string {
	return fmt.Sprintf("mcp:oauth:token:%s:%s:%s", tenantID, userID, sha256Hex(mcpURLNorm))
}

func oauthStateKey(state string) string {
	return "mcp:oauth:state:" + state
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", h[:])
}

type oauthTokenRecord struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresAt    int64  `json:"expires_at,omitempty"`
}

func loadOAuthAccessToken(rdb *redis.Client, tenantID, userID, mcpURLNorm string) (string, error) {
	key := oauthTokenKey(tenantID, userID, mcpURLNorm)
	raw, err := rdb.Get(context.Background(), key).Bytes()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var rec oauthTokenRecord
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

// oauthTokenState reports whether a usable token exists and, if not, whether
// the cause is expiry (so the UI can distinguish "已过期 → 重新授权" from
// "从未授权"). Unlike loadOAuthAccessToken it never returns an error for the
// expired case — expiry is a normal, surfaceable state, not a failure.
func oauthTokenState(rdb *redis.Client, tenantID, userID, mcpURLNorm string) (hasToken, expired bool) {
	key := oauthTokenKey(tenantID, userID, mcpURLNorm)
	raw, err := rdb.Get(context.Background(), key).Bytes()
	if err != nil {
		return false, false // redis.Nil (never authorized) or transient error
	}
	var rec oauthTokenRecord
	if err := json.Unmarshal(raw, &rec); err != nil || rec.AccessToken == "" {
		return false, false
	}
	if rec.ExpiresAt > 0 && time.Now().Unix() > rec.ExpiresAt {
		return false, true // authorized once, but the access token lapsed
	}
	return true, false
}

// MCPOAuthAPI holds OAuth handlers for MCP streamable HTTP servers.
// db + mcpReg are used after a successful token exchange to (a) look up the
// server row by URL+tenant, then (b) clear its 5-minute cooldown so the
// very next probe actually retries instead of being silently suppressed.
// Both may be nil — callbacks still work, the cooldown bust just no-ops.
type MCPOAuthAPI struct {
	rdb       *redis.Client
	publicURL string
	db        *gorm.DB
	mcpReg    *mcp.Registry
}

func RegisterMCPOAuthRoutes(r chi.Router, rdb *redis.Client, cfg *internal.Config, db *gorm.DB, mcpReg *mcp.Registry) {
	if rdb == nil {
		return
	}
	a := &MCPOAuthAPI{rdb: rdb, publicURL: cfg.Server.PublicBaseURL(), db: db, mcpReg: mcpReg}
	r.Post("/api/mcp/oauth/discover", a.discover)
	r.Post("/api/mcp/oauth/authorize", a.authorize)
	r.Get("/api/mcp/oauth/token-status", a.tokenStatus)
}

// RegisterMCPOAuthPublicRoutes registers callback without JWT (browser redirect + SPA POST).
func RegisterMCPOAuthPublicRoutes(r chi.Router, rdb *redis.Client, cfg *internal.Config, db *gorm.DB, mcpReg *mcp.Registry) {
	if rdb == nil {
		return
	}
	a := &MCPOAuthAPI{rdb: rdb, publicURL: cfg.Server.PublicBaseURL(), db: db, mcpReg: mcpReg}
	r.Get("/mcp/oauth/callback", a.callbackGet)
	r.Post("/mcp/oauth/callback", a.callbackPost)
}

func (a *MCPOAuthAPI) discover(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MCPURL string `json:"mcp_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MCPURL == "" {
		Fail(w, CodeBadRequest, "mcp_url 必填")
		return
	}
	res, err := discoverOAuthMetadata(r.Context(), req.MCPURL)
	if err != nil {
		Fail(w, CodeMCPError, err.Error())
		return
	}
	OK(w, res)
}

func (a *MCPOAuthAPI) authorize(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AuthorizationEndpoint            string   `json:"authorization_endpoint"`
		TokenEndpoint                      string   `json:"token_endpoint"`
		RegistrationEndpoint               string   `json:"registration_endpoint"`
		Resource                           string   `json:"resource"`
		ClientID                           string   `json:"client_id"`
		ClientSecret                       string   `json:"client_secret"`
		ClientName                         string   `json:"client_name"`
		CodeChallengeMethodsSupported      []string `json:"code_challenge_methods_supported"`
		TokenEndpointAuthMethodsSupported  []string `json:"token_endpoint_auth_methods_supported"`
		MCPURL                             string   `json:"mcp_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid json")
		return
	}
	if req.AuthorizationEndpoint == "" || req.TokenEndpoint == "" {
		Fail(w, CodeInvalidParam, "authorization_endpoint 与 token_endpoint 必填")
		return
	}
	tenantID := middleware.TenantID(r.Context())
	userID := middleware.UserID(r.Context())
	if tenantID == "" || userID == "" {
		Fail(w, CodeUnauthorized, "missing user context")
		return
	}

	mcpNorm := normalizeMCPURL(req.MCPURL)
	if mcpNorm == "" {
		Fail(w, CodeInvalidParam, "mcp_url 必填")
		return
	}

	clientID := req.ClientID
	clientSecret := req.ClientSecret
	redirectURI := a.publicURL + "/mcp/oauth/callback"

	if req.RegistrationEndpoint != "" && clientID == "" {
		reg, err := dynamicRegisterClient(r.Context(), req.RegistrationEndpoint, redirectURI, req.ClientName)
		if err != nil {
			Fail(w, CodeMCPError, "动态注册客户端失败: "+err.Error())
			return
		}
		clientID = reg.ClientID
		clientSecret = reg.ClientSecret
	}
	if clientID == "" {
		Fail(w, CodeInvalidParam, "需要 client_id 或支持 registration_endpoint 的授权服务器")
		return
	}

	verifier, challenge, err := pkcePair()
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	stateBytes := make([]byte, 24)
	if _, err := rand.Read(stateBytes); err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)

	session := map[string]any{
		"code_verifier":                            verifier,
		"token_endpoint":                           req.TokenEndpoint,
		"client_id":                                clientID,
		"client_secret":                            clientSecret,
		"mcp_url":                                  mcpNorm,
		"tenant_id":                                tenantID,
		"user_id":                                  userID,
		"resource":                                 req.Resource,
		"token_endpoint_auth_methods_supported":    req.TokenEndpointAuthMethodsSupported,
		"redirect_uri":                             redirectURI,
	}
	sessBytes, _ := json.Marshal(session)
	if err := a.rdb.Set(r.Context(), oauthStateKey(state), sessBytes, oauthStateTTL).Err(); err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	u, err := url.Parse(req.AuthorizationEndpoint)
	if err != nil {
		Fail(w, CodeBadRequest, "invalid authorization_endpoint")
		return
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	if req.Resource != "" {
		q.Set("resource", req.Resource)
	}
	u.RawQuery = q.Encode()

	OK(w, map[string]any{
		"authorization_url": u.String(),
		"client_id":         clientID,
		"state":             state,
	})
}

func (a *MCPOAuthAPI) tokenStatus(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	userID := middleware.UserID(r.Context())
	mcpURL := normalizeMCPURL(r.URL.Query().Get("mcp_url"))
	if tenantID == "" || userID == "" || mcpURL == "" {
		Fail(w, CodeBadRequest, "mcp_url 必填且需登录")
		return
	}
	hasToken, expired := oauthTokenState(a.rdb, tenantID, userID, mcpURL)
	OK(w, map[string]any{
		"has_token": hasToken,
		"expired":   expired,
		"mcp_url":   mcpURL,
	})
}

func (a *MCPOAuthAPI) callbackGet(w http.ResponseWriter, r *http.Request) {
	rec, err := a.exchangeOAuthCode(r, r.URL.Query().Get("code"), r.URL.Query().Get("state"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>授权成功</title><p>OAuth 授权成功，可关闭此窗口返回应用。</p>`))
	_ = rec
}

func (a *MCPOAuthAPI) callbackPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code  string `json:"code"`
		State string `json:"state"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	rec, err := a.exchangeOAuthCode(r, body.Code, body.State)
	if err != nil {
		Fail(w, CodeMCPError, err.Error())
		return
	}
	OK(w, map[string]any{
		"access_token": rec.AccessToken,
		"token_type":   rec.TokenType,
		"expires_in":   0,
	})
}

func (a *MCPOAuthAPI) exchangeOAuthCode(r *http.Request, code, state string) (*oauthTokenRecord, error) {
	if code == "" || state == "" {
		return nil, errors.New("missing code or state")
	}
	raw, err := a.rdb.Get(r.Context(), oauthStateKey(state)).Bytes()
	if err == redis.Nil {
		return nil, errors.New("invalid or expired state")
	}
	if err != nil {
		return nil, err
	}
	var session map[string]any
	if err := json.Unmarshal(raw, &session); err != nil {
		return nil, err
	}
	_ = a.rdb.Del(r.Context(), oauthStateKey(state))

	tokenEndpoint, _ := session["token_endpoint"].(string)
	clientID, _ := session["client_id"].(string)
	clientSecret, _ := session["client_secret"].(string)
	verifier, _ := session["code_verifier"].(string)
	mcpURL, _ := session["mcp_url"].(string)
	tenantID, _ := session["tenant_id"].(string)
	userID, _ := session["user_id"].(string)
	redirectURI, _ := session["redirect_uri"].(string)

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("client_id", clientID)
	if clientSecret != "" {
		form.Set("client_secret", clientSecret)
	}
	form.Set("code_verifier", verifier)

	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		slog.Warn("oauth token exchange failed", "status", resp.StatusCode, "body", string(body))
		return nil, fmt.Errorf("token exchange failed: %s", string(body))
	}

	var tok struct {
		AccessToken  string `json:"access_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return nil, err
	}
	rec := &oauthTokenRecord{
		AccessToken:  tok.AccessToken,
		TokenType:    tok.TokenType,
		RefreshToken: tok.RefreshToken,
	}
	if tok.ExpiresIn > 0 {
		rec.ExpiresAt = time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).Unix()
	}
	b, _ := json.Marshal(rec)
	key := oauthTokenKey(tenantID, userID, mcpURL)
	if err := a.rdb.Set(r.Context(), key, b, oauthTokenTTL).Err(); err != nil {
		return nil, err
	}

	// Without these two steps, a server that the user "test connected" before
	// authorizing stays in the 5-minute oauth-failure cooldown — every probe
	// after authorize gets silently suppressed and the UI shows "0 tools".
	// Look up the matching server row by tenant + URL, clear its cooldown,
	// and re-ensure the client so the next probe actually loads tools.
	if a.db != nil && a.mcpReg != nil {
		var s pgstore.MCPServer
		if err := a.db.Where("tenant_id = ? AND url = ?", tenantID, mcpURL).First(&s).Error; err == nil {
			a.mcpReg.ClearAuthCooldown(s.ID, userID)
			go a.mcpReg.EnsureClient(context.Background(), mcp.ServerConfig{
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
	}
	return rec, nil
}

// --- discovery ---

type oauthDiscoveryResult struct {
	ProtectedResource any    `json:"protected_resource,omitempty"`
	AuthorizationServer any `json:"authorization_server"`
	Resource          string `json:"resource"`
}

func discoverOAuthMetadata(ctx context.Context, mcpURL string) (oauthDiscoveryResult, error) {
	u, err := url.Parse(mcpURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return oauthDiscoveryResult{}, errors.New("invalid mcp_url")
	}
	base := strings.TrimSuffix(u.String(), "/")
	client := &http.Client{Timeout: 20 * time.Second}

	tryURLs := []string{
		base + "/.well-known/oauth-protected-resource",
		u.Scheme + "://" + u.Host + "/.well-known/oauth-protected-resource",
	}
	var pr map[string]any
	var lastErr error
	for _, tu := range tryURLs {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, tu, nil)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			continue
		}
		if err := json.Unmarshal(b, &pr); err == nil && len(pr) > 0 {
			break
		}
	}
	if len(pr) == 0 {
		return oauthDiscoveryResult{}, fmt.Errorf("无法获取 oauth-protected-resource 元数据: %v", lastErr)
	}

	var asURL string
	if arr, ok := pr["authorization_servers"].([]any); ok && len(arr) > 0 {
		if s, ok := arr[0].(string); ok {
			asURL = strings.TrimSuffix(s, "/")
		}
	}
	if asURL == "" {
		return oauthDiscoveryResult{}, errors.New("authorization_servers 缺失")
	}

	asMeta, err := fetchAuthorizationServerMetadata(ctx, client, asURL, pr)
	if err != nil {
		return oauthDiscoveryResult{}, err
	}

	return oauthDiscoveryResult{
		ProtectedResource:   pr,
		AuthorizationServer: asMeta,
		Resource:            base,
	}, nil
}

// fetchAuthorizationServerMetadata loads RFC 8414 authorization server metadata.
// Some providers (e.g. Feishu Project MCP) list authorization_servers as a path like
// https://host/b/auth/mcp while publishing metadata only at https://host/.well-known/oauth-authorization-server.
// We try host-root first, then issuer from protected-resource, then path-appended URL.
func fetchAuthorizationServerMetadata(ctx context.Context, client *http.Client, asURL string, pr map[string]any) (map[string]any, error) {
	var candidates []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		for _, existing := range candidates {
			if existing == s {
				return
			}
		}
		candidates = append(candidates, s)
	}

	if iss, ok := pr["issuer"].(string); ok {
		if u, err := url.Parse(strings.TrimSpace(iss)); err == nil && u.Scheme != "" && u.Host != "" {
			add(u.Scheme + "://" + u.Host + "/.well-known/oauth-authorization-server")
		}
	}
	if au, err := url.Parse(asURL); err == nil && au.Scheme != "" && au.Host != "" {
		// Host root (covers Feishu: metadata not under /b/auth/mcp/...)
		add(au.Scheme + "://" + au.Host + "/.well-known/oauth-authorization-server")
	}
	add(strings.TrimSuffix(asURL, "/") + "/.well-known/oauth-authorization-server")

	var lastErr error
	for _, metaURL := range candidates {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, metaURL, nil)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			lastErr = fmt.Errorf("GET %s: %d", metaURL, resp.StatusCode)
			continue
		}
		b = bytes.TrimSpace(b)
		if len(b) == 0 || b[0] != '{' {
			lastErr = fmt.Errorf("GET %s: 非 JSON 响应（可能为 HTML）", metaURL)
			continue
		}
		var asMeta map[string]any
		if err := json.Unmarshal(b, &asMeta); err != nil {
			lastErr = err
			continue
		}
		if len(asMeta) == 0 {
			continue
		}
		return asMeta, nil
	}
	if lastErr != nil {
		return nil, fmt.Errorf("无法获取 oauth-authorization-server 元数据: %w", lastErr)
	}
	return nil, errors.New("无法获取 oauth-authorization-server 元数据")
}

// --- PKCE ---

func pkcePair() (verifier string, challenge string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(b)
	sum := sha256.Sum256([]byte(verifier))
	challenge = base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier, challenge, nil
}

// --- dynamic registration ---

type dynRegResult struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

func dynamicRegisterClient(ctx context.Context, endpoint, redirectURI, clientName string) (dynRegResult, error) {
	if clientName == "" {
		clientName = "Chaya MCP"
	}
	body := map[string]any{
		"client_name":   clientName,
		"redirect_uris": []string{redirectURI},
		"grant_types":   []string{"authorization_code", "refresh_token"},
		"response_types": []string{"code"},
		"token_endpoint_auth_method": "none",
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(b)))
	if err != nil {
		return dynRegResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return dynRegResult{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return dynRegResult{}, fmt.Errorf("registration %d: %s", resp.StatusCode, string(raw))
	}
	var out dynRegResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return dynRegResult{}, err
	}
	if out.ClientID == "" {
		return dynRegResult{}, errors.New("registration response missing client_id")
	}
	return out, nil
}
