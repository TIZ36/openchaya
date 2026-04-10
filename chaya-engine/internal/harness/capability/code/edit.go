package code

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

func EditTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path":       map[string]string{"type": "string", "description": "File path"},
			"old_string": map[string]string{"type": "string", "description": "Exact text to find and replace"},
			"new_string": map[string]string{"type": "string", "description": "Replacement text"},
		},
		"required": []string{"path", "old_string", "new_string"},
	})

	return pkg.Tool{
		Name:        "edit",
		Description: "Edit a file by replacing an exact string match. Use read first to see current content.",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Path      string `json:"path"`
				OldString string `json:"old_string"`
				NewString string `json:"new_string"`
			}
			json.Unmarshal(args, &req)

			data, err := os.ReadFile(req.Path)
			if err != nil {
				return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
			}

			content := string(data)
			if !strings.Contains(content, req.OldString) {
				return &pkg.ToolResult{
					Success: false,
					Error:   "old_string not found in file. Read the file first to get exact content.",
				}, nil
			}

			// Snapshot before edit
			snapPath := SnapshotFile(req.Path)

			// Replace (first occurrence only)
			newContent := strings.Replace(content, req.OldString, req.NewString, 1)
			if err := os.WriteFile(req.Path, []byte(newContent), 0644); err != nil {
				return &pkg.ToolResult{Success: false, Error: err.Error()}, nil
			}

			return &pkg.ToolResult{
				Success: true,
				Body: fmt.Sprintf("Edited %s (snapshot: %s)\n- Replaced %d chars with %d chars",
					req.Path, snapPath, len(req.OldString), len(req.NewString)),
			}, nil
		},
	}
}
