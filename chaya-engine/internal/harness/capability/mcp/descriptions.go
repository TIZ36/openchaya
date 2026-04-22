package mcp

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// descOverrides maps "<serverName>:<toolName>" → replacement description.
// Loaded once at startup from config/tool_descriptions.json; callers that
// want hot-reload can call ReloadDescriptions().
//
// Why this exists: upstream MCP descriptions are written for developers and
// routinely hurt model tool-selection accuracy. Rewriting them in user-intent
// form ("when should I reach for this?") is a cheap, high-leverage win.
var (
	descOverrideMu sync.RWMutex
	descOverrides  map[string]string
)

type descOverrideFile struct {
	Overrides map[string]string `json:"overrides"`
}

// LoadDescriptions reads the override file. Missing file = no overrides (no
// error). Malformed JSON = logged + no overrides. Keep it forgiving so a
// typo in the config doesn't crash the engine.
func LoadDescriptions(path string) {
	descOverrideMu.Lock()
	defer descOverrideMu.Unlock()
	descOverrides = nil
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("mcp descriptions: read failed", "path", path, "err", err)
		}
		return
	}
	var parsed descOverrideFile
	if err := json.Unmarshal(data, &parsed); err != nil {
		slog.Warn("mcp descriptions: invalid json — ignoring overrides", "path", path, "err", err)
		return
	}
	descOverrides = make(map[string]string, len(parsed.Overrides))
	for k, v := range parsed.Overrides {
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k == "" || v == "" {
			continue
		}
		descOverrides[k] = v
	}
	slog.Info("mcp descriptions loaded", "path", path, "overrides", len(descOverrides))
}

// LoadDescriptionsDefault looks for config/tool_descriptions.json relative
// to CWD and a couple of common engine roots so it works from both `go run`
// and the packaged binary launched by restart.sh.
func LoadDescriptionsDefault() {
	candidates := []string{
		"config/tool_descriptions.json",
		"chaya-engine/config/tool_descriptions.json",
		filepath.Join("..", "config", "tool_descriptions.json"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			LoadDescriptions(p)
			return
		}
	}
	// No file — stay silent, not an error.
}

// descriptionFor returns the override for this server+tool pair, or "" if
// none. Caller decides whether to concatenate or replace.
func descriptionFor(serverName, toolName string) string {
	descOverrideMu.RLock()
	defer descOverrideMu.RUnlock()
	if descOverrides == nil {
		return ""
	}
	return descOverrides[serverName+":"+toolName]
}
