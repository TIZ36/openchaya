package provider

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"

	chopenai "github.com/chaya-ai/chaya-engine/internal/channel/openai"
	oai "github.com/sashabaranov/go-openai"
)

// openaiLLM implements LLMProvider for OpenAI-compatible APIs (OpenAI, DeepSeek, xAI, …).
type openaiLLM struct {
	client *oai.Client
	model  string
}

func newOpenAILLM(apiKey, apiURL, model string) (LLMProvider, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("openai-compatible: api key is required")
	}
	return &openaiLLM{
		client: chopenai.NewClient(apiKey, apiURL),
		model:  strings.TrimSpace(model),
	}, nil
}

func (p *openaiLLM) Name() string { return "openai" }

func (p *openaiLLM) modelOr(req string) string {
	if strings.TrimSpace(req) != "" {
		return strings.TrimSpace(req)
	}
	return p.model
}

func (p *openaiLLM) Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	model := p.modelOr(req.Model)

	oaiReq := oai.ChatCompletionRequest{
		Model:    model,
		Messages: openaiToOAIMessages(req.Messages),
	}
	if req.Temperature != nil {
		oaiReq.Temperature = float32(*req.Temperature)
	}
	if req.MaxTokens > 0 {
		oaiReq.MaxTokens = req.MaxTokens
	}
	if len(req.Tools) > 0 {
		oaiReq.Tools = openaiToOAITools(req.Tools)
		if req.ToolChoice != "" {
			oaiReq.ToolChoice = req.ToolChoice
		}
	}

	resp, err := p.client.CreateChatCompletion(ctx, oaiReq)
	if err != nil {
		return nil, fmt.Errorf("openai chat: %w", err)
	}

	choice := resp.Choices[0]
	result := &ChatResponse{
		Content: choice.Message.Content,
		Model:   resp.Model,
	}
	if resp.Usage.PromptTokens > 0 {
		result.TokensIn = resp.Usage.PromptTokens
		result.TokensOut = resp.Usage.CompletionTokens
	}
	for _, tc := range choice.Message.ToolCalls {
		result.ToolCalls = append(result.ToolCalls, ToolCall{
			ID:        tc.ID,
			Name:      tc.Function.Name,
			Arguments: tc.Function.Arguments,
		})
	}
	return result, nil
}

func (p *openaiLLM) ChatStream(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error) {
	model := p.modelOr(req.Model)

	oaiReq := oai.ChatCompletionRequest{
		Model:    model,
		Messages: openaiToOAIMessages(req.Messages),
		Stream:   true,
	}
	if req.Temperature != nil {
		oaiReq.Temperature = float32(*req.Temperature)
	}
	if len(req.Tools) > 0 {
		oaiReq.Tools = openaiToOAITools(req.Tools)
		if req.ToolChoice != "" {
			oaiReq.ToolChoice = req.ToolChoice
		}
	}

	stream, err := p.client.CreateChatCompletionStream(ctx, oaiReq)
	if err != nil {
		return nil, fmt.Errorf("openai stream: %w", err)
	}

	ch := make(chan StreamChunk, 64)
	go func() {
		defer stream.Close()
		defer close(ch)
		defer func() { ch <- StreamChunk{Done: true} }()

		for {
			resp, err := stream.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				slog.Error("openai stream recv", "err", err)
				return
			}
			if len(resp.Choices) == 0 {
				continue
			}
			delta := resp.Choices[0].Delta
			if delta.Content != "" {
				ch <- StreamChunk{Content: delta.Content}
			}
		}
	}()

	return ch, nil
}

func openaiToOAIMessages(msgs []Message) []oai.ChatCompletionMessage {
	out := make([]oai.ChatCompletionMessage, len(msgs))
	for i, m := range msgs {
		msg := oai.ChatCompletionMessage{
			Role:       m.Role,
			Content:    m.Content,
			ToolCallID: m.ToolCallID,
		}
		for _, tc := range m.ToolCalls {
			msg.ToolCalls = append(msg.ToolCalls, oai.ToolCall{
				ID:   tc.ID,
				Type: oai.ToolTypeFunction,
				Function: oai.FunctionCall{
					Name:      tc.Name,
					Arguments: tc.Arguments,
				},
			})
		}
		out[i] = msg
	}
	return out
}

func openaiToOAITools(tools []Tool) []oai.Tool {
	out := make([]oai.Tool, len(tools))
	for i, t := range tools {
		out[i] = oai.Tool{
			Type: oai.ToolTypeFunction,
			Function: &oai.FunctionDefinition{
				Name:        t.Function.Name,
				Description: t.Function.Description,
				Parameters:  t.Function.Parameters,
			},
		}
	}
	return out
}
