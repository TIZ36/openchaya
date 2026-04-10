package api

import (
	"encoding/json"
	"fmt"
	"strings"

	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
)

func mergeStringMaps(a, b map[string]string) map[string]string {
	if len(a) == 0 && len(b) == 0 {
		return nil
	}
	out := map[string]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func getStringMap(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string)
	for k, val := range m {
		if s, ok := val.(string); ok {
			out[k] = s
		}
	}
	return out
}

// mergeMCPConfigFromPayload maps frontend fields into the JSON `config` column (create).
func mergeMCPConfigFromPayload(raw map[string]any) (json.RawMessage, error) {
	cfg := map[string]any{}

	if c, ok := raw["config"].(map[string]any); ok {
		for k, v := range c {
			cfg[k] = v
		}
	}

	if meta, ok := raw["metadata"].(map[string]any); ok {
		cfg["metadata"] = meta
		if headers, ok := meta["headers"].(map[string]any); ok {
			h := map[string]string{}
			for k, v := range headers {
				if s, ok := v.(string); ok {
					h[k] = s
				}
			}
			if len(h) > 0 {
				cfg["headers"] = mergeStringMaps(getStringMap(cfg["headers"]), h)
			}
		}
	}

	if ext, ok := raw["ext"].(map[string]any); ok {
		cfg["ext"] = ext
	}

	if desc, ok := raw["description"].(string); ok && desc != "" {
		cfg["description"] = desc
	}

	return json.Marshal(cfg)
}

// mergeMCPConfigUpdate merges a partial JSON body into existing config (update).
func mergeMCPConfigUpdate(existing json.RawMessage, raw map[string]any) (json.RawMessage, error) {
	var base map[string]any
	if len(existing) > 0 {
		_ = json.Unmarshal(existing, &base)
	}
	if base == nil {
		base = map[string]any{}
	}

	if c, ok := raw["config"].(map[string]any); ok {
		for k, v := range c {
			base[k] = v
		}
	}

	if meta, ok := raw["metadata"].(map[string]any); ok {
		base["metadata"] = meta
		if headers, ok := meta["headers"].(map[string]any); ok {
			h := map[string]string{}
			for k, v := range headers {
				if s, ok := v.(string); ok {
					h[k] = s
				}
			}
			if len(h) > 0 {
				base["headers"] = mergeStringMaps(getStringMap(base["headers"]), h)
			}
		}
	}

	if ext, ok := raw["ext"].(map[string]any); ok {
		base["ext"] = ext
	}

	if raw["description"] != nil {
		if d, ok := raw["description"].(string); ok {
			if d != "" {
				base["description"] = d
			} else {
				delete(base, "description")
			}
		}
	}

	return json.Marshal(base)
}

func mcpServerJSON(s pgstore.MCPServer) map[string]any {
	out := map[string]any{
		"id":         s.ID,
		"tenant_id":  s.TenantID,
		"name":       s.Name,
		"url":        s.URL,
		"type":       s.Type,
		"enabled":    s.Enabled,
		"healthy":    s.Healthy,
		"created_at": s.CreatedAt,
	}
	var cfg map[string]any
	if len(s.Config) > 0 {
		_ = json.Unmarshal(s.Config, &cfg)
	}
	if cfg != nil {
		out["config"] = cfg
		if meta, ok := cfg["metadata"]; ok {
			out["metadata"] = meta
		}
		if ext, ok := cfg["ext"]; ok {
			out["ext"] = ext
		}
		if desc, ok := cfg["description"].(string); ok && desc != "" {
			out["description"] = desc
		}
	}
	return out
}

func validateMCPURL(urlStr string) error {
	if urlStr == "" {
		return fmt.Errorf("url 不能为空")
	}
	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		return fmt.Errorf("url 必须以 http:// 或 https:// 开头")
	}
	return nil
}
