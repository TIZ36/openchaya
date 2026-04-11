// Package openai builds OpenAI-protocol SDK clients (OpenAI, DeepSeek, xAI, …).
// LLMProvider implementation is in internal/provider/openai_llm.go (import go-openai as oai there).
package openai

import oai "github.com/sashabaranov/go-openai"

// NewClient returns a configured go-openai client.
func NewClient(apiKey, baseURL string) *oai.Client {
	cfg := oai.DefaultConfig(apiKey)
	if baseURL != "" {
		cfg.BaseURL = baseURL
	}
	return oai.NewClientWithConfig(cfg)
}
