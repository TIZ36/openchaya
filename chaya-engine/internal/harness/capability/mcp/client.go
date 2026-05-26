package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Client is a JSON-RPC 2.0 client for a single MCP server.
type Client struct {
	ServerID  string
	TenantID  string // owning tenant (for isolation; empty for legacy clients)
	Name      string
	URL       string
	Headers   map[string]string
	Timeout   time.Duration

	httpClient *http.Client
	sessionID  string
	healthy    atomic.Bool
	mu         sync.Mutex
	reqID      atomic.Int64
}

// JSONRPCRequest is a JSON-RPC 2.0 request.
type JSONRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type JSONRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func NewClient(serverID, name, url string, headers map[string]string, timeout time.Duration, tenantID string) *Client {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	c := &Client{
		ServerID: serverID,
		TenantID: tenantID,
		Name:     name,
		URL:      url,
		Headers:  headers,
		Timeout:  timeout,
		httpClient: &http.Client{Timeout: timeout},
	}
	c.healthy.Store(true)
	return c
}

// Healthy returns whether the server is considered healthy.
func (c *Client) Healthy() bool { return c.healthy.Load() }

// Initialize starts a session with the MCP server.
func (c *Client) Initialize(ctx context.Context) error {
	return c.InitializeWithHeaders(ctx, nil)
}

// ListTools calls tools/list and returns raw tool definitions.
func (c *Client) ListTools(ctx context.Context) ([]json.RawMessage, error) {
	return c.ListToolsWithHeaders(ctx, nil)
}

// CallTool invokes a specific tool on the MCP server.
func (c *Client) CallTool(ctx context.Context, toolName string, args json.RawMessage) (json.RawMessage, error) {
	return c.CallToolWithHeaders(ctx, toolName, args, nil)
}

// InitializeWithHeaders starts a session using extra headers (e.g. OAuth Bearer token).
func (c *Client) InitializeWithHeaders(ctx context.Context, extraHeaders map[string]string) error {
	resp, err := c.callWithHeaders(ctx, "initialize", map[string]any{
		"protocolVersion": "2025-06-18",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "chaya-engine", "version": "1.0.0"},
	}, extraHeaders)
	if err != nil {
		c.healthy.Store(false)
		return fmt.Errorf("mcp initialize: %w", err)
	}
	c.healthy.Store(true)
	_ = resp
	return nil
}

// ListToolsWithHeaders calls tools/list with extra headers.
func (c *Client) ListToolsWithHeaders(ctx context.Context, extraHeaders map[string]string) ([]json.RawMessage, error) {
	resp, err := c.callWithHeaders(ctx, "tools/list", nil, extraHeaders)
	if err != nil {
		return nil, err
	}
	var result struct {
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("parse tools list: %w", err)
	}
	return result.Tools, nil
}

// CallToolWithHeaders invokes a tool with extra headers.
func (c *Client) CallToolWithHeaders(ctx context.Context, toolName string, args json.RawMessage, extraHeaders map[string]string) (json.RawMessage, error) {
	return c.callWithHeaders(ctx, "tools/call", map[string]any{
		"name":      toolName,
		"arguments": json.RawMessage(args),
	}, extraHeaders)
}

func (c *Client) callWithHeaders(ctx context.Context, method string, params any, extraHeaders map[string]string) (json.RawMessage, error) {
	reqID := c.reqID.Add(1)
	rpcReq := JSONRPCRequest{
		JSONRPC: "2.0",
		ID:      reqID,
		Method:  method,
		Params:  params,
	}

	body, _ := json.Marshal(rpcReq)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range c.Headers {
		httpReq.Header.Set(k, v)
	}
	for k, v := range extraHeaders {
		httpReq.Header.Set(k, v)
	}
	if c.sessionID != "" {
		httpReq.Header.Set("mcp-session-id", c.sessionID)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		c.healthy.Store(false)
		return nil, fmt.Errorf("mcp http: %w", err)
	}
	defer resp.Body.Close()

	if sid := resp.Header.Get("mcp-session-id"); sid != "" {
		c.mu.Lock()
		c.sessionID = sid
		c.mu.Unlock()
	}

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("mcp read body: %w", err)
	}

	if resp.StatusCode >= 400 {
		c.healthy.Store(false)
		return nil, fmt.Errorf("mcp http %d: %s", resp.StatusCode, string(respBody))
	}

	c.healthy.Store(true)

	ct := resp.Header.Get("Content-Type")
	result, err := parseJSONRPCResult(ct, respBody, reqID)
	if err != nil {
		return nil, fmt.Errorf("mcp parse response: %w", err)
	}
	return result, nil
}
