package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

type LLMConfigAPI struct {
	db       *gorm.DB
	registry *provider.Registry
}

func RegisterLLMConfigRoutes(r chi.Router, db *gorm.DB, registry *provider.Registry) {
	a := &LLMConfigAPI{db: db, registry: registry}

	// Primary paths
	r.Get("/api/llm-configs", a.list)
	r.Post("/api/llm-configs", a.create)
	r.Get("/api/llm-configs/{id}", a.get)
	r.Put("/api/llm-configs/{id}", a.update)
	r.Delete("/api/llm-configs/{id}", a.del)
	r.Get("/api/llm-configs/{id}/api-key", a.getAPIKey)
	r.Get("/api/llm-configs/providers", a.providers)

	// Model listing
	r.Get("/api/llm/models", a.listModels)

	// Aliases — frontend uses /api/llm/configs paths
	r.Get("/api/llm/configs", a.list)
	r.Post("/api/llm/configs", a.create)
	r.Get("/api/llm/configs/{id}", a.get)
	r.Put("/api/llm/configs/{id}", a.update)
	r.Delete("/api/llm/configs/{id}", a.del)
	r.Get("/api/llm/configs/{id}/api-key", a.getAPIKey)
	r.Get("/api/llm/providers/supported", a.providers)
	r.Get("/api/llm/providers", a.providers)
	r.Get("/api/llm/providers/{id}", a.getProvider)
	r.Post("/api/llm/providers", a.createProvider)
	r.Put("/api/llm/providers/{id}", a.updateProvider)
	r.Delete("/api/llm/providers/{id}", a.deleteProvider)
	r.Put("/api/llm/providers/reorder", a.reorderProviders)
}

type providerPayload struct {
	ProviderID    string         `json:"provider_id"`
	Supplier      string         `json:"supplier"`
	Name          string         `json:"name"`
	ProviderType  string         `json:"provider_type"`
	OverrideURL   bool           `json:"override_url"`
	DefaultAPIURL string         `json:"default_api_url"`
	LogoLight     string         `json:"logo_light"`
	LogoDark      string         `json:"logo_dark"`
	LogoTheme     string         `json:"logo_theme"`
	Metadata      map[string]any `json:"metadata"`
}

type reorderProvidersPayload struct {
	ProviderIDs []string `json:"provider_ids"`
}

func systemProviders(now time.Time) []pgstore.LLMProvider {
	created := now.UTC()
	return []pgstore.LLMProvider{
		{ProviderID: "openai", Supplier: "openai", Name: "OpenAI", ProviderType: "openai", IsSystem: true, DefaultAPIURL: "https://api.openai.com/v1", SortOrder: 1, CreatedAt: created, UpdatedAt: created},
		{ProviderID: "anthropic", Supplier: "anthropic", Name: "Anthropic", ProviderType: "anthropic", IsSystem: true, DefaultAPIURL: "https://api.anthropic.com", SortOrder: 2, CreatedAt: created, UpdatedAt: created},
		{ProviderID: "gemini", Supplier: "gemini", Name: "Google Gemini", ProviderType: "gemini", IsSystem: true, DefaultAPIURL: "https://generativelanguage.googleapis.com", SortOrder: 3, CreatedAt: created, UpdatedAt: created},
		{ProviderID: "deepseek", Supplier: "deepseek", Name: "DeepSeek", ProviderType: "deepseek", IsSystem: true, DefaultAPIURL: "https://api.deepseek.com/v1", SortOrder: 4, CreatedAt: created, UpdatedAt: created},
		{ProviderID: "ollama", Supplier: "ollama", Name: "Ollama", ProviderType: "ollama", IsSystem: true, DefaultAPIURL: "http://localhost:11434", SortOrder: 5, CreatedAt: created, UpdatedAt: created},
		{ProviderID: "xai", Supplier: "xai", Name: "xAI (Grok)", ProviderType: "openai", IsSystem: true, DefaultAPIURL: "https://api.x.ai/v1", SortOrder: 6, CreatedAt: created, UpdatedAt: created},
	}
}

