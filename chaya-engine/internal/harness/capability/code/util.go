package code

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

const snapshotDir = "/tmp/chaya-snapshots"

// SnapshotFile copies a file to a snapshot directory before editing.
// Returns the snapshot path.
func SnapshotFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	os.MkdirAll(snapshotDir, 0755)
	base := filepath.Base(path)
	snapPath := filepath.Join(snapshotDir, fmt.Sprintf("%s_%d", base, time.Now().UnixNano()))

	os.WriteFile(snapPath, data, 0644)
	return snapPath
}

// RollbackFile restores a file from its snapshot.
func RollbackFile(originalPath, snapshotPath string) error {
	data, err := os.ReadFile(snapshotPath)
	if err != nil {
		return err
	}
	return os.WriteFile(originalPath, data, 0644)
}

// TruncateOutput truncates output to maxLen bytes.
// If truncated, writes full content to a temp file and returns its path.
func TruncateOutput(output string, maxLen int) (string, string) {
	if len(output) <= maxLen {
		return output, ""
	}

	// Write full output to temp file
	tmpFile, err := os.CreateTemp("", "chaya-output-*.txt")
	if err != nil {
		return output[:maxLen] + "\n[truncated]", ""
	}
	tmpFile.WriteString(output)
	tmpFile.Close()

	truncated := output[:maxLen/2] + fmt.Sprintf(
		"\n\n... [output truncated: %d bytes total, full content at %s] ...\n\n",
		len(output), tmpFile.Name(),
	) + output[len(output)-maxLen/4:]

	return truncated, tmpFile.Name()
}

// AllCodeTools returns all code capability tools.
func AllCodeTools() []pkg.Tool {
	return []pkg.Tool{
		ReadTool(),
		EditTool(),
		WriteTool(),
		GlobTool(),
		GrepTool(),
		BashTool(),
	}
}
