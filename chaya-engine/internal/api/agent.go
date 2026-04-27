package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"
)

// mergeMapShallow merges src into dst (nested maps merged one level for "ext").
func mergeMapShallow(dst, src map[string]interface{}) {
	for k, v := range src {
		if k == "ext" {
			if sm, ok := v.(map[string]interface{}); ok {
				if cur, ok := dst["ext"].(map[string]interface{}); ok && cur != nil {
					for ek, ev := range sm {
						cur[ek] = ev
					}
					dst["ext"] = cur
				} else {
					dst["ext"] = sm
				}
			} else {
				dst[k] = v
			}
			continue
		}
		dst[k] = v
	}
}

type AgentAPI struct {
	db *gorm.DB
}

func RegisterAgentRoutes(r chi.Router, db *gorm.DB) {
	a := &AgentAPI{db: db}
	r.Get("/api/agents", a.list)
	r.Post("/api/agents", a.create)
	r.Get("/api/agents/{id}", a.get)
	r.Put("/api/agents/{id}", a.update)
	r.Put("/api/agents/{id}/profile", a.updateProfile)
	r.Delete("/api/agents/{id}", a.del)
	r.Get("/api/agents/{id}/skills", a.listSkills)
	r.Post("/api/agents/{id}/skills", a.attachSkill)
	r.Delete("/api/agents/{id}/skills/{skillId}", a.detachSkill)
}

func (a *AgentAPI) list(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	var agents []pgstore.Agent
	a.db.Where("user_id = ?", userID).Order("is_primary desc, created_at asc").Find(&agents)

	// Bulk-fetch every agent's bound conversation in one query, otherwise
	// enrichAgent fires N additional SELECTs (and N CREATEs when missing)
	// — turns a 10-agent list into 30+ queries.
	convByAgent := make(map[string]string, len(agents))
	if len(agents) > 0 {
		ids := make([]string, len(agents))
		for i, ag := range agents {
			ids[i] = ag.ID
		}
		var links []pgstore.ConversationAgent
		a.db.Where("agent_id IN ?", ids).Find(&links)
		for _, l := range links {
			if _, dup := convByAgent[l.AgentID]; !dup {
				convByAgent[l.AgentID] = l.ConversationID
			}
		}
	}

	stats := a.bulkConvStats(convByAgent)

	result := make([]M, len(agents))
	for i, ag := range agents {
		m := a.enrichAgentWithConv(ag, convByAgent[ag.ID])
		if convID := convByAgent[ag.ID]; convID != "" {
			if st, ok := stats[convID]; ok {
				if st.count > 0 {
					m["message_count"] = st.count
				}
				if !st.lastAt.IsZero() {
					m["last_message_at"] = st.lastAt
				}
				if st.preview != "" {
					m["preview_text"] = st.preview
				}
			}
		}
		result[i] = m
	}
	OK(w, result)
}

// convStats holds the headline numbers shown on the Persona page dossier
// card: how many turns, when the last one happened, and the very first
// thing the user said (used as a quote when the agent has no name yet).
type convStats struct {
	count   int64
	lastAt  time.Time
	preview string
}

