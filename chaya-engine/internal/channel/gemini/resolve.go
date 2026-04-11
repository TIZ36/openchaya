package gemini

import (
	"fmt"
	"strings"

	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

// ResolveLLMConfig loads enabled Gemini LLM config for a tenant.
func ResolveLLMConfig(db *gorm.DB, tenantID, configID string) (apiKey, baseURL, model string, err error) {
	var cfg pgstore.LLMConfig
	q := db.Where("tenant_id = ? AND enabled = true", tenantID)
	if configID != "" {
		q = q.Where("id = ?", configID)
	} else {
		q = q.Where("provider = ?", "gemini")
	}
	if err := q.First(&cfg).Error; err != nil {
		return "", "", "", fmt.Errorf("gemini config not found")
	}
	base := strings.TrimSpace(cfg.APIURL)
	if base == "" {
		base = strings.TrimSuffix(DefaultAPIBase, "/")
	}
	return cfg.APIKey, base, cfg.Model, nil
}
