package api

import (
	"encoding/json"
	"net/http"
	"strings"

	gwctx "github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

const founderEmail = "tianz8701@gmail.com"

type AdminAPI struct {
	db *gorm.DB
}

func RegisterAdminRoutes(r chi.Router, db *gorm.DB) {
	a := &AdminAPI{db: db}
	r.Get("/api/me", a.me)
	r.Get("/api/admin/memberships", a.listMemberships)
	r.Put("/api/admin/memberships/{tenantID}", a.updateMembership)
}

func isFounderEmail(email string) bool {
	return strings.EqualFold(strings.TrimSpace(email), founderEmail)
}

func (a *AdminAPI) currentUser(r *http.Request) (*pgstore.User, error) {
	var user pgstore.User
	if err := a.db.Where("id = ?", gwctx.UserID(r.Context())).First(&user).Error; err != nil {
		return nil, err
	}
	return &user, nil
}

func (a *AdminAPI) requireFounder(w http.ResponseWriter, r *http.Request) (*pgstore.User, bool) {
	user, err := a.currentUser(r)
	if err != nil {
		Fail(w, CodeUnauthorized, "user not found")
		return nil, false
	}
	if !isFounderEmail(user.Email) {
		Fail(w, CodeForbidden, "founder access required")
		return nil, false
	}
	return user, true
}

func buildMeResponse(db *gorm.DB, user pgstore.User, tenant pgstore.Tenant) M {
	userPayload := buildAuthUser(db, user, tenant)
	plan := effectiveTenantPlanForUser(user, tenant)
	limits := LimitsForPlan(plan)
	// Founders always see ultra-tier limits regardless of stored plan, so
	// internal use never bumps into upsell modals.
	if isFounderEmail(user.Email) {
		limits = LimitsForPlan("ultra")
	}
	return M{
		"user": userPayload,
		"tenant": authTenant{
			ID:   tenant.ID,
			Name: tenant.Name,
			Plan: plan,
		},
		"is_founder": isFounderEmail(user.Email),
		"limits":     limits,
		"usage": M{
			"agents": agentCountForUser(db, user.ID),
		},
	}
}

func (a *AdminAPI) me(w http.ResponseWriter, r *http.Request) {
	user, err := a.currentUser(r)
	if err != nil {
		Fail(w, CodeUnauthorized, "user not found")
		return
	}
	var tenant pgstore.Tenant
	if err := a.db.Where("id = ?", user.TenantID).First(&tenant).Error; err != nil {
		Fail(w, CodeNotFound, "tenant not found")
		return
	}
	OK(w, buildMeResponse(a.db, *user, tenant))
}

func (a *AdminAPI) listMemberships(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireFounder(w, r); !ok {
		return
	}

	type membershipRow struct {
		TenantID   string `json:"tenant_id"`
		TenantName string `json:"tenant_name"`
		Plan       string `json:"plan"`
		UserID     string `json:"user_id"`
		UserName   string `json:"user_name"`
		UserEmail  string `json:"user_email"`
		IsFounder  bool   `json:"is_founder"`
	}

	var rows []membershipRow
	if err := a.db.Table("users AS u").
		Select("u.id AS user_id, u.name AS user_name, u.email AS user_email, t.id AS tenant_id, t.name AS tenant_name, t.plan AS plan").
		Joins("JOIN tenants t ON t.id = u.tenant_id").
		Order("u.created_at ASC").
		Scan(&rows).Error; err != nil {
		Fail(w, CodeInternal, "list memberships failed")
		return
	}

	for i := range rows {
		rows[i].IsFounder = isFounderEmail(rows[i].UserEmail)
	}

	OK(w, M{"items": rows})
}

func (a *AdminAPI) updateMembership(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireFounder(w, r); !ok {
		return
	}

	var req struct {
		Plan string `json:"plan"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Fail(w, CodeBadRequest, "invalid body")
		return
	}
	plan := strings.TrimSpace(strings.ToLower(req.Plan))
	if plan != "free" && plan != "pro" && plan != "ultra" {
		Fail(w, CodeInvalidParam, "invalid plan")
		return
	}

	tenantID := chi.URLParam(r, "tenantID")
	if tenantID == "" {
		Fail(w, CodeInvalidParam, "tenant id required")
		return
	}

	if err := a.db.Model(&pgstore.Tenant{}).Where("id = ?", tenantID).Update("plan", plan).Error; err != nil {
		Fail(w, CodeInternal, "update membership failed")
		return
	}

	var tenant pgstore.Tenant
	if err := a.db.Where("id = ?", tenantID).First(&tenant).Error; err != nil {
		Fail(w, CodeNotFound, "tenant not found")
		return
	}

	OK(w, M{
		"tenant": authTenant{ID: tenant.ID, Name: tenant.Name, Plan: tenant.Plan},
	})
}
