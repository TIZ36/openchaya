package intelligence

import (
	"fmt"
	"strings"
	"time"
)

// EmotionState tracks the agent's current emotional tone.
type EmotionState struct {
	Mood       string    `json:"mood"`       // neutral / happy / concerned / excited
	Energy     float64   `json:"energy"`     // 0-1, affects verbosity
	LastUpdate time.Time `json:"last_update"`
}

// PersonaProfile defines the agent's personality.
type PersonaProfile struct {
	Name           string        `json:"name"`
	SpeakingStyle  string        `json:"speaking_style"`  // e.g. "casual and warm" / "formal and precise"
	EmotionEnabled bool          `json:"emotion_enabled"` // whether to adjust tone based on context
	ThinkInterval  time.Duration `json:"think_interval"`  // 0 = disabled
	ProactiveTopics []string     `json:"proactive_topics,omitempty"`
}

// PersonaEngine manages personality expression and emotional state.
type PersonaEngine struct {
	Profile  PersonaProfile
	Emotion  EmotionState
}

func NewPersonaEngine(profile PersonaProfile) *PersonaEngine {
	return &PersonaEngine{
		Profile: profile,
		Emotion: EmotionState{Mood: "neutral", Energy: 0.7, LastUpdate: time.Now()},
	}
}

// BuildPersonaPrompt generates the persona section of the system prompt.
func (p *PersonaEngine) BuildPersonaPrompt() string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("你的名字是 %s。", p.Profile.Name))

	if p.Profile.SpeakingStyle != "" {
		b.WriteString(fmt.Sprintf("你的说话风格：%s。", p.Profile.SpeakingStyle))
	}

	if p.Profile.EmotionEnabled {
		switch p.Emotion.Mood {
		case "happy":
			b.WriteString("你现在心情不错，回复可以稍微活泼一些。")
		case "concerned":
			b.WriteString("你注意到用户可能遇到了困难，回复时请体现关心。")
		case "excited":
			b.WriteString("当前话题很有趣，你可以表现出一些热情。")
		}

		if p.Emotion.Energy < 0.3 {
			b.WriteString("保持简洁。")
		} else if p.Emotion.Energy > 0.8 {
			b.WriteString("可以适当详细一些。")
		}
	}

	return b.String()
}

// UpdateEmotion adjusts emotional state based on interaction context.
func (p *PersonaEngine) UpdateEmotion(userMsg string, success bool) {
	now := time.Now()
	lower := strings.ToLower(userMsg)

	// Simple heuristic emotion detection
	if containsAny(lower, []string{"谢谢", "太好了", "完美", "thanks", "great", "perfect"}) {
		p.Emotion.Mood = "happy"
		p.Emotion.Energy = min(p.Emotion.Energy+0.1, 1.0)
	} else if containsAny(lower, []string{"错了", "不对", "bug", "问题", "失败", "error", "wrong"}) {
		p.Emotion.Mood = "concerned"
	} else if containsAny(lower, []string{"有趣", "酷", "厉害", "cool", "awesome"}) {
		p.Emotion.Mood = "excited"
		p.Emotion.Energy = min(p.Emotion.Energy+0.05, 1.0)
	}

	if !success {
		p.Emotion.Mood = "concerned"
		p.Emotion.Energy = max(p.Emotion.Energy-0.1, 0.2)
	}

	// Natural energy decay over time
	elapsed := now.Sub(p.Emotion.LastUpdate)
	if elapsed > 30*time.Minute {
		p.Emotion.Mood = "neutral"
		p.Emotion.Energy = 0.7
	}

	p.Emotion.LastUpdate = now
}

// AutonomousThinkPrompt generates the prompt for periodic autonomous thinking.
func (p *PersonaEngine) AutonomousThinkPrompt(lastMsgAge time.Duration) string {
	return fmt.Sprintf(
		"你是 %s。距离上次和用户对话已过 %s。"+
			"根据之前的对话内容和你的性格，你会主动想到什么？"+
			"如果值得分享，简短说出来。如果没什么特别的，回复 [SILENT]。",
		p.Profile.Name,
		formatDuration(lastMsgAge),
	)
}

func containsAny(s string, substrs []string) bool {
	for _, sub := range substrs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return "不到一分钟"
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分钟", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%.1f 小时", d.Hours())
	}
	return fmt.Sprintf("%.0f 天", d.Hours()/24)
}

func min64(a, b float64) float64 { if a < b { return a }; return b }
func max64(a, b float64) float64 { if a > b { return a }; return b }
