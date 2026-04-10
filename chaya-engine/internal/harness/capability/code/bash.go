package code

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

const bashTimeout = 30 * time.Second

func BashTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"command":     map[string]string{"type": "string", "description": "Shell command to execute"},
			"working_dir": map[string]string{"type": "string", "description": "Working directory (optional)"},
		},
		"required": []string{"command"},
	})

	return pkg.Tool{
		Name:        "bash",
		Description: "Execute a shell command and return stdout/stderr. Use for running tests, builds, git, etc.",
		Parameters:  params,
		Source:      "code",
		ExecuteFn: func(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
			var req struct {
				Command    string `json:"command"`
				WorkingDir string `json:"working_dir"`
			}
			json.Unmarshal(args, &req)

			cmdCtx, cancel := context.WithTimeout(ctx, bashTimeout)
			defer cancel()

			cmd := exec.CommandContext(cmdCtx, "sh", "-c", req.Command)
			if req.WorkingDir != "" {
				cmd.Dir = req.WorkingDir
			}

			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr

			err := cmd.Run()

			output := stdout.String()
			if stderr.Len() > 0 {
				output += "\n[stderr]\n" + stderr.String()
			}

			output, truncPath := TruncateOutput(output, 50*1024)

			body := fmt.Sprintf("$ %s\n", req.Command)
			if err != nil {
				body += fmt.Sprintf("[exit: %v]\n", err)
			}
			if truncPath != "" {
				body += fmt.Sprintf("[output truncated, full at %s]\n", truncPath)
			}
			body += output

			return &pkg.ToolResult{
				Success: err == nil,
				Body:    body,
				Error:   errStr(err),
			}, nil
		},
	}
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
