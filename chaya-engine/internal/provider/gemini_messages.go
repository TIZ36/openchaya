package provider

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"google.golang.org/genai"
)

// geminiPartFromAttachment converts our generic Attachment into a Gemini
// Part. Inline data is base64-decoded into raw bytes (the SDK takes []byte).
// Returns nil for unsupported types or malformed data — caller filters.
func geminiPartFromAttachment(a Attachment) *genai.Part {
	if a.Data == "" && a.URL == "" {
		return nil
	}
	mime := a.MimeType
	if mime == "" {
		switch a.Type {
		case "image", "":
			mime = "image/jpeg"
		case "audio":
			mime = "audio/mpeg"
		case "video":
			mime = "video/mp4"
		}
	}
	if a.Data != "" {
		raw, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			slog.Warn("gemini: skip attachment with bad base64", "err", err, "name", a.Name)
			return nil
		}
		return genai.NewPartFromBytes(raw, mime)
	}
	// Hosted URLs aren't directly supported by inline_data; we'd need
	// fileData uploads. Skip for v1 with a log so it's noticeable.
	slog.Info("gemini: hosted-URL attachment not yet supported; skipping", "url", a.URL)
	return nil
}

func geminiProviderMessagesToGenAI(messages []Message) (systemInst *genai.Content, contents []*genai.Content, err error) {
	var sysTexts []string
	toolIDToName := map[string]string{}

	for _, m := range messages {
		switch m.Role {
		case "system":
			if strings.TrimSpace(m.Content) != "" {
				sysTexts = append(sysTexts, m.Content)
			}
		case "user":
			// Build a parts list so attached images / inline data can ride
			// along with the text. Gemini accepts mixed text + inline_data
			// parts in a single Content message.
			parts := []*genai.Part{}
			if strings.TrimSpace(m.Content) != "" {
				parts = append(parts, genai.NewPartFromText(m.Content))
			}
			for _, a := range m.Attachments {
				p := geminiPartFromAttachment(a)
				if p != nil {
					parts = append(parts, p)
				}
			}
			if len(parts) == 0 {
				parts = append(parts, genai.NewPartFromText(""))
			}
			contents = append(contents, genai.NewContentFromParts(parts, genai.RoleUser))
		case "assistant":
			for _, tc := range m.ToolCalls {
				toolIDToName[tc.ID] = tc.Name
			}
			parts := []*genai.Part{}
			if strings.TrimSpace(m.Content) != "" {
				parts = append(parts, genai.NewPartFromText(m.Content))
			}
			for _, tc := range m.ToolCalls {
				args, aerr := geminiToolArgumentsMap(tc.Arguments)
				if aerr != nil {
					args = map[string]any{"_raw": tc.Arguments}
				}
				parts = append(parts, genai.NewPartFromFunctionCall(tc.Name, args))
			}
			if len(parts) == 0 {
				parts = append(parts, genai.NewPartFromText(""))
			}
			contents = append(contents, genai.NewContentFromParts(parts, genai.RoleModel))
		case "tool":
			name := toolIDToName[m.ToolCallID]
			if name == "" {
				name = "tool"
			}
			resp, rerr := geminiFunctionResponseMap(m.Content)
			if rerr != nil {
				resp = map[string]any{"result": m.Content}
			}
			contents = append(contents, genai.NewContentFromFunctionResponse(name, resp, genai.RoleUser))
		default:
			contents = append(contents, genai.NewContentFromText(m.Content, genai.RoleUser))
		}
	}

	if len(sysTexts) > 0 {
		systemInst = &genai.Content{
			Parts: []*genai.Part{genai.NewPartFromText(strings.Join(sysTexts, "\n\n"))},
		}
	}
	contents = geminiMergeConsecutiveSameRole(contents)
	if len(contents) > 0 && contents[0].Role != string(genai.RoleUser) {
		contents = append([]*genai.Content{genai.NewContentFromText(" ", genai.RoleUser)}, contents...)
	}
	return systemInst, contents, nil
}

func geminiMergeConsecutiveSameRole(in []*genai.Content) []*genai.Content {
	if len(in) == 0 {
		return in
	}
	out := []*genai.Content{in[0]}
	for i := 1; i < len(in); i++ {
		last := out[len(out)-1]
		if last.Role == in[i].Role {
			last.Parts = append(last.Parts, in[i].Parts...)
			continue
		}
		out = append(out, in[i])
	}
	return out
}

func geminiToolArgumentsMap(raw string) (map[string]any, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func geminiFunctionResponseMap(raw string) (map[string]any, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[string]any{}, nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	return m, nil
}

func geminiProviderToolsToGenAITools(tools []Tool) ([]*genai.Tool, error) {
	if len(tools) == 0 {
		return nil, nil
	}
	decls := make([]*genai.FunctionDeclaration, 0, len(tools))
	for _, t := range tools {
		if t.Type != "" && t.Type != "function" {
			continue
		}
		fd := &genai.FunctionDeclaration{
			Name:        t.Function.Name,
			Description: t.Function.Description,
		}
		switch p := t.Function.Parameters.(type) {
		case map[string]any:
			fd.ParametersJsonSchema = p
		case nil:
		default:
			fd.ParametersJsonSchema = p
		}
		decls = append(decls, fd)
	}
	if len(decls) == 0 {
		return nil, nil
	}
	return []*genai.Tool{{FunctionDeclarations: decls}}, nil
}

func geminiGenAIToolConfig(toolChoice string) *genai.ToolConfig {
	mode := genai.FunctionCallingConfigModeAuto
	switch strings.ToLower(strings.TrimSpace(toolChoice)) {
	case "none":
		mode = genai.FunctionCallingConfigModeNone
	case "required", "any":
		mode = genai.FunctionCallingConfigModeAny
	}
	return &genai.ToolConfig{
		FunctionCallingConfig: &genai.FunctionCallingConfig{Mode: mode},
	}
}

func geminiToolCallsFromResponse(resp *genai.GenerateContentResponse) ([]ToolCall, string, error) {
	if resp == nil || len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
		return nil, "", nil
	}
	var calls []ToolCall
	var textParts []string
	for _, part := range resp.Candidates[0].Content.Parts {
		if part.Text != "" && !part.Thought {
			textParts = append(textParts, part.Text)
		}
		if fc := part.FunctionCall; fc != nil {
			argBytes, _ := json.Marshal(fc.Args)
			id := fc.ID
			if id == "" {
				id = fmt.Sprintf("fc-%s-%d", fc.Name, len(calls))
			}
			calls = append(calls, ToolCall{
				ID:        id,
				Name:      fc.Name,
				Arguments: string(argBytes),
			})
		}
	}
	return calls, strings.Join(textParts, ""), nil
}
