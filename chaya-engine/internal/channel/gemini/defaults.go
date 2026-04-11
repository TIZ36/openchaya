package gemini

import "strings"

// DefaultAPIBase is the Gemini Developer API origin (with trailing slash for genai client).
const DefaultAPIBase = "https://generativelanguage.googleapis.com/"

// NormalizeBaseURL trims spaces and ensures a trailing slash when non-empty.
func NormalizeBaseURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	return strings.TrimRight(s, "/") + "/"
}

// NormalizeModel strips the "models/" prefix if present.
func NormalizeModel(m string) string {
	s := strings.TrimSpace(m)
	return strings.TrimPrefix(s, "models/")
}
