package api

import (
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"gorm.io/gorm"
)

// agentBelongsToTenant reports whether the agent's owner user is in tenantID.
// When tenantID is empty, returns true (JWT 无租户字段时的兼容；仍须校验 user 归属).
func agentBelongsToTenant(db *gorm.DB, agentID, tenantID string) bool {
	if tenantID == "" || agentID == "" {
		return true
	}
	var row struct {
		TenantID string `gorm:"column:tenant_id"`
	}
	err := db.Raw(
		`SELECT u.tenant_id FROM agents ag JOIN users u ON u.id = ag.user_id WHERE ag.id = ?`,
		agentID,
	).Scan(&row).Error
	return err == nil && row.TenantID == tenantID
}

// agentAccessForUser requires the agent to belong to userID, and when tenantID is set,
// the owner user must be in that tenant.
func agentAccessForUser(db *gorm.DB, agentID, userID, tenantID string) bool {
	if agentID == "" || userID == "" {
		return false
	}
	q := db.Model(&pgstore.Agent{}).
		Joins("INNER JOIN users u ON u.id = agents.user_id").
		Where("agents.id = ? AND agents.user_id = ?", agentID, userID)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	var n int64
	if err := q.Count(&n).Error; err != nil {
		return false
	}
	return n > 0
}

// ConversationAccessForUser ensures the conversation is owned by userID and, when tenantID is set,
// the owner user's tenant matches (对话无 tenant 列，经 users 隔离).
// 供 HTTP 与 WebSocket 共用。
func ConversationAccessForUser(db *gorm.DB, convID, userID, tenantID string) bool {
	if convID == "" || userID == "" {
		return false
	}
	q := db.Table("conversations AS c").
		Joins("INNER JOIN users u ON u.id = c.user_id").
		Where("c.id = ? AND c.user_id = ?", convID, userID)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	var n int64
	if err := q.Count(&n).Error; err != nil {
		return false
	}
	return n > 0
}
