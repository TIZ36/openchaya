// Package pkg provides shared types used across all layers.
package pkg

import (
	"context"
	"encoding/json"
)

// Tool is the universal interface for all agent capabilities.
// MCP tools, Skills, Media generation, Code tools all implement this.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema
	ServerID    string          `json:"server_id,omitempty"` // MCP server origin
	Source      string          `json:"source"` // "mcp", "skill", "media", "code", "builtin"

	// Execute runs the tool. Nil for tools that are passed to LLM as function defs.
	ExecuteFn func(ctx context.Context, args json.RawMessage) (*ToolResult, error) `json:"-"`
}

// ToolResult is the output of a tool execution.
type ToolResult struct {
	Success bool            `json:"success"`
	Body    string          `json:"body,omitempty"`    // natural language summary (for LLM)
	Data    json.RawMessage `json:"data,omitempty"`    // structured data (for code)
	Error   string          `json:"error,omitempty"`
}

// ToProviderTool converts to the provider.Tool format for LLM function calling.
func (t *Tool) ToProviderTool() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"parameters":  json.RawMessage(t.Parameters),
		},
	}
}
