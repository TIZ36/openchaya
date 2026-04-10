package metrics

import (
	"log/slog"

	"github.com/chaya-ai/chaya-engine/internal/harness/budget"
	"github.com/chaya-ai/chaya-engine/internal/provider"
)

// LogHarnessRoute emits a structured log line for delegation routing observability.
func LogHarnessRoute(convID, phase, routeKind string, delegate bool) {
	slog.Info("harness_route", "harness", "route", "conv_id", convID, "phase", phase, "route_kind", routeKind, "delegate", delegate)
}

// LogHarnessLLMPhase logs estimated token usage for a non-streaming harness LLM call.
func LogHarnessLLMPhase(convID, phase string, messages []provider.Message, response string, err error) {
	inTok := 0
	for _, m := range messages {
		inTok += budget.EstimateTokens(m.Content)
	}
	outTok := budget.EstimateTokens(response)
	if err != nil {
		slog.Warn("harness_llm_phase", "harness", "llm", "conv_id", convID, "phase", phase,
			"est_tokens_in", inTok, "est_tokens_out", outTok, "err", err.Error())
		return
	}
	slog.Info("harness_llm_phase", "harness", "llm", "conv_id", convID, "phase", phase,
		"est_tokens_in", inTok, "est_tokens_out", outTok)
}

// LogHarnessDelegationComplete summarizes a delegateAndSummarize cycle.
func LogHarnessDelegationComplete(convID, finalRoute string, taskCount int, cacheHits int, launched int) {
	slog.Info("harness_delegation_complete", "harness", "delegation",
		"conv_id", convID, "final_route", finalRoute, "task_count", taskCount,
		"cache_hits", cacheHits, "launched", launched)
}
