package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// RegisterMCPProxyRoutes registers public MCP reverse proxy (CORS + streamable HTTP).
func RegisterMCPProxyRoutes(r chi.Router, db *gorm.DB, rdb *redis.Client, jwtSecret string) {
	h := &mcpProxyHandler{db: db, rdb: rdb, jwtSecret: jwtSecret}
	r.Handle("/mcp", h)
	r.Handle("/mcp/health", h)
}

type mcpProxyHandler struct {
	db        *gorm.DB
	rdb       *redis.Client
	jwtSecret string
}

func (h *mcpProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/mcp/health" {
		h.serveHealth(w, r)
		return
	}
	h.serveMCP(w, r)
}

func (h *mcpProxyHandler) serveHealth(w http.ResponseWriter, r *http.Request) {
	targetStr := r.URL.Query().Get("url")
	if targetStr == "" {
		http.Error(w, `{"error":"missing url"}`, http.StatusBadRequest)
		return
	}
	u, err := url.Parse(targetStr)
	if err != nil || u.Scheme == "" || u.Host == "" {
		http.Error(w, `{"error":"invalid url"}`, http.StatusBadRequest)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	proxy.Director = func(req *http.Request) {
		req.URL = u
		req.Host = u.Host
		req.Header = r.Header.Clone()
	}
	proxy.ServeHTTP(w, r)
}

func (h *mcpProxyHandler) serveMCP(w http.ResponseWriter, r *http.Request) {
	targetStr := r.URL.Query().Get("url")
	if targetStr == "" {
		http.Error(w, `{"error":"missing url"}`, http.StatusBadRequest)
		return
	}
	upstream, err := url.Parse(targetStr)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		http.Error(w, `{"error":"invalid url"}`, http.StatusBadRequest)
		return
	}

	serverID := r.URL.Query().Get("server_id")
	outReq := r.Clone(r.Context())
	outReq.URL = upstream
	outReq.Host = upstream.Host
	outReq.RequestURI = ""

	outHeaders := cloneHeadersForUpstream(r.Header, serverID != "")

	if serverID != "" && h.db != nil {
		chayaTok := r.Header.Get("X-Chaya-Authorization")
		if chayaTok == "" {
			chayaTok = r.Header.Get("Authorization")
		}
		uid, tid, ok := parseChayaJWT(chayaTok, h.jwtSecret)
		if !ok {
			http.Error(w, `{"error":"需要登录：请携带 X-Chaya-Authorization 或有效的 Bearer token"}`, http.StatusUnauthorized)
			return
		}
		var s pgstore.MCPServer
		if err := h.db.Where("id = ? AND tenant_id = ?", serverID, tid).First(&s).Error; err != nil {
			http.Error(w, `{"error":"mcp server not found"}`, http.StatusNotFound)
			return
		}
		authz, err := resolveMCPServerAuthorization(r.Context(), h.rdb, uid, &s)
		if err != nil {
			slog.Warn("mcp proxy auth resolve", "err", err)
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadGateway)
			return
		}
		for k, v := range authz {
			outHeaders.Set(k, v)
		}
	}

	outReq.Header = outHeaders

	client := &http.Client{
		Timeout: 0,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	resp, err := client.Do(outReq)
	if err != nil {
		slog.Error("mcp proxy upstream", "err", err)
		http.Error(w, `{"error":"upstream request failed"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		slog.Warn("mcp proxy copy", "err", err)
	}
}

func cloneHeadersForUpstream(src http.Header, stripAuth bool) http.Header {
	out := http.Header{}
	skip := map[string]bool{
		"X-Chaya-Authorization": true,
	}
	if stripAuth {
		skip["Authorization"] = true
	}
	for k, vals := range src {
		kk := http.CanonicalHeaderKey(k)
		if skip[kk] {
			continue
		}
		for _, v := range vals {
			out.Add(kk, v)
		}
	}
	return out
}

func parseChayaJWT(headerVal string, secret string) (userID, tenantID string, ok bool) {
	if headerVal == "" {
		return "", "", false
	}
	tokenStr := strings.TrimPrefix(headerVal, "Bearer ")
	if tokenStr == headerVal {
		return "", "", false
	}
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		return []byte(secret), nil
	})
	if err != nil || !token.Valid {
		return "", "", false
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", "", false
	}
	uid, _ := claims["user_id"].(string)
	tid, _ := claims["tenant_id"].(string)
	if tid == "" {
		return "", "", false
	}
	return uid, tid, true
}

func resolveMCPServerAuthorization(ctx context.Context, rdb *redis.Client, userID string, s *pgstore.MCPServer) (map[string]string, error) {
	var cfg map[string]any
	if len(s.Config) > 0 {
		_ = json.Unmarshal(s.Config, &cfg)
	}

	headers := map[string]string{}
	if cfg != nil {
		// config.headers（静态 API Key 等）
		if h, ok := cfg["headers"].(map[string]any); ok {
			for k, v := range h {
				if str, ok := v.(string); ok {
					headers[k] = str
				}
			}
		}
		// config.metadata.headers（前端 metadata 字段落库位置）
		if meta, ok := cfg["metadata"].(map[string]any); ok {
			if hh, ok := meta["headers"].(map[string]any); ok {
				for k, v := range hh {
					if str, ok := v.(string); ok {
						headers[k] = str
					}
				}
			}
		}
	}

	// OAuth 类型：从 Redis 注入 access token（失败则报错，阻止转发）
	var ext map[string]any
	if cfg != nil {
		if e, ok := cfg["ext"].(map[string]any); ok {
			ext = e
		}
	}
	if st, _ := ext["server_type"].(string); st == "http_oauth" {
		if rdb == nil {
			return nil, errors.New("OAuth MCP 需要 Redis，请检查服务器配置")
		}
		tok, err := loadOAuthAccessToken(rdb, s.TenantID, userID, normalizeMCPURL(s.URL))
		if err != nil {
			return nil, err
		}
		if tok == "" {
			return nil, errors.New("尚未完成 OAuth 授权或 token 已过期，请重新授权")
		}
		headers["Authorization"] = "Bearer " + tok
	}

	// 无认证配置时直接返回空 map（代理正常转发，不注入任何 header）
	return headers, nil
}
