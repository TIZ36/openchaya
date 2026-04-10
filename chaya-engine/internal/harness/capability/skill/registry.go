package skill

import (
	"errors"
	"sort"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

// Skill is a structured SOP (Standard Operating Procedure).
type Skill struct {
	ID          string   `json:"id" gorm:"primaryKey"`
	TenantID    string   `json:"tenant_id" gorm:"index"`
	Name        string   `json:"name"`
	Description string   `json:"description"` // one-line, for catalog
	Keywords    []string `json:"keywords" gorm:"serializer:json"`
	Steps       []Step   `json:"steps" gorm:"serializer:json"`
	RequiredMCP []string `json:"required_mcp" gorm:"serializer:json"`
}

func (Skill) TableName() string { return "skills" }

// Step is a single step in the SOP.
type Step struct {
	Order       int    `json:"order"`
	Action      string `json:"action"`      // mcp_call / llm_generate / condition
	Description string `json:"description"` // natural language
	MCPServer   string `json:"mcp_server,omitempty"`
	ToolName    string `json:"tool_name,omitempty"`
}

// IndexEntry is the lightweight catalog entry (always loaded, ~200 tokens for 10 skills).
type IndexEntry struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Keywords    []string `json:"keywords"`
}

// Registry manages skills with two-phase loading.
type Registry struct {
	db *gorm.DB
}

func NewRegistry(db *gorm.DB) *Registry {
	return &Registry{db: db}
}

// Match implements two-phase skill loading.
// When isPrimary is true, all tenant skills are visible (no agent_skills join), per product rules.
// When isPrimary is false, only skills bound via agent_skills are loaded.
//   Phase 1: always return catalog (lightweight index for system prompt)
//   Phase 2: keyword match → return full SOP for matched skills only
func (r *Registry) Match(userMsg, agentID, tenantID string, isPrimary bool) (catalog []IndexEntry, active []Skill) {
	if tenantID == "" || agentID == "" {
		return nil, nil
	}
	var agentTenantRows int64
	r.db.Table("agents").
		Joins("INNER JOIN users ON users.id = agents.user_id").
		Where("agents.id = ? AND users.tenant_id = ?", agentID, tenantID).
		Count(&agentTenantRows)
	if agentTenantRows == 0 {
		return nil, nil
	}
	var skills []Skill
	var err error
	if isPrimary {
		err = r.db.Model(&Skill{}).Where("tenant_id = ?", tenantID).Find(&skills).Error
	} else {
		err = r.db.Model(&Skill{}).
			Joins("INNER JOIN agent_skills ON agent_skills.skill_id = skills.id").
			Where("agent_skills.agent_id = ? AND skills.tenant_id = ?", agentID, tenantID).
			Find(&skills).Error
	}
	if err != nil || len(skills) == 0 {
		return nil, nil
	}

	msgLower := strings.ToLower(userMsg)

	for _, s := range skills {
		// Phase 1: always add to catalog
		catalog = append(catalog, IndexEntry{
			ID:          s.ID,
			Name:        s.Name,
			Description: s.Description,
			Keywords:    s.Keywords,
		})

		// Phase 2: keyword match → inject full SOP
		if keywordMatch(msgLower, s.Keywords) {
			active = append(active, s)
		}
	}
	return
}

// GetBoundSkill returns a skill by id only if it is installed on the agent (agent_skills).
func (r *Registry) GetBoundSkill(skillID, agentID, tenantID string) (*Skill, error) {
	if tenantID == "" || agentID == "" || skillID == "" {
		return nil, errors.New("missing skill or agent or tenant id")
	}
	var s Skill
	err := r.db.Model(&Skill{}).
		Joins("INNER JOIN agent_skills ON agent_skills.skill_id = skills.id").
		Where("skills.id = ? AND agent_skills.agent_id = ? AND skills.tenant_id = ?", skillID, agentID, tenantID).
		First(&s).Error
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// GetSkillByTenant returns a skill by id if it belongs to the tenant (for Primary / topology without agent binding).
func (r *Registry) GetSkillByTenant(skillID, tenantID string) (*Skill, error) {
	if tenantID == "" || skillID == "" {
		return nil, errors.New("missing skill or tenant id")
	}
	var s Skill
	err := r.db.Where("id = ? AND tenant_id = ?", skillID, tenantID).First(&s).Error
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// FormatCatalog formats the skill catalog for system prompt injection.
func FormatCatalog(catalog []IndexEntry) string {
	if len(catalog) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("你具备以下技能：\n")
	for _, e := range catalog {
		b.WriteString("- " + e.Name + "：" + e.Description + "\n")
	}
	return b.String()
}

// FormatActiveSOP formats active skills' full SOP for system prompt injection.
func FormatActiveSOP(skills []Skill) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	for _, s := range skills {
		b.WriteString("\n【当前激活技能：" + s.Name + "】\n请按以下步骤执行：\n")
		steps := sortedSteps(s.Steps)
		for i, step := range steps {
			b.WriteString("  ")
			b.WriteString(strconv.Itoa(i + 1))
			b.WriteString(". ")
			if step.Action != "" && step.Action != "llm_generate" {
				b.WriteString("[" + step.Action + "] ")
			}
			b.WriteString(step.Description + "\n")
		}
	}
	return b.String()
}

func sortedSteps(steps []Step) []Step {
	if len(steps) <= 1 {
		return steps
	}
	out := make([]Step, len(steps))
	copy(out, steps)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order == out[j].Order {
			return i < j
		}
		return out[i].Order < out[j].Order
	})
	return out
}

func keywordMatch(msgLower string, keywords []string) bool {
	for _, kw := range keywords {
		if strings.Contains(msgLower, strings.ToLower(kw)) {
			return true
		}
	}
	return false
}
