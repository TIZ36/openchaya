package provider

import (
	"fmt"
	"sync"

	"gorm.io/gorm"
)

// Registry manages LLM provider instances, loading API keys from DB on demand.
type Registry struct {
	db        *gorm.DB
	providers map[string]LLMProvider // configID → provider
	mu        sync.RWMutex
}

// LLMConfigRow mirrors the llm_configs table.
type LLMConfigRow struct {
	ID       string `gorm:"column:id"`
	Provider string `gorm:"column:provider"`
	Model    string `gorm:"column:model"`
	APIKey   string `gorm:"column:api_key"`
	APIURL   string `gorm:"column:api_url"`
	Enabled  bool   `gorm:"column:enabled"`
}

func (LLMConfigRow) TableName() string { return "llm_configs" }

func NewRegistry(db *gorm.DB) *Registry {
	return &Registry{
		db:        db,
		providers: make(map[string]LLMProvider),
	}
}

// Get returns a provider for the given config ID, creating it on first access.
func (r *Registry) Get(configID string) (LLMProvider, error) {
	r.mu.RLock()
	if p, ok := r.providers[configID]; ok {
		r.mu.RUnlock()
		return p, nil
	}
	r.mu.RUnlock()

	// Load from DB
	var row LLMConfigRow
	if err := r.db.Where("id = ? AND enabled = true", configID).First(&row).Error; err != nil {
		return nil, fmt.Errorf("llm config %s not found: %w", configID, err)
	}

	p, err := r.createProvider(row)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	r.providers[configID] = p
	r.mu.Unlock()

	return p, nil
}

// GetAny returns the first available enabled provider. Used when no specific config is set.
func (r *Registry) GetAny() (LLMProvider, string, error) {
	var row LLMConfigRow
	if err := r.db.Where("enabled = true").First(&row).Error; err != nil {
		return nil, "", fmt.Errorf("no enabled llm config: %w", err)
	}

	p, err := r.Get(row.ID)
	return p, row.ID, err
}

// Invalidate removes a cached provider (e.g., after config update).
func (r *Registry) Invalidate(configID string) {
	r.mu.Lock()
	delete(r.providers, configID)
	r.mu.Unlock()
}

func (r *Registry) createProvider(row LLMConfigRow) (LLMProvider, error) {
	switch row.Provider {
	case "gemini", "google":
		return newGeminiLLM(row.APIKey, row.APIURL, row.Model)
	case "openai", "deepseek":
		return newOpenAILLM(row.APIKey, row.APIURL, row.Model)
	default:
		return newOpenAILLM(row.APIKey, row.APIURL, row.Model)
	}
}
