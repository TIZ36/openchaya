package code

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

func WriteTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":    map[string]string{"type": "string", "description": "File path to create/overwrite"},
			"content": map[string]string{"type": "string", "description": "File content"},
		},
		"required": []string{"path", "content"},
	})

	return pkg.Tool{
		Name:        "write",
		Description: "Create or overwrite a file with given content",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			}
			json.Unmarshal(args, &req)

			// Snapshot if file exists
			if _, err := os.Stat(req.Path); err == nil {
				SnapshotFile(req.Path)
			}

			// Ensure directory exists
			os.MkdirAll(filepath.Dir(req.Path), 0755)

			if err := os.WriteFile(req.Path, []byte(req.Content), 0644); err != nil {
				return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
			}

			return &pkg.ToolResult{
				Success: true,
				Body:    fmt.Sprintf("Written %s (%d bytes)", req.Path, len(req.Content)),
			}, nil
		},
	}
}