func (a *LLMConfigAPI) ensureSystemProviders(tenantID string) error {
	providers := systemProviders(time.Now())
	for _, p := range providers {
		var existing pgstore.LLMProvider
		err := a.db.Where("tenant_id = ? AND provider_id = ?", tenantID, p.ProviderID).First(&existing).Error
		if err == nil {
			updates := map[string]any{
				"name":            p.Name,
				"supplier":        p.Supplier,
				"provider_type":   p.ProviderType,
				"is_system":       true,
				"default_api_url": p.DefaultAPIURL,
			}
			if existing.SortOrder <= 0 || existing.SortOrder == 9999 {
				updates["sort_order"] = p.SortOrder
			}
			if err := a.db.Model(&existing).Updates(updates).Error; err != nil {
				return err
			}
			continue
		}
		if err != gorm.ErrRecordNotFound {
			return err
		}

		p.TenantID = tenantID
		if err := a.db.Create(&p).Error; err != nil {
			return err
		}
	}
	return nil
}

func (a *LLMConfigAPI) listProviders(tenantID string) ([]pgstore.LLMProvider, error) {
	if err := a.ensureSystemProviders(tenantID); err != nil {
		return nil, err
	}

	var providers []pgstore.LLMProvider
	if err := a.db.Where("tenant_id = ?", tenantID).Order("sort_order ASC, created_at ASC").Find(&providers).Error; err != nil {
		return nil, err
	}
	return providers, nil
}

func normalizeProviderID(name, providerType string) string {
	base := strings.TrimSpace(name)
	if base == "" {
		base = providerType
	}
	base = strings.ToLower(base)
	var b strings.Builder
	lastUnderscore := false
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	result := strings.Trim(b.String(), "_")
	if result == "" {
		return "provider"
	}
	return result
}

func (a *LLMConfigAPI) list(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var configs []pgstore.LLMConfig
	a.db.Where("tenant_id = ?", tenantID).Find(&configs)
	for i := range configs {
		configs[i].APIKey = maskAPIKey(configs[i].APIKey)
	}
	OK(w, configs)
}

func (a *LLMConfigAPI) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var cfg pgstore.LLMConfig
	if err := a.db.Where("id = ?", id).First(&cfg).Error; err != nil {
		Fail(w, CodeNotFound, "config not found")
		return
	}
	cfg.APIKey = maskAPIKey(cfg.APIKey)
	OK(w, cfg)
}

func (a *LLMConfigAPI) create(w http.ResponseWriter, r *http.Request) {
	var cfg pgstore.LLMConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	cfg.TenantID = middleware.TenantID(r.Context())
	if err := a.db.Create(&cfg).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, cfg)
}

func (a *LLMConfigAPI) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var updates map[string]any
	json.NewDecoder(r.Body).Decode(&updates)

	if err := a.db.Table("llm_configs").Where("id = ?", id).Updates(updates).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	a.registry.Invalidate(id)

	var cfg pgstore.LLMConfig
	a.db.Where("id = ?", id).First(&cfg)
	cfg.APIKey = maskAPIKey(cfg.APIKey)
	OK(w, cfg)
}

func (a *LLMConfigAPI) del(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	a.db.Where("id = ?", id).Delete(&pgstore.LLMConfig{})
	a.registry.Invalidate(id)
	OK(w, M{"ok": true})
}

func (a *LLMConfigAPI) getAPIKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var cfg pgstore.LLMConfig
	if err := a.db.Where("id = ?", id).First(&cfg).Error; err != nil {
		Fail(w, CodeNotFound, "config not found")
		return
	}
	OK(w, M{"api_key": cfg.APIKey})
}

// providers returns the list of supported LLM provider types.
func (a *LLMConfigAPI) providers(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	providers, err := a.listProviders(tenantID)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, providers)
}

func (a *LLMConfigAPI) getProvider(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")
	var provider pgstore.LLMProvider
	if err := a.db.Where("tenant_id = ? AND provider_id = ?", tenantID, id).First(&provider).Error; err != nil {
		Fail(w, CodeNotFound, "provider not found")
		return
	}
	OK(w, provider)
}

