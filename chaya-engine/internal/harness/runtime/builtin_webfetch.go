package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
)

const (
	webFetchTimeout     = 15 * time.Second
	webFetchMaxBody     = 100 * 1024 // 100KB
	webFetchMaxResult   = 10000      // chars returned to LLM
	webFetchUserAgent   = "Chaya-Engine/1.0 (WebFetch)"
)

// webFetchTool returns a builtin tool that fetches a URL and returns its text content.
// This serves as a fallback when no specific MCP tool handles the URL.
func webFetchTool() pkg.Tool {
	return pkg.Tool{
		Name: "web_fetch",
		Description: "获取指定 URL 的网页内容并返回纯文本。当没有更专用的 MCP 工具可以读取某个链接时，使用此工具作为兜底方案。" +
			"支持 HTTP/HTTPS 链接，自动将 HTML 转换为可读文本。",
		Parameters: json.RawMessage(`{
			"type": "object",
			"properties": {
				"url": {
					"type": "string",
					"description": "要获取的完整 URL（必须以 http:// 或 https:// 开头）"
				}
			},
			"required": ["url"]
		}`),
		Source:    "builtin",
		ExecuteFn: executeWebFetch,
	}
}

func executeWebFetch(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
	var params struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return &pkg.ToolResult{Success: false, Error: "参数解析失败: " + err.Error()}, nil
	}

	url := strings.TrimSpace(params.URL)
	if url == "" {
		return &pkg.ToolResult{Success: false, Error: "url 参数不能为空"}, nil
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return &pkg.ToolResult{Success: false, Error: "url 必须以 http:// 或 https:// 开头"}, nil
	}

	fetchCtx, cancel := context.WithTimeout(ctx, webFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, url, nil)
	if err != nil {
		return &pkg.ToolResult{Success: false, Error: "创建请求失败: " + err.Error()}, nil
	}
	req.Header.Set("User-Agent", webFetchUserAgent)
	req.Header.Set("Accept", "text/html, application/json, text/plain, */*")

	client := &http.Client{
		Timeout: webFetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects (>5)")
			}
			return nil
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		return &pkg.ToolResult{Success: false, Error: "请求失败: " + err.Error()}, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return &pkg.ToolResult{
			Success: false,
			Error:   fmt.Sprintf("HTTP %d %s", resp.StatusCode, resp.Status),
		}, nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, webFetchMaxBody))
	if err != nil {
		return &pkg.ToolResult{Success: false, Error: "读取响应失败: " + err.Error()}, nil
	}

	content := string(body)
	contentType := resp.Header.Get("Content-Type")

	// Convert HTML to plain text
	if strings.Contains(contentType, "html") || strings.HasPrefix(content, "<!") || strings.HasPrefix(content, "<html") {
		content = htmlToText(content)
	}

	// Truncate if too long
	runes := []rune(content)
	if len(runes) > webFetchMaxResult {
		content = string(runes[:webFetchMaxResult]) + "\n\n...(内容已截断，共 " + fmt.Sprintf("%d", len(runes)) + " 字符)"
	}

	if strings.TrimSpace(content) == "" {
		return &pkg.ToolResult{
			Success: true,
			Body:    "(页面内容为空或无法提取文本。该页面可能需要登录或使用 JavaScript 渲染。)",
		}, nil
	}

	return &pkg.ToolResult{
		Success: true,
		Body:    fmt.Sprintf("URL: %s\nHTTP %d\n\n%s", url, resp.StatusCode, content),
	}, nil
}

// htmlToText strips HTML tags and decodes common entities to produce readable plain text.
func htmlToText(html string) string {
	// Remove script and style blocks
	reScript := regexp.MustCompile(`(?is)<script[^>]*>.*?</script>`)
	html = reScript.ReplaceAllString(html, "")
	reStyle := regexp.MustCompile(`(?is)<style[^>]*>.*?</style>`)
	html = reStyle.ReplaceAllString(html, "")

	// Replace common block-level elements with newlines
	for _, tag := range []string{"br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article"} {
		re := regexp.MustCompile(`(?i)</?` + tag + `[^>]*>`)
		html = re.ReplaceAllString(html, "\n")
	}

	// Strip all remaining tags
	reTags := regexp.MustCompile(`<[^>]+>`)
	text := reTags.ReplaceAllString(html, "")

	// Decode common HTML entities
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&lt;", "<")
	text = strings.ReplaceAll(text, "&gt;", ">")
	text = strings.ReplaceAll(text, "&quot;", `"`)
	text = strings.ReplaceAll(text, "&#39;", "'")
	text = strings.ReplaceAll(text, "&nbsp;", " ")

	// Collapse whitespace: reduce runs of blank lines
	reBlank := regexp.MustCompile(`\n{3,}`)
	text = reBlank.ReplaceAllString(text, "\n\n")

	return strings.TrimSpace(text)
}

// containsExternalLink checks if the text contains an HTTP/HTTPS URL.
func containsExternalLink(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "http://") || strings.Contains(lower, "https://")
}
