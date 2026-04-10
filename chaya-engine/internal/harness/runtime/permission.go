package runtime

import (
	"path/filepath"
	"strings"
)

// Action defines what happens when a permission rule matches.
type Action string

const (
	ActionAllow Action = "allow"
	ActionDeny  Action = "deny"
	ActionAsk   Action = "ask" // prompt user for confirmation
)

// PermissionRule defines a single access control rule.
type PermissionRule struct {
	Permission string `json:"permission"` // e.g. "edit", "bash", "mcp:feishu", "media_generate"
	Pattern    string `json:"pattern"`    // glob pattern, e.g. "*.env", "src/**", "*"
	Action     Action `json:"action"`
}

// Ruleset is an ordered list of rules. First match wins.
type Ruleset []PermissionRule

// Evaluate checks if a permission+pattern is allowed.
// Returns the action of the first matching rule, or ActionAllow if no rules match.
func (rs Ruleset) Evaluate(permission, pattern string) Action {
	for _, rule := range rs {
		if !matchPermission(rule.Permission, permission) {
			continue
		}
		if !matchPattern(rule.Pattern, pattern) {
			continue
		}
		return rule.Action
	}
	return ActionAllow // default: allow if no rule matches
}

// CanDo is a shorthand: returns true if permission is allowed (not denied).
func (rs Ruleset) CanDo(permission string) bool {
	return rs.Evaluate(permission, "*") != ActionDeny
}

// matchPermission checks if rule permission matches the requested permission.
// Supports wildcard "*" and prefix match "mcp:*".
func matchPermission(rule, requested string) bool {
	if rule == "*" {
		return true
	}
	if rule == requested {
		return true
	}
	// Prefix match: "mcp:*" matches "mcp:feishu"
	if strings.HasSuffix(rule, ":*") {
		prefix := strings.TrimSuffix(rule, "*")
		return strings.HasPrefix(requested, prefix)
	}
	return false
}

// matchPattern checks if a glob pattern matches.
func matchPattern(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	matched, _ := filepath.Match(pattern, value)
	return matched
}

// Merge combines multiple rulesets. Later rulesets take priority (prepended).
func Merge(rulesets ...Ruleset) Ruleset {
	var merged Ruleset
	// Reverse order: last ruleset has highest priority
	for i := len(rulesets) - 1; i >= 0; i-- {
		merged = append(merged, rulesets[i]...)
	}
	return merged
}

// Presets

// PrimaryRuleset gives full access (PrimaryAgent default).
var PrimaryRuleset = Ruleset{
	{Permission: "*", Pattern: "*", Action: ActionAllow},
}

// ReadOnlyRuleset allows read but denies writes.
var ReadOnlyRuleset = Ruleset{
	{Permission: "read", Pattern: "*", Action: ActionAllow},
	{Permission: "glob", Pattern: "*", Action: ActionAllow},
	{Permission: "grep", Pattern: "*", Action: ActionAllow},
	{Permission: "edit", Pattern: "*", Action: ActionDeny},
	{Permission: "write", Pattern: "*", Action: ActionDeny},
	{Permission: "bash", Pattern: "*", Action: ActionDeny},
	{Permission: "*", Pattern: "*", Action: ActionAllow},
}
