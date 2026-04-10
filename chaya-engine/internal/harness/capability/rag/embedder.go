package rag

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Embedder generates embedding vectors. Supports API providers and local Python sidecar.
type Embedder struct {
	mode       string // "api" or "sidecar"
	apiKey     string
	apiURL     string
	model      string
	sidecarURL string // e.g. http://localhost:8100
	httpClient *http.Client
}

// EmbedderConfig configures the embedding backend.
type EmbedderConfig struct {
	Mode       string `json:"mode"`        // "api" (OpenAI) or "sidecar" (Python)
	APIKey     string `json:"api_key"`
	APIURL     string `json:"api_url"`     // default: https://api.openai.com/v1
	Model      string `json:"model"`       // default: text-embedding-3-small
	SidecarURL string `json:"sidecar_url"` // default: http://localhost:8100
}

func NewEmbedder(cfg EmbedderConfig) *Embedder {
	if cfg.Mode == "" {
		cfg.Mode = "sidecar"
	}
	if cfg.APIURL == "" {
		cfg.APIURL = "https://api.openai.com/v1"
	}
	if cfg.Model == "" {
		cfg.Model = "text-embedding-3-small"
	}
	if cfg.SidecarURL == "" {
		cfg.SidecarURL = "http://localhost:8100"
	}
	return &Embedder{
		mode:       cfg.Mode,
		apiKey:     cfg.APIKey,
		apiURL:     cfg.APIURL,
		model:      cfg.Model,
		sidecarURL: cfg.SidecarURL,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// Embed generates embeddings for a batch of texts.
func (e *Embedder) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	switch e.mode {
	case "sidecar":
		return e.embedSidecar(ctx, texts)
	default:
		return e.embedAPI(ctx, texts)
	}
}

// Dims returns the expected embedding dimension.
func (e *Embedder) Dims() int {
	if e.mode == "sidecar" {
		return 384 // sentence-transformers paraphrase-multilingual-MiniLM-L12-v2 (chaya-ml default)
	}
	switch e.model {
	case "text-embedding-3-small":
		return 1536
	case "text-embedding-3-large":
		return 3072
	default:
		return 1536
	}
}

// embedAPI calls OpenAI-compatible embedding API.
func (e *Embedder) embedAPI(ctx context.Context, texts []string) ([][]float32, error) {
	body, _ := json.Marshal(map[string]any{
		"model": e.model,
		"input": texts,
	})

	req, _ := http.NewRequestWithContext(ctx, "POST", e.apiURL+"/embeddings", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.apiKey)

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("embedding api: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("embedding api %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Data []struct {
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse embedding: %w", err)
	}

	vectors := make([][]float32, len(result.Data))
	for i, d := range result.Data {
		vectors[i] = d.Embedding
	}
	return vectors, nil
}

// embedSidecar calls the Python FastAPI sidecar.
func (e *Embedder) embedSidecar(ctx context.Context, texts []string) ([][]float32, error) {
	body, _ := json.Marshal(map[string]any{"texts": texts})

	req, _ := http.NewRequestWithContext(ctx, "POST", e.sidecarURL+"/embed", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sidecar embed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("sidecar %d: %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		Embeddings [][]float32 `json:"embeddings"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parse sidecar: %w", err)
	}
	return result.Embeddings, nil
}
