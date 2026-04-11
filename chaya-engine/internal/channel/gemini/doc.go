// Package gemini holds Gemini Developer API integrations shared by HTTP handlers:
// client construction, LLM config resolution, image generate/edit, and video (Veo) flows.
// The chat/stream LLM provider implementation lives in internal/provider as gemini_llm.go
// because it must implement provider.LLMProvider without creating a provider↔subpackage cycle.
package gemini
