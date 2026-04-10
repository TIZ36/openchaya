package rag

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Chunk represents a single text block with structural context.
type Chunk struct {
	Text      string `json:"text"`
	Heading   string `json:"heading,omitempty"`    // section title
	ParentID  string `json:"parent_id,omitempty"`  // parent section chunk ID
	Position  int    `json:"position"`             // order within section
	CtxBefore string `json:"ctx_before,omitempty"` // preceding summary (1-2 sentences)
	CtxAfter  string `json:"ctx_after,omitempty"`  // following summary (1-2 sentences)
}

var headingRe = regexp.MustCompile(`(?m)^(#{1,3})\s+(.+)$`)

// SmartChunk splits text by semantic structure (headings/paragraphs),
// not by fixed token count. Preserves reading context.
func SmartChunk(text string, maxCharsPerChunk int) []Chunk {
	if maxCharsPerChunk <= 0 {
		maxCharsPerChunk = 1500 // ~500 tokens
	}

	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	// Try markdown-aware splitting first
	if headingRe.MatchString(text) {
		return chunkByHeadings(text, maxCharsPerChunk)
	}

	// Fallback: paragraph-based
	return chunkByParagraphs(text, maxCharsPerChunk)
}

func chunkByHeadings(text string, maxChars int) []Chunk {
	// Split into sections by heading
	locs := headingRe.FindAllStringIndex(text, -1)
	if len(locs) == 0 {
		return chunkByParagraphs(text, maxChars)
	}

	type section struct {
		heading string
		body    string
	}

	var sections []section

	// Content before first heading
	if locs[0][0] > 0 {
		pre := strings.TrimSpace(text[:locs[0][0]])
		if pre != "" {
			sections = append(sections, section{heading: "", body: pre})
		}
	}

	for i, loc := range locs {
		match := headingRe.FindStringSubmatch(text[loc[0]:loc[1]])
		heading := ""
		if len(match) >= 3 {
			heading = match[2]
		}

		end := len(text)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}

		body := strings.TrimSpace(text[loc[1]:end])
		if body != "" || heading != "" {
			sections = append(sections, section{heading: heading, body: body})
		}
	}

	// Convert sections to chunks, splitting large sections
	var chunks []Chunk
	for _, sec := range sections {
		if utf8.RuneCountInString(sec.body) <= maxChars {
			chunks = append(chunks, Chunk{
				Text:     sec.body,
				Heading:  sec.heading,
				Position: len(chunks),
			})
		} else {
			// Split large section into paragraphs
			subChunks := chunkByParagraphs(sec.body, maxChars)
			for _, sc := range subChunks {
				sc.Heading = sec.heading
				sc.Position = len(chunks)
				chunks = append(chunks, sc)
			}
		}
	}

	// Add context before/after
	addSurroundingContext(chunks)

	return chunks
}

func chunkByParagraphs(text string, maxChars int) []Chunk {
	paras := splitParagraphs(text)
	if len(paras) == 0 {
		return nil
	}

	var chunks []Chunk
	var current []string
	currentLen := 0

	flush := func() {
		if len(current) == 0 {
			return
		}
		chunks = append(chunks, Chunk{
			Text:     strings.Join(current, "\n\n"),
			Position: len(chunks),
		})
		current = nil
		currentLen = 0
	}

	for _, para := range paras {
		paraLen := utf8.RuneCountInString(para)

		// Single paragraph exceeds limit → force split by sentences
		if paraLen > maxChars && len(current) == 0 {
			for _, sentence := range splitSentences(para) {
				sentLen := utf8.RuneCountInString(sentence)
				if currentLen+sentLen > maxChars && len(current) > 0 {
					flush()
				}
				current = append(current, sentence)
				currentLen += sentLen
			}
			flush()
			continue
		}

		if currentLen+paraLen > maxChars && len(current) > 0 {
			flush()
		}
		current = append(current, para)
		currentLen += paraLen
	}
	flush()

	addSurroundingContext(chunks)

	return chunks
}

func addSurroundingContext(chunks []Chunk) {
	for i := range chunks {
		if i > 0 {
			chunks[i].CtxBefore = summarize(chunks[i-1].Text, 100)
		}
		if i < len(chunks)-1 {
			chunks[i].CtxAfter = summarize(chunks[i+1].Text, 100)
		}
	}
}

// summarize returns the first N chars as a crude summary.
func summarize(text string, maxChars int) string {
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text
	}
	// Cut at last sentence boundary within limit
	s := string(runes[:maxChars])
	if idx := strings.LastIndexAny(s, "。.！!？?\n"); idx > 0 {
		return s[:idx+1]
	}
	return s + "..."
}

func splitParagraphs(text string) []string {
	raw := regexp.MustCompile(`\n\s*\n`).Split(text, -1)
	var out []string
	for _, p := range raw {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func splitSentences(text string) []string {
	re := regexp.MustCompile(`(?<=[。！？.!?\n])`)
	parts := re.Split(text, -1)
	var out []string
	for _, s := range parts {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		out = append(out, text)
	}
	return out
}
