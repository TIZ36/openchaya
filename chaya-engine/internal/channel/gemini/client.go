package gemini

import (
	"context"
	"fmt"

	"google.golang.org/genai"
)

// NewClient builds a Gemini Developer API client. apiURL is optional (empty = SDK default).
func NewClient(ctx context.Context, apiKey, apiURL string) (*genai.Client, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("gemini: api key is required")
	}
	cc := &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	}
	if base := NormalizeBaseURL(apiURL); base != "" {
		cc.HTTPOptions.BaseURL = base
	}
	return genai.NewClient(ctx, cc)
}
