// Gemini LLM adapter (google.golang.org/genai). Kept in package provider (not under internal/channel/gemini)
// to avoid an import cycle: api imports provider; a provider/gemini subpackage would import provider back.
package provider

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	geminichannel "github.com/chaya-ai/chaya-engine/internal/channel/gemini"
	"google.golang.org/genai"
)

// geminiLLM implements LLMProvider using google.golang.org/genai (Gemini Developer API).
type geminiLLM struct {
	client *genai.Client
	model  string
}

func newGeminiLLM(apiKey, apiURL, model string) (LLMProvider, error) {
	ctx := context.Background()
	c, err := geminichannel.NewClient(ctx, apiKey, apiURL)
	if err != nil {
		return nil, err
	}
	return &geminiLLM{client: c, model: model}, nil
}

func (g *geminiLLM) Name() string { return "gemini" }

func (g *geminiLLM) modelOr(req string) string {
	if strings.TrimSpace(req) != "" {
		return geminichannel.NormalizeModel(req)
	}
	return geminichannel.NormalizeModel(g.model)
}

func (g *geminiLLM) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	model := g.modelOr(req.Model)
	sys, contents, err := geminiProviderMessagesToGenAI(req.Messages)
	if err != nil {
		return nil, fmt.Errorf("gemini chat: %w", err)
	}
	cfg := &genai.GenerateContentConfig{SystemInstruction: sys}
	if req.Temperature != nil {
		t := float32(*req.Temperature)
		cfg.Temperature = &t
	}
	if req.MaxTokens > 0 {
		cfg.MaxOutputTokens = int32(req.MaxTokens)
	}
	if len(req.Tools) > 0 {
		tools, terr := geminiProviderToolsToGenAITools(req.Tools)
		if terr != nil {
			return nil, fmt.Errorf("gemini chat tools: %w", terr)
		}
		cfg.Tools = tools
		cfg.ToolConfig = geminiGenAIToolConfig(req.ToolChoice)
	}

	resp, err := g.client.Models.GenerateContent(ctx, model, contents, cfg)
	if err != nil {
		return nil, fmt.Errorf("gemini chat: %w", err)
	}
	toolCalls, text, err := geminiToolCallsFromResponse(resp)
	if err != nil {
		return nil, err
	}
	if text == "" && resp != nil {
		text = resp.Text()
	}
	out := &ChatResponse{Content: text, ToolCalls: toolCalls, Model: model}
	if resp != nil && resp.UsageMetadata != nil {
		out.TokensIn = int(resp.UsageMetadata.PromptTokenCount)
		out.TokensOut = int(resp.UsageMetadata.CandidatesTokenCount)
	}
	return out, nil
}

func (g *geminiLLM) ChatStream(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error) {
	model := g.modelOr(req.Model)
	sys, contents, err := geminiProviderMessagesToGenAI(req.Messages)
	if err != nil {
		return nil, fmt.Errorf("gemini stream: %w", err)
	}
	cfg := &genai.GenerateContentConfig{SystemInstruction: sys}
	if req.Temperature != nil {
		t := float32(*req.Temperature)
		cfg.Temperature = &t
	}
	if req.MaxTokens > 0 {
		cfg.MaxOutputTokens = int32(req.MaxTokens)
	}
	if len(req.Tools) > 0 {
		tools, terr := geminiProviderToolsToGenAITools(req.Tools)
		if terr != nil {
			return nil, fmt.Errorf("gemini stream tools: %w", terr)
		}
		cfg.Tools = tools
		cfg.ToolConfig = geminiGenAIToolConfig(req.ToolChoice)
	}

	ch := make(chan StreamChunk, 64)
	go func() {
		defer close(ch)
		defer func() { ch <- StreamChunk{Done: true} }()
		var full string
		for resp, serr := range g.client.Models.GenerateContentStream(ctx, model, contents, cfg) {
			if serr != nil {
				slog.Error("gemini stream", "err", serr)
				return
			}
			if resp == nil {
				continue
			}
			chunkText := resp.Text()
			if strings.TrimSpace(chunkText) == "" {
				continue
			}
			var delta string
			if strings.HasPrefix(chunkText, full) {
				delta = chunkText[len(full):]
				full = chunkText
			} else {
				delta = chunkText
				full += chunkText
			}
			if delta != "" {
				ch <- StreamChunk{Content: delta}
			}
		}
	}()
	return ch, nil
}
