package code

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

// MaxReadSize limits file read to prevent context overflow.
const MaxReadSize = 100 * 1024 // 100KB

func ReadTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":   map[string]string{"type": "string", "description": "File path to read"},
			"offset": map[string]any{"type": "integer", "description": "Start line (0-based, optional)"},
			"limit":  map[string]any{"type": "integer", "description": "Max lines to read (optional)"},
		},
		"required": []string{"path"},
	})

	return pkg.Tool{
		Name:        "read",
		Description: "Read file contents with optional line range",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Path   string `json:"path"`
				Offset int    `json:"offset"`
				Limit  int    `json:"limit"`
			}
			json.Unmarshal(args, &req)

			data, err := os.ReadFile(req.Path)
			if err != nil {
				return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
			}

			content := string(data)

			// Apply line range
			if req.Offset > 0 || req.Limit > 0 {
				lines := strings.Split(content, "\n")
				start := req.Offset
				if start >= len(lines) {
					start = len(lines)
				}
				end := len(lines)
				if req.Limit > 0 && start+req.Limit < end {
					end = start + req.Limit
				}
				content = strings.Join(lines[start:end], "\n")
			}

			// Truncate if too large
			content, truncPath := TruncateOutput(content, MaxReadSize)

			body := fmt.Sprintf("File: %s (%d bytes)", req.Path, len(data))
			if truncPath != "" {
				body += fmt.Sprintf("\n[Truncated, full content at %s]", truncPath)
			}

			return &pkg.ToolResult{
				Success: true,
				Body:    body + "\n\n" + content,
			}, nil
		},
	}
}