func (a *LLMConfigAPI) createProvider(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var payload providerPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	if payload.Name == "" || payload.ProviderType == "" {
		Fail(w, CodeBadRequest, "name and provider_type required")
		return
	}

	providers, err := a.listProviders(tenantID)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	providerID := payload.ProviderID
	if providerID == "" {
		providerID = normalizeProviderID(payload.Name, payload.ProviderType)
	}

	for _, existing := range providers {
		if existing.ProviderID == providerID {
			Fail(w, CodeAlreadyExists, "provider already exists")
			return
		}
	}

	metadata, _ := json.Marshal(payload.Metadata)
	provider := pgstore.LLMProvider{
		TenantID:      tenantID,
		ProviderID:    providerID,
		Supplier:      payload.Supplier,
		Name:          payload.Name,
		ProviderType:  payload.ProviderType,
		IsSystem:      false,
		OverrideURL:   payload.OverrideURL,
		DefaultAPIURL: payload.DefaultAPIURL,
		LogoLight:     payload.LogoLight,
		LogoDark:      payload.LogoDark,
		LogoTheme:     payload.LogoTheme,
		Metadata:      metadata,
		SortOrder:     len(providers) + 1,
	}
	if provider.LogoTheme == "" {
		provider.LogoTheme = "auto"
	}
	if err := a.db.Create(&provider).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	OK(w, M{"provider_id": provider.ProviderID, "message": "created"})
}

func (a *LLMConfigAPI) updateProvider(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")
	var existing pgstore.LLMProvider
	if err := a.db.Where("tenant_id = ? AND provider_id = ?", tenantID, id).First(&existing).Error; err != nil {
		Fail(w, CodeNotFound, "provider not found")
		return
	}

	var payload providerPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}

	if existing.IsSystem && payload.Name == "" && payload.DefaultAPIURL == "" && !payload.OverrideURL && payload.Supplier == "" && payload.ProviderType == "" && payload.LogoLight == "" && payload.LogoDark == "" && payload.LogoTheme == "" && len(payload.Metadata) == 0 {
		OK(w, M{"message": "updated"})
		return
	}

	updates := map[string]any{}
	if payload.Name != "" {
		updates["name"] = payload.Name
	}
	if payload.Supplier != "" {
		updates["supplier"] = payload.Supplier
	}
	if payload.ProviderType != "" {
		updates["provider_type"] = payload.ProviderType
	}
	if payload.DefaultAPIURL != "" {
		updates["default_api_url"] = payload.DefaultAPIURL
	}
	if payload.LogoLight != "" {
		updates["logo_light"] = payload.LogoLight
	}
	if payload.LogoDark != "" {
		updates["logo_dark"] = payload.LogoDark
	}
	if payload.LogoTheme != "" {
		updates["logo_theme"] = payload.LogoTheme
	}
	updates["override_url"] = payload.OverrideURL
	if payload.Metadata != nil {
		metadata, _ := json.Marshal(payload.Metadata)
		updates["metadata"] = metadata
	}

	if err := a.db.Model(&existing).Updates(updates).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"message": "updated"})
}

func (a *LLMConfigAPI) deleteProvider(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	id := chi.URLParam(r, "id")
	var existing pgstore.LLMProvider
	if err := a.db.Where("tenant_id = ? AND provider_id = ?", tenantID, id).First(&existing).Error; err != nil {
		Fail(w, CodeNotFound, "provider not found")
		return
	}
	if existing.IsSystem {
		Fail(w, CodeForbidden, "system provider cannot be deleted")
		return
	}
	if err := a.db.Delete(&existing).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, M{"message": "deleted"})
}

