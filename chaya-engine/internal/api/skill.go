package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

type SkillAPI struct {
	db *gorm.DB
}

func RegisterSkillRoutes(r chi.Router, db *gorm.DB) {
	a := &SkillAPI{db: db}
	r.Get("/api/skills", a.list)
	r.Post("/api/skills", a.create)
	r.Get("/api/skills/{id}", a.get)
	r.Put("/api/skills/{id}", a.update)
	r.Delete("/api/skills/{id}", a.del)
}

func (a *SkillAPI) list(w http.ResponseWriter, r *http.Request) {
	tenantID := middleware.TenantID(r.Context())
	var skills []pgstore.Skill
	a.db.Where("tenant_id = ?", tenantID).Find(&skills)
	OK(w, skills)
}

func (a *SkillAPI) create(w http.ResponseWriter, r *http.Request) {
	var s pgstore.Skill
	json.NewDecoder(r.Body).Decode(&s)
	s.TenantID = middleware.TenantID(r.Context())
	if s.Name == "" {
		Fail(w, CodeInvalidParam, "name required")
		return
	}
	if len(s.Steps) == 0 {
		s.Steps = json.RawMessage(`[]`)
	}
	if len(s.Keywords) == 0 {
		s.Keywords = json.RawMessage(`[]`)
	}
	if len(s.RequiredMCP) == 0 {
		s.RequiredMCP = json.RawMessage(`[]`)
	}
	if err := a.db.Create(&s).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, s)
}

func (a *SkillAPI) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tenantID := middleware.TenantID(r.Context())
	var s pgstore.Skill
	if err := a.db.Where("id = ? AND tenant_id = ?", id, tenantID).First(&s).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, s)
}

func (a *SkillAPI) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tenantID := middleware.TenantID(r.Context())
	var existing pgstore.Skill
	if err := a.db.Where("id = ? AND tenant_id = ?", id, tenantID).First(&existing).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var updates map[string]any
	json.NewDecoder(r.Body).Decode(&updates)
	delete(updates, "tenant_id")
	delete(updates, "id")
	a.db.Table("skills").Where("id = ? AND tenant_id = ?", id, tenantID).Updates(updates)
	var s pgstore.Skill
	a.db.Where("id = ?", id).First(&s)
	OK(w, s)
}

func (a *SkillAPI) del(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	tenantID := middleware.TenantID(r.Context())
	res := a.db.Where("id = ? AND tenant_id = ?", id, tenantID).Delete(&pgstore.Skill{})
	if res.RowsAffected == 0 {
		Fail(w, CodeNotFound, "not found")
		return
	}
	a.db.Where("skill_id = ?", id).Delete(&pgstore.AgentSkill{})
	OK(w, M{"ok": true})
}
