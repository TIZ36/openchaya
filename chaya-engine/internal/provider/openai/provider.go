package openai

import (
	"context"
	"fmt"
	"io"
	"log/slog"

	"github.com/chaya-ai/chaya-engine/internal/provider"
	"github.com/sashabaranov/go-openai"
)

type Provider struct {
	client *openai.Client
	model  string
}

func init() {
	provider.RegisterFactory(func(apiKey, apiURL, model string) (provider.LLMProvider, error) {
		return New(apiKey, apiURL, model), nil
	})
}

func New(apiKey, apiURL, model string) *Provider {
	config := openai.DefaultConfig(apiKey)
	if apiURL != "" {
		config.BaseURL = apiURL
	}
	return &Provider{
		client: openai.NewClientWithConfig(config),
		model:  model,
	}
}

func (p *Provider) Name() string { return "openai" }

func (p *Provider) Chat(ctx context.Context, req provider.ChatRequest) (*provider.ChatResponse, error) {
	model := req.Model
	if model == "" {
		model = p.model
	}

	oaiReq := openai.ChatCompletionRequest{
		Model:    model,
		Messages: toOAIMessages(req.Messages),
	}
	if req.Temperature != nil {
		oaiReq.Temperature = float32(*req.Temperature)
	}
	if req.MaxTokens > 0 {
		oaiReq.MaxTokens = req.MaxTokens
	}
	if len(req.Tools) > 0 {
		oaiReq.Tools = toOAITools(req.Tools)
		if req.ToolChoice != "" {
			oaiReq.ToolChoice = req.ToolChoice
		}
	}

	resp, err := p.client.CreateChatCompletion(ctx, oaiReq)
	if err != nil {
		return nil, fmt.Errorf("openai chat: %w", err)
	}

	choice := resp.Choices[0]
	result := &provider.ChatResponse{
		Content: choice.Message.Content,
		Model:   resp.Model,
	}
	if resp.Usage.PromptTokens > 0 {
		result.TokensIn = resp.Usage.PromptTokens
		result.TokensOut = resp.Usage.CompletionTokens
	}
	for _, tc := range choice.Message.ToolCalls {
		result.ToolCalls = append(result.ToolCalls, provider.ToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: tc.Function.Arguments,
		})
	}
	return result, nil
}

func (p *Provider) ChatStream(ctx context.Context, req provider.ChatRequest) (<-chan provider.StreamChunk, error) {
	model := req.Model
	if model == "" {
		model = p.model
	}

	oaiReq := openai.ChatCompletionRequest{
		Model:    model,
		Messages: toOAIMessages(req.Messages),
		Stream:   true,
	}
	if req.Temperature != nil {
		oaiReq.Temperature = float32(*req.Temperature)
	}
	if len(req.Tools) > 0 {
		oaiReq.Tools = toOAITools(req.Tools)
	}

	stream, err := p.client.CreateChatCompletionStream(ctx, oaiReq)
	if err != nil {
		return nil, fmt.Errorf("openai stream: %w", err)
	}

	ch := make(chan provider.StreamChunk, 64)
	go func() {
		defer close(ch)
		defer stream.Close()

		for {
			resp, err := stream.Recv()
			if err == io.EOF {
				ch <- provider.StreamChunk{Done: true}
				return
			}
			if err != nil {
				slog.Error("openai stream recv", "err", err)
				ch <- provider.StreamChunk{Done: true}
				return
			}
			if len(resp.Choices) > 0 {
				delta := resp.Choices[0].Delta
				if delta.Content != "" {
					ch <- provider.StreamChunk{Content: delta.Content}
				}
			}
		}
	}()

	return ch, nil
}

func toOAIMessages(msgs []provider.Message) []openai.ChatCompletionMessage {
	out := make([]openai.ChatCompletionMessage, len(msgs))
	for i, m := range msgs {
		msg := openai.ChatCompletionMessage{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
		}
		for _, tc := range m.ToolCalls {
			msg.ToolCalls = append(msg.ToolCalls, openai.ToolCall{
				ID:   tc.ID,
				Type: openai.ToolTypeFunction,
				Function: openai.FunctionCall{
					Name:      tc.Name,
					Arguments: tc.Arguments,
				},
			})
		}
		out[i] = msg
	}
	return out
}

func toOAITools(tools []provider.Tool) []openai.Tool {
	out := make([]openai.Tool, len(tools))
	for i, t := range tools {
		out[i] = openai.Tool{
			Type: openai.ToolTypeFunction,
			Function: &openai.FunctionDefinition{
				Name:        t.Function.Name,
				Description: t.Function.Description,
				Parameters:  t.Function.Parameters,
			},
		}
	}
	return out
}
