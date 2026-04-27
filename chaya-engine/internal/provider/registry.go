package provider

import (
	"fmt"
	"strings"
	"sync"

	"gorm.io/gorm"
)

// IsReasoningModel returns true if the model name suggests it emits
// reasoning_content (DeepSeek-Reasoner, Qwen-thinking, OpenAI o1/o3, R1
// derivatives, Claude extended-thinking, Gemini 2.5 thinking).
//
// Used by ancillary tasks (followups, summaries, classification) to avoid
// burning a long thinking budget on a one-shot call where reasoning
// adds no value but consumes the entire MaxTokens allowance.
func IsReasoningModel(name string) bool {
	s := strings.ToLower(strings.TrimSpace(name))
	if s == "" {
		return false
	}
	for _, hint := range []string{
		"reasoner", "reasoning", "thinking", "think",
		"-r1", "/r1", "deepseek-r", "qwen3",
		"o1-", "o3-", "o4-",
	} {
		if strings.Contains(s, hint) {
			return true
		}
	}
	return false
}

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

// FallbackCandidate is one entry in a ranked provider chain.
type FallbackCandidate struct {
	Provider  LLMProvider
	Model     string
	ConfigID  string
	Reasoning bool // true if the model is in the reasoning family
}

// FollowupChain returns up to 3 candidates for low-stakes side calls
// (followup suggestions, classification, etc.). Order:
//  1. preferredID, only if it's NOT a reasoning model (fast direct path)
//  2. cheapest non-reasoning enabled config in DB (typical fallback)
//  3. preferredID even if reasoning (last resort — caller will need to
//     bump MaxTokens to leave room for thinking + actual answer)
//
// Skips duplicates so the same config isn't tried twice.
func (r *Registry) FollowupChain(preferredID string) []FallbackCandidate {
	var out []FallbackCandidate
	seen := map[string]bool{}

	add := func(row LLMConfigRow) {
		if seen[row.ID] {
			return
		}
		p, err := r.Get(row.ID)
		if err != nil || p == nil {
			return
		}
		out = append(out, FallbackCandidate{
			Provider:  p,
			Model:     row.Model,
			ConfigID:  row.ID,
			Reasoning: IsReasoningModel(row.Model),
		})
		seen[row.ID] = true
	}

	loadRow := func(id string) (LLMConfigRow, bool) {
		var row LLMConfigRow
		if err := r.db.Where("id = ? AND enabled = true", id).First(&row).Error; err != nil {
			return row, false
		}
		return row, true
	}

	// Slot 1: preferred, if non-reasoning
	if preferredID != "" {
		if row, ok := loadRow(preferredID); ok && !IsReasoningModel(row.Model) {
			add(row)
		}
	}

	// Slot 2: cheapest non-reasoning sibling. We don't have a real "cost"
	// column so we go by created_at — the user's first config is usually
	// their go-to. This avoids picking up something exotic at random.
	var rows []LLMConfigRow
	if err := r.db.Where("enabled = true").Order("created_at asc").Limit(8).Find(&rows).Error; err == nil {
		for _, row := range rows {
			if !IsReasoningModel(row.Model) {
				add(row)
				break
			}
		}
	}

	// Slot 3: preferred again, even if reasoning (last-resort fallback)
	if preferredID != "" {
		if row, ok := loadRow(preferredID); ok {
			add(row)
		}
	}

	return out
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
