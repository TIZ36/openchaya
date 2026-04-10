package topology

import (
	"encoding/json"

	"gorm.io/gorm"
)

// AppendAssistantRatingTrace records explicit thumbs up/down for topology consolidation (agent_traces).
// intent_tag=assistant_feedback so LLM merge can weight outcomes; UserFeedback uses positive/negative.
func AppendAssistantRatingTrace(db *gorm.DB, agentID, assistantMessageID string, thumbsUp bool) error {
	if db == nil || agentID == "" || assistantMessageID == "" {
		return nil
	}
	fb := "negative"
	if thumbsUp {
		fb = "positive"
	}
	actions, _ := json.Marshal([]TraceAction{
		{Order: 1, Type: "assistant_rating", TargetID: assistantMessageID, Success: thumbsUp},
	})
	tr := &InteractionTrace{
		AgentID:      agentID,
		UserInput:    "",
		IntentTag:    "assistant_feedback",
		Actions:      actions,
		Success:      thumbsUp,
		UserFeedback: fb,
	}
	return NewTraceStore(db).Save(tr)
}

// AgentIDForConversation returns the first agent bound to the conversation (primary path).
func AgentIDForConversation(db *gorm.DB, convID string) string {
	if db == nil || convID == "" {
		return ""
	}
	var row struct {
		AgentID string `gorm:"column:agent_id"`
	}
	if err := db.Table("conversation_agents").Select("agent_id").Where("conversation_id = ?", convID).Limit(1).Scan(&row).Error; err != nil {
		return ""
	}
	return row.AgentID
}
