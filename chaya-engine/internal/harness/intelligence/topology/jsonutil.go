package topology

import "strings"

// ExtractJSONObject returns the substring from the first "{" to the last "}" (inclusive), if any.
func ExtractJSONObject(s string) string {
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start == -1 || end == -1 || end <= start {
		return ""
	}
	return s[start : end+1]
}
