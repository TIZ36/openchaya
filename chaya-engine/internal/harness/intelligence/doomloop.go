package intelligence

import (
	"crypto/sha256"
	"encoding/hex"
)

const doomLoopThreshold = 3

// DoomLoopDetector tracks recent tool calls and detects repetitive patterns.
type DoomLoopDetector struct {
	recentCalls []string // hash of (toolName + args)
	maxHistory  int
}

func NewDoomLoopDetector() *DoomLoopDetector {
	return &DoomLoopDetector{maxHistory: 10}
}

// Check returns true if the same tool+args has been called >= threshold times recently.
func (d *DoomLoopDetector) Check(toolName, args string) bool {
	h := hash(toolName + "|" + args)

	count := 0
	for i := len(d.recentCalls) - 1; i >= 0 && i >= len(d.recentCalls)-doomLoopThreshold; i-- {
		if d.recentCalls[i] == h {
			count++
		}
	}
	return count >= doomLoopThreshold
}

// Record adds a tool call to the history.
func (d *DoomLoopDetector) Record(toolName, args string) {
	d.recentCalls = append(d.recentCalls, hash(toolName+"|"+args))
	if len(d.recentCalls) > d.maxHistory {
		d.recentCalls = d.recentCalls[len(d.recentCalls)-d.maxHistory:]
	}
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}