// bulkConvStats aggregates message_count + MAX(created_at) per conv in one
// query, and the first-user-message preview in another. Two grouped reads
// regardless of agent count — never N+1.
func (a *AgentAPI) bulkConvStats(convByAgent map[string]string) map[string]*convStats {
	out := map[string]*convStats{}
	if len(convByAgent) == 0 {
		return out
	}
	ids := make([]string, 0, len(convByAgent))
	seen := map[string]bool{}
	for _, c := range convByAgent {
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		ids = append(ids, c)
	}
	if len(ids) == 0 {
		return out
	}

	type aggRow struct {
		ConvID string    `gorm:"column:conv_id"`
		Cnt    int64     `gorm:"column:cnt"`
		LastAt time.Time `gorm:"column:last_at"`
	}
	var aggs []aggRow
	a.db.Raw(
		`SELECT conv_id, COUNT(*) AS cnt, MAX(created_at) AS last_at
		   FROM messages
		  WHERE conv_id IN ?
		    AND role IN ('user','assistant')
		  GROUP BY conv_id`, ids,
	).Scan(&aggs)
	for _, r := range aggs {
		out[r.ConvID] = &convStats{count: r.Cnt, lastAt: r.LastAt}
	}

	// Preview = first user message per conv (DISTINCT ON is Postgres-specific
	// but we already require pgvector elsewhere, so portability isn't a goal).
	type previewRow struct {
		ConvID  string `gorm:"column:conv_id"`
		Content string `gorm:"column:content"`
	}
	var previews []previewRow
	a.db.Raw(
		`SELECT DISTINCT ON (conv_id) conv_id, content
		   FROM messages
		  WHERE conv_id IN ?
		    AND role = 'user'
		  ORDER BY conv_id, created_at ASC`, ids,
	).Scan(&previews)
	for _, r := range previews {
		st := out[r.ConvID]
		if st == nil {
			st = &convStats{}
			out[r.ConvID] = st
		}
		p := strings.TrimSpace(r.Content)
		if len([]rune(p)) > 60 {
			rs := []rune(p)
			p = string(rs[:60]) + "…"
		}
		st.preview = p
	}
	return out
}

