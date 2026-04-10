// Package intelligence contains the "brain" layer: model routing,
// intent classification, persona, and knowledge topology.
package intelligence

import (
	"strings"
)

// Complexity levels for model routing.
const (
	ComplexityLow    = 0.2 // greetings, simple Q&A → cheap model
	ComplexityMedium = 0.5 // multi-step reasoning → mid model
	ComplexityHigh   = 0.8 // deep analysis, code → large model
)

// ModelTier maps complexity to model preference.
type ModelTier struct {
	MinComplexity float64
	Provider      string
	Model         string
}

// Router selects the best model for a given task based on complexity.
type Router struct {
	tiers []ModelTier
}

// DefaultRouter creates a router with sensible defaults.
// Users configure actual models via llm_configs; this maps complexity → tier name.
func DefaultRouter() *Router {
	return &Router{
		tiers: []ModelTier{
			{MinComplexity: 0.7, Provider: "anthropic", Model: "claude-sonnet-4-20250514"},
			{MinComplexity: 0.3, Provider: "openai", Model: "gpt-4o"},
			{MinComplexity: 0.0, Provider: "openai", Model: "gpt-4o-mini"},
		},
	}
}

// Route returns the recommended model tier for a message.
func (r *Router) Route(userMsg string) ModelTier {
	complexity := EstimateComplexity(userMsg)
	for _, tier := range r.tiers {
		if complexity >= tier.MinComplexity {
			return tier
		}
	}
	return r.tiers[len(r.tiers)-1] // fallback: cheapest
}

// EstimateComplexity does a quick heuristic complexity score (0-1).
// No LLM call — pure heuristics for speed.
func EstimateComplexity(msg string) float64 {
	score := 0.3 // baseline

	msgLen := len(msg)
	lower := strings.ToLower(msg)

	// Length factor
	if msgLen > 500 {
		score += 0.2
	} else if msgLen > 200 {
		score += 0.1
	} else if msgLen < 20 {
		score -= 0.15
	}

	// Complexity indicators
	complexIndicators := []string{
		"分析", "analyze", "比较", "compare", "设计", "design",
		"重构", "refactor", "架构", "architecture", "优化", "optimize",
		"调试", "debug", "解释", "explain why", "为什么",
		"代码", "code", "实现", "implement", "算法", "algorithm",
	}
	for _, ind := range complexIndicators {
		if strings.Contains(lower, ind) {
			score += 0.15
			break
		}
	}

	// Simple indicators
	simpleIndicators := []string{
		"你好", "hello", "hi", "嗨", "谢谢", "thanks",
		"是什么", "what is", "几点", "天气",
	}
	for _, ind := range simpleIndicators {
		if strings.Contains(lower, ind) {
			score -= 0.15
			break
		}
	}

	// Multi-step indicators (questions with multiple parts)
	if strings.Count(msg, "？") + strings.Count(msg, "?") > 2 {
		score += 0.1
	}

	// Code block
	if strings.Contains(msg, "```") {
		score += 0.2
	}

	// Clamp
	if score < 0 {
		score = 0
	}
	if score > 1 {
		score = 1
	}

	return score
}
