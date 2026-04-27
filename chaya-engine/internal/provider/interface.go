package provider

import "context"

// StreamChunk represents a single chunk in a streaming response.
type StreamChunk struct {
	Content   string `json:"content,omitempty"`
	Reasoning string `json:"reasoning,omitempty"`
	Done      bool   `json:"done,omitempty"`
}

// ChatRequest is the input for a chat completion.
type ChatRequest struct {
	Messages    []Message          `json:"messages"`
	Model       string             `json:"model,omitempty"`
	Tools       []Tool             `json:"tools,omitempty"`
	ToolChoice  string             `json:"tool_choice,omitempty"` // auto / none / required
	Temperature *float64           `json:"temperature,omitempty"`
	MaxTokens   int                `json:"max_tokens,omitempty"`
}

// Message is a single message in the conversation.
type Message struct {
	Role       string     `json:"role"`                      // system / user / assistant / tool
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`       // assistant's tool call requests
	ToolCallID string     `json:"tool_call_id,omitempty"`     // for role=tool responses
	// Reasoning carries the assistant's "thinking" output (DeepSeek-Reasoner /
	// Qwen-thinking / etc.). When the model emits reasoning_content in turn N,
	// we MUST pass it back in turn N+1's history or the API rejects the
	// follow-up with HTTP 400 "reasoning_content must be passed back".
	Reasoning  string     `json:"reasoning,omitempty"`
}

// Tool is an OpenAI-compatible function/tool definition.
type Tool struct {
	Type     string       `json:"type"` // function
	Function ToolFunction `json:"function"`
}

type ToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"`
}

// ChatResponse is the result of a non-streaming chat.
type ChatResponse struct {
	Content    string     `json:"content"`
	Reasoning  string     `json:"reasoning,omitempty"` // see Message.Reasoning
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	TokensIn   int        `json:"tokens_in"`
	TokensOut  int        `json:"tokens_out"`
	Model      string     `json:"model"`
}

type ToolCall struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Arguments string `json:"arguments"` // JSON string
}

// LLMProvider is the interface all providers implement.
type LLMProvider interface {
	// Chat performs a non-streaming chat completion.
	Chat(ctx context.Context, req ChatRequest) (*ChatResponse, error)

	// ChatStream performs a streaming chat completion.
	// Returns a channel that yields chunks, closed when done.
	ChatStream(ctx context.Context, req ChatRequest) (<-chan StreamChunk, error)

	// Name returns the provider identifier.
	Name() string
}
