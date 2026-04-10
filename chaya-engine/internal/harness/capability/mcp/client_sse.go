package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *JSONRPCError   `json:"error"`
}

func matchRPCID(raw json.RawMessage, want int64) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return false
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		n, err := strconv.ParseInt(s, 10, 64)
		return err == nil && n == want
	}
	var f float64
	if json.Unmarshal(raw, &f) == nil {
		return int64(f) == want
	}
	return false
}

func tryParseSingleJSONRPC(body []byte, wantID int64) (json.RawMessage, error) {
	var env rpcEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, err
	}
	if env.JSONRPC != "2.0" || !matchRPCID(env.ID, wantID) {
		return nil, errors.New("not a matching jsonrpc 2.0 response")
	}
	if env.Error != nil {
		return nil, fmt.Errorf("mcp rpc error %d: %s", env.Error.Code, env.Error.Message)
	}
	return env.Result, nil
}

func looksLikeMCPStream(body []byte) bool {
	s := strings.TrimSpace(string(body))
	if strings.HasPrefix(s, "event:") {
		return true
	}
	return strings.Contains(s, "\ndata:") && strings.Contains(s, "jsonrpc")
}

func parseJSONRPCFromSSE(body []byte, wantID int64) (json.RawMessage, error) {
	lines := strings.Split(string(body), "\n")
	var lastDataErr error
	for _, line := range lines {
		line = strings.TrimSpace(strings.TrimPrefix(line, "\r"))
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		res, err := tryParseSingleJSONRPC([]byte(payload), wantID)
		if err == nil {
			return res, nil
		}
		lastDataErr = err
	}
	if lastDataErr != nil {
		return nil, fmt.Errorf("sse data lines: %w", lastDataErr)
	}
	return nil, fmt.Errorf("no jsonrpc response with id %d in sse body", wantID)
}

func parseJSONRPCResult(contentType string, body []byte, wantID int64) (json.RawMessage, error) {
	if res, err := tryParseSingleJSONRPC(body, wantID); err == nil {
		return res, nil
	}
	ct := strings.ToLower(contentType)
	if strings.Contains(ct, "text/event-stream") || looksLikeMCPStream(body) {
		return parseJSONRPCFromSSE(body, wantID)
	}
	// Last try: surface the single-json error
	_, err := tryParseSingleJSONRPC(body, wantID)
	return nil, err
}
