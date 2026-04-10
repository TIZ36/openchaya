package code

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

func GlobTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]string{"type": "string", "description": "Glob pattern, e.g. **/*.go or src/**/*.ts"},
			"path":    map[string]string{"type": "string", "description": "Base directory (optional, default .)"},
		},
		"required": []string{"pattern"},
	})

	return pkg.Tool{
		Name:        "glob",
		Description: "Find files matching a glob pattern",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Pattern string `json:"pattern"`
				Path    string `json:"path"`
			}
			json.Unmarshal(args, &req)

			base := req.Path
			if base == "" {
				base = "."
			}

			var matches []string
			filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() {
					return nil
				}
				matched, _ := filepath.Match(req.Pattern, filepath.Base(path))
				if matched {
					matches = append(matches, path)
				}
				return nil
			})

			body := fmt.Sprintf("Found %d files matching %q", len(matches), req.Pattern)
			if len(matches) > 0 {
				body += "\n" + strings.Join(matches, "\n")
			}

			// Truncate if too many
			body, _ = TruncateOutput(body, 50*1024)

			return &pkg.ToolResult{Success: true, Body: body}, nil
		},
	}
}