func (a *LLMConfigAPI) reorderProviders(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var payload reorderProvidersPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	if len(payload.ProviderIDs) == 0 {
		Fail(w, CodeBadRequest, "provider_ids required")
		return
	}

	providers, err := a.listProviders(tenantID)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	providerByID := make(map[string]pgstore.LLMProvider, len(providers))
	for _, p := range providers {
		providerByID[p.ProviderID] = p
	}

	seen := make(map[string]bool, len(payload.ProviderIDs))
	for _, id := range payload.ProviderIDs {
		if _, ok := providerByID[id]; !ok {
			Fail(w, CodeInvalidParam, fmt.Sprintf("unknown provider_id: %s", id))
			return
		}
		seen[id] = true
	}

	ordered := make([]string, 0, len(providers))
	ordered = append(ordered, payload.ProviderIDs...)
	remaining := make([]pgstore.LLMProvider, 0)
	for _, p := range providers {
		if !seen[p.ProviderID] {
			remaining = append(remaining, p)
		}
	}
	sort.SliceStable(remaining, func(i, j int) bool {
		if remaining[i].SortOrder != remaining[j].SortOrder {
			return remaining[i].SortOrder < remaining[j].SortOrder
		}
		return remaining[i].ProviderID < remaining[j].ProviderID
	})
	for _, p := range remaining {
		ordered = append(ordered, p.ProviderID)
	}

	updated := 0
	for idx, id := range ordered {
		if err := a.db.Model(&pgstore.LLMProvider{}).
			Where("tenant_id = ? AND provider_id = ?", tenantID, id).
			Updates(map[string]any{"sort_order": idx + 1}).Error; err != nil {
			Fail(w, CodeInternal, err.Error())
			return
		}
		updated++
	}

	OK(w, M{"message": "reordered", "updated": updated})
}

// listModels fetches available models from a provider's API.
// Query params: provider, api_key, api_url, include_capabilities
func (a *LLMConfigAPI) listModels(w http.ResponseWriter, r *http.Request) {
	providerType := r.URL.Query().Get("provider")
	apiKey := r.URL.Query().Get("api_key")
	apiURL := r.URL.Query().Get("api_url")

	if apiKey == "" || providerType == "" {
		Fail(w, CodeBadRequest, "provider and api_key required")
		return
	}

	switch providerType {
	case "openai", "deepseek", "xai":
		models, err := fetchOpenAIModels(apiKey, apiURL)
		if err != nil {
			Fail(w, CodeLLMError, err.Error())
			return
		}
		OK(w, M{"models": models})

	case "gemini":
		models, err := fetchGeminiModels(apiKey, apiURL)
		if err != nil {
			Fail(w, CodeLLMError, err.Error())
			return
		}
		OK(w, M{"models": models})

	case "ollama":
		models, err := fetchOllamaModels(apiURL)
		if err != nil {
			Fail(w, CodeLLMError, err.Error())
			return
		}
		OK(w, M{"models": models})

	default:
		OK(w, M{"models": []any{}})
	}
}

func fetchOpenAIModels(apiKey, apiURL string) ([]M, error) {
	if apiURL == "" {
		apiURL = "https://api.openai.com/v1"
	}
	req, _ := http.NewRequest("GET", apiURL+"/models", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Data []struct {
			ID      string `json:"id"`
			Created int64  `json:"created"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	models := make([]M, 0, len(body.Data))
	for _, m := range body.Data {
		models = append(models, M{"id": m.ID, "name": m.ID})
	}
	return models, nil
}

func fetchGeminiModels(apiKey, apiURL string) ([]M, error) {
	if apiURL == "" {
		apiURL = "https://generativelanguage.googleapis.com"
	}
	url := apiURL + "/v1beta/models?key=" + apiKey
	resp, err := http.DefaultClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Models []struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
			Description string `json:"description"`
		} `json:"models"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	models := make([]M, 0, len(body.Models))
	for _, m := range body.Models {
		// name format: "models/gemini-2.5-flash" → extract "gemini-2.5-flash"
		id := m.Name
		if idx := len("models/"); len(id) > idx && id[:idx] == "models/" {
			id = id[idx:]
		}
		models = append(models, M{
			"id":          id,
			"name":        m.DisplayName,
			"description": m.Description,
		})
	}
	return models, nil
}

func fetchOllamaModels(apiURL string) ([]M, error) {
	if apiURL == "" {
		apiURL = "http://localhost:11434"
	}
	resp, err := http.DefaultClient.Get(apiURL + "/api/tags")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	json.NewDecoder(resp.Body).Decode(&body)
	models := make([]M, 0, len(body.Models))
	for _, m := range body.Models {
		models = append(models, M{"id": m.Name, "name": m.Name})
	}
	return models, nil
}

func maskAPIKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 8 {
		return "••••••••"
	}
	return key[:4] + "••••" + key[len(key)-4:]
}