// create 新建通用 Agent（Type=generic，可删），并绑定专属会话。
// POST /api/agents — body: name?, config?
func (a *AgentAPI) create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())

	// Enforce per-plan agent count cap. Founders bypass via the same
	// effective-plan helper used in /api/me. -1 means unlimited.
	if err := a.checkAgentCreateAllowed(r, userID); err != nil {
		Fail(w, CodeForbidden, err.Error())
		return
	}

	var req struct {
		Name   string          `json:"name"`
		Config json.RawMessage `json:"config"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "新 Agent"
	}
	cfg := req.Config
	if len(cfg) == 0 || string(cfg) == "null" {
		cfg = json.RawMessage(`{}`)
	}

	agent := pgstore.Agent{
		UserID:    userID,
		Type:      "generic",
		Name:      name,
		Config:    cfg,
		IsPrimary: false,
	}
	if err := a.db.Create(&agent).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	conv := pgstore.Conversation{
		UserID: userID,
		Title:  name,
		Type:   "agent",
	}
	if err := a.db.Create(&conv).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	if err := a.db.Create(&pgstore.ConversationAgent{
		ConversationID: conv.ID,
		AgentID:        agent.ID,
	}).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	var created pgstore.Agent
	if err := a.db.Where("id = ?", agent.ID).First(&created).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	OK(w, a.enrichAgent(created))
}

func (a *AgentAPI) get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", id, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	OK(w, a.enrichAgent(agent))
}

// enrichAgent adds conversation_id to agent response.
// Each agent has a bound conversation for its chat history. If missing,
// lazily creates one. List endpoints should use enrichAgentWithConv with
// a pre-fetched convID to avoid N+1.
func (a *AgentAPI) enrichAgent(ag pgstore.Agent) M {
	var link pgstore.ConversationAgent
	convID := ""
	if a.db.Where("agent_id = ?", ag.ID).First(&link).Error == nil {
		convID = link.ConversationID
	} else {
		newConv := pgstore.Conversation{
			UserID: ag.UserID,
			Title:  ag.Name,
			Type:   "agent",
		}
		if err := a.db.Create(&newConv).Error; err == nil {
			if err := a.db.Create(&pgstore.ConversationAgent{
				ConversationID: newConv.ID,
				AgentID:        ag.ID,
			}).Error; err == nil {
				convID = newConv.ID
			}
		}
	}
	m := a.enrichAgentWithConv(ag, convID)
	// Single-get path also gets the dossier stats. Used by Persona page when
	// the user opens an agent directly (deep link / refresh).
	if convID != "" {
		stats := a.bulkConvStats(map[string]string{ag.ID: convID})
		if st, ok := stats[convID]; ok {
			if st.count > 0 {
				m["message_count"] = st.count
			}
			if !st.lastAt.IsZero() {
				m["last_message_at"] = st.lastAt
			}
			if st.preview != "" {
				m["preview_text"] = st.preview
			}
		}
	}
	return m
}

// enrichAgentWithConv builds the response map without touching the DB.
// Pass an empty convID if you don't have one — caller is responsible for
// the lazy-create dance (used by single-get; list resolves in bulk).
func (a *AgentAPI) enrichAgentWithConv(ag pgstore.Agent, convID string) M {
	m := M{
		"id":              ag.ID,
		"user_id":         ag.UserID,
		"type":            ag.Type,
		"name":            ag.Name,
		"config":          ag.Config,
		"permissions":     ag.Permissions,
		"is_primary":      ag.IsPrimary,
		"conversation_id": convID,
		"session_id":      convID,
		"session_type":    "agent",
		"created_at":      ag.CreatedAt,
	}
	avatar, systemPrompt, llmID, mediaPath, title, ext := flattenAgentConfig(ag.Config)
	if avatar != "" {
		m["avatar"] = avatar
	}
	if systemPrompt != "" {
		m["system_prompt"] = systemPrompt
	}
	if llmID != "" {
		m["llm_config_id"] = llmID
	}
	if mediaPath != "" {
		m["media_output_path"] = mediaPath
	}
	if title != "" {
		m["title"] = title
	}
	if ext != nil {
		m["ext"] = ext
	}
	return m
}

// flattenAgentConfig reads convenience fields stored inside agents.config JSON (frontend Session shape).
func flattenAgentConfig(cfg json.RawMessage) (avatar, systemPrompt, llmID, mediaPath, title string, ext interface{}) {
	var m map[string]interface{}
	if len(cfg) == 0 || string(cfg) == "null" {
		return "", "", "", "", "", nil
	}
	if err := json.Unmarshal(cfg, &m); err != nil || m == nil {
		return "", "", "", "", "", nil
	}
	if v, ok := m["avatar"].(string); ok {
		avatar = v
	}
	if v, ok := m["system_prompt"].(string); ok {
		systemPrompt = v
	}
	if v, ok := m["llm_config_id"].(string); ok {
		llmID = v
	}
	if v, ok := m["media_output_path"].(string); ok {
		mediaPath = v
	}
	if v, ok := m["title"].(string); ok {
		title = v
	}
	ext = m["ext"]
	return avatar, systemPrompt, llmID, mediaPath, title, ext
}

func (a *AgentAPI) update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())

	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", id, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}

	var updates struct {
		Name        *string          `json:"name"`
		Config      *json.RawMessage `json:"config"`
		Permissions *json.RawMessage `json:"permissions"`
	}
	json.NewDecoder(r.Body).Decode(&updates)

	if updates.Name != nil {
		agent.Name = *updates.Name
	}
	if updates.Config != nil {
		agent.Config = *updates.Config
	}
	if updates.Permissions != nil {
		agent.Permissions = *updates.Permissions
	}

	a.db.Save(&agent)
	OK(w, agent)
}

// updateProfile merges roleApi / ChayaConfigPanel fields into agents.config (and name).
// PUT /api/agents/{id}/profile — body: name?, avatar?, system_prompt?, llm_config_id?, media_output_path?, title?, ext?
func (a *AgentAPI) updateProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())

	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", id, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}

	var in map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		Fail(w, CodeInvalidParam, "invalid json")
		return
	}
	if in == nil {
		in = map[string]interface{}{}
	}

	var cfg map[string]interface{}
	if len(agent.Config) > 0 && string(agent.Config) != "null" {
		_ = json.Unmarshal(agent.Config, &cfg)
	}
	if cfg == nil {
		cfg = map[string]interface{}{}
	}

	if v, ok := in["name"].(string); ok {
		agent.Name = v
	}
	patch := map[string]interface{}{}
	for _, k := range []string{"system_prompt", "avatar", "llm_config_id", "media_output_path", "title"} {
		if v, ok := in[k]; ok {
			patch[k] = v
		}
	}
	if v, ok := in["ext"]; ok {
		patch["ext"] = v
	}
	mergeMapShallow(cfg, patch)

	out, err := json.Marshal(cfg)
	if err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}
	agent.Config = out
	if err := a.db.Save(&agent).Error; err != nil {
		Fail(w, CodeInternal, err.Error())
		return
	}

	OK(w, M{
		"success": true,
		"role_id": agent.ID,
		"message": "ok",
	})
}

func (a *AgentAPI) del(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())

	// Prevent deleting PrimaryAgent
	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", id, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	if agent.IsPrimary {
		Fail(w, CodeForbidden, "cannot delete primary agent")
		return
	}

	var link pgstore.ConversationAgent
	if err := a.db.Where("agent_id = ?", id).First(&link).Error; err == nil {
		convID := link.ConversationID
		var msgIDs []string
		a.db.Model(&pgstore.Message{}).Where("conv_id = ?", convID).Pluck("id", &msgIDs)
		for _, mid := range msgIDs {
			a.db.Where("message_id = ?", mid).Delete(&pgstore.MessagePart{})
		}
		a.db.Where("conv_id = ?", convID).Delete(&pgstore.Message{})
		a.db.Where("conversation_id = ?", convID).Delete(&pgstore.ConversationAgent{})
		a.db.Where("id = ?", convID).Delete(&pgstore.Conversation{})
	}

	a.db.Where("agent_id = ?", id).Delete(&pgstore.AgentSkill{})
	a.db.Where("agent_id = ?", id).Delete(&pgstore.AgentMCPServer{})
	a.db.Where("id = ?", id).Delete(&pgstore.Agent{})
	OK(w, M{"ok": true})
}

// listSkills returns skills installed on this agent (tenant-scoped).
func (a *AgentAPI) listSkills(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	agentID := chi.URLParam(r, "id")
	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", agentID, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var skillIDs []string
	a.db.Table("agent_skills").Where("agent_id = ?", agentID).Pluck("skill_id", &skillIDs)
	if len(skillIDs) == 0 {
		OK(w, []pgstore.Skill{})
		return
	}
	var skills []pgstore.Skill
	a.db.Where("tenant_id = ? AND id IN ?", tenantID, skillIDs).Order("name ASC").Find(&skills)
	OK(w, skills)
}

func (a *AgentAPI) attachSkill(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	agentID := chi.URLParam(r, "id")
	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", agentID, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	var body struct {
		SkillID string `json:"skill_id"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.SkillID == "" {
		Fail(w, CodeInvalidParam, "skill_id required")
		return
	}
	var sk pgstore.Skill
	if err := a.db.Where("id = ? AND tenant_id = ?", body.SkillID, tenantID).First(&sk).Error; err != nil {
		Fail(w, CodeNotFound, "skill not found")
		return
	}
	var existing pgstore.AgentSkill
	err := a.db.Where("agent_id = ? AND skill_id = ?", agentID, body.SkillID).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if err := a.db.Create(&pgstore.AgentSkill{AgentID: agentID, SkillID: body.SkillID}).Error; err != nil {
			Fail(w, CodeInternal, err.Error())
			return
		}
	}
	OK(w, M{"ok": true})
}

func (a *AgentAPI) detachSkill(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserID(r.Context())
	agentID := chi.URLParam(r, "id")
	skillID := chi.URLParam(r, "skillId")
	var agent pgstore.Agent
	if err := a.db.Where("id = ? AND user_id = ?", agentID, userID).First(&agent).Error; err != nil {
		Fail(w, CodeNotFound, "not found")
		return
	}
	a.db.Where("agent_id = ? AND skill_id = ?", agentID, skillID).Delete(&pgstore.AgentSkill{})
	OK(w, M{"ok": true})
}
