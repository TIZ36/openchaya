package api

import (
	"fmt"

	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

// PlanLimits is the per-plan caps surface exposed at /api/me and enforced
// at create endpoints (currently agents; future: kb_mb, daily_tokens, ...).
//
// A value of -1 means "unlimited" — the frontend treats negative numbers
// as ∞ when rendering "X / N" usage badges.
type PlanLimits struct {
	Agents   int  `json:"agents"`
	DarkMode bool `json:"dark_mode"`
}

// LimitsForPlan is the canonical mapping. Keep this in one place so backend
// enforcement and frontend display can never drift; the frontend reads the
// numbers from /api/me, not from a hard-coded JS table.
func LimitsForPlan(plan string) PlanLimits {
	switch plan {
	case "ultra":
		return PlanLimits{Agents: -1, DarkMode: true}
	case "pro":
		return PlanLimits{Agents: 5, DarkMode: true}
	default: // free
		return PlanLimits{Agents: 1, DarkMode: false}
	}
}

// agentCountForUser is the current usage for the agent limit. Counts every
// row owned by the user — includes the primary agent (which is always 1
// out of the box, so a Free user with the primary alone is "1 / 1").
func agentCountForUser(db *gorm.DB, userID string) int64 {
	var n int64
	db.Model(&pgstore.Agent{}).Where("user_id = ?", userID).Count(&n)
	return n
}

// checkAgentCreateAllowed returns a user-facing error string if creating
// another agent would exceed the user's plan cap. Founders + ultra plans
// always pass (limit < 0 means unlimited).
func (a *AgentAPI) checkAgentCreateAllowed(_ interface{}, userID string) error {
	var user pgstore.User
	if err := a.db.Where("id = ?", userID).First(&user).Error; err != nil {
		return nil // unknown user → defer to downstream auth, don't block here
	}
	var tenant pgstore.Tenant
	a.db.Where("id = ?", user.TenantID).First(&tenant)
	plan := effectiveTenantPlanForUser(user, tenant)
	limits := LimitsForPlan(plan)
	if isFounderEmail(user.Email) {
		limits = LimitsForPlan("ultra")
	}
	if limits.Agents < 0 {
		return nil
	}
	count := agentCountForUser(a.db, userID)
	if count >= int64(limits.Agents) {
		return fmt.Errorf("plan_limit:agents 当前 %s 套餐最多 %d 个 agent，已用 %d", plan, limits.Agents, count)
	}
	return nil
}
