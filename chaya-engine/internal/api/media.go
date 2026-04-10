package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// RegisterMediaRoutes registers media studio helper endpoints (providers list for model picker).
func RegisterMediaRoutes(r chi.Router, db *gorm.DB) {
	a := &mediaAPI{db: db}
	r.Get("/api/media/providers", a.providers)
}

type mediaAPI struct {
	db *gorm.DB
}

type mediaCaps struct {
	Image bool `json:"image"`
	Video bool `json:"video"`
}

type mediaProviderConfigOut struct {
	ConfigID      string    `json:"config_id"`
	Name          string    `json:"name"`
	Model         string    `json:"model"`
	Provider      string    `json:"provider"`
	Capabilities  mediaCaps `json:"capabilities"`
	MediaVisible  bool      `json:"media_visible"`
	MediaPurpose  bool      `json:"media_purpose,omitempty"`
}

type mediaProviderOut struct {
	ID      string                   `json:"id"`
	Name    string                   `json:"name"`
	Image   map[string]bool          `json:"image"`
	Video   map[string]bool          `json:"video"`
	Configs []mediaProviderConfigOut `json:"configs"`
}

func parseConfigName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	if n, ok := m["name"].(string); ok && strings.TrimSpace(n) != "" {
		return n
	}
	return ""
}

func parseMetadataMediaPurpose(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	meta, ok := m["metadata"].(map[string]any)
	if !ok {
		return false
	}
	v, ok := meta["media_purpose"].(bool)
	return ok && v
}

func inferMediaCaps(model, displayName string) mediaCaps {
	lower := strings.ToLower(model + " " + displayName)
	image := strings.Contains(lower, "image") ||
		strings.Contains(lower, "grok-imagine") ||
		strings.Contains(lower, "dall-e") ||
		strings.Contains(lower, "gpt-image")
	video := strings.Contains(lower, "video") ||
		strings.Contains(lower, "veo") ||
		(strings.Contains(lower, "grok-imagine") && strings.Contains(lower, "video"))
	return mediaCaps{Image: image, Video: video}
}

func providerMediaFlags(providerType string) (imageGen, imageEdit, videoSubmit bool) {
	switch strings.ToLower(providerType) {
	case "gemini":
		return true, true, true
	case "openai", "custom":
		return true, true, false
	default:
		return false, false, false
	}
}

func (a *mediaAPI) providers(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())

	var llmProviders []pgstore.LLMProvider
	a.db.Where("tenant_id = ?", tenantID).Order("sort_order ASC").Find(&llmProviders)
	provNameByType := make(map[string]string)
	for _, p := range llmProviders {
		provNameByType[p.ProviderID] = p.Name
		if provNameByType[p.ProviderType] == "" {
			provNameByType[p.ProviderType] = p.Name
		}
	}

	// 仅 media_visible=true（历史「媒体专用」行由 AutoMigrate 后 SQL 同步为 true）
	var configs []pgstore.LLMConfig
	a.db.Where("tenant_id = ? AND enabled = ? AND media_visible = ?", tenantID, true, true).Find(&configs)

	group := make(map[string][]mediaProviderConfigOut)

	for _, c := range configs {
		display := parseConfigName(c.Config)
		if display == "" {
			display = c.Model
		}
		caps := inferMediaCaps(c.Model, display)
		cfgOut := mediaProviderConfigOut{
			ConfigID:     c.ID,
			Name:         display,
			Model:        c.Model,
			Provider:     c.Provider,
			Capabilities: caps,
			MediaVisible: true,
			MediaPurpose: parseMetadataMediaPurpose(c.Config),
		}
		key := c.Provider
		group[key] = append(group[key], cfgOut)
	}

	out := make([]mediaProviderOut, 0, len(group))
	for pid, cfgs := range group {
		if len(cfgs) == 0 {
			continue
		}
		pname := provNameByType[pid]
		if pname == "" {
			pname = pid
		}
		ig, ie, vs := providerMediaFlags(pid)
		out = append(out, mediaProviderOut{
			ID:   pid,
			Name: pname,
			Image: map[string]bool{
				"generate":    ig,
				"edit":        ie,
				"variations":  false,
			},
			Video: map[string]bool{
				"submit": vs,
				"status": vs,
			},
			Configs: cfgs,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	OK(w, map[string]any{"providers": out})
}
