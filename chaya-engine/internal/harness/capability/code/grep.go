package code

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

func GrepTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"pattern": map[string]string{"type": "string", "description": "Search pattern (literal string)"},
			"path":    map[string]string{"type": "string", "description": "File or directory to search (default .)"},
			"glob":    map[string]string{"type": "string", "description": "File filter glob, e.g. *.go (optional)"},
		},
		"required": []string{"pattern"},
	})

	return pkg.Tool{
		Name:        "grep",
		Description: "Search file contents for a pattern, returns matching lines with file:line format",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Pattern string `json:"pattern"`
				Path    string `json:"path"`
				Glob    string `json:"glob"`
			}
			json.Unmarshal(args, &req)

			base := req.Path
			if base == "" {
				base = "."
			}

			var results []string
			maxResults := 100

			filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
				if err != nil || info.IsDir() || len(results) >= maxResults {
					return nil
				}
				// Skip binary/large files
				if info.Size() > 1*1024*1024 {
					return nil
				}
				// Glob filter
				if req.Glob != "" {
					matched, _ := filepath.Match(req.Glob, filepath.Base(path))
					if !matched {
						return nil
					}
				}
				// Skip hidden dirs
				if strings.Contains(path, "/.") || strings.Contains(path, "node_modules") || strings.Contains(path, "vendor") {
					return nil
				}

				f, err := os.Open(path)
				if err != nil {
					return nil
				}
				defer f.Close()

				scanner := bufio.NewScanner(f)
				lineNum := 0
				for scanner.Scan() && len(results) < maxResults {
					lineNum++
					line := scanner.Text()
					if strings.Contains(line, req.Pattern) {
						results = append(results, fmt.Sprintf("%s:%d: %s", path, lineNum, strings.TrimSpace(line)))
					}
				}
				return nil
			})

			body := fmt.Sprintf("Found %d matches for %q", len(results), req.Pattern)
			if len(results) > 0 {
				body += "\n" + strings.Join(results, "\n")
			}

			body, _ = TruncateOutput(body, 50*1024)

			return &pkg.ToolResult{Success: true, Body: body}, nil
		},
	}
}
