package media

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	pkg "github.com/chaya-ai/chaya-engine/pkg"
	"gorm.io/gorm"
)

// GalleryEntry represents a generated media item.
type GalleryEntry struct {
	ID         string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID     string    `gorm:"type:uuid;index" json:"user_id"`
	TenantID   string    `gorm:"type:uuid;index" json:"tenant_id"`
	MediaType  string    `json:"media_type"`  // image / video
	Provider   string    `json:"provider"`    // gemini / dalle / runway
	Prompt     string    `json:"prompt"`
	FileURL    string    `json:"file_url"`
	Thumbnail  string    `json:"thumbnail,omitempty"`
	Tags       string    `gorm:"type:text" json:"tags,omitempty"` // JSON array as string
	Width      int       `json:"width,omitempty"`
	Height     int       `json:"height,omitempty"`
	Duration   float64   `json:"duration,omitempty"` // video seconds
	SourceConv string    `gorm:"type:uuid" json:"source_conv,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

func (GalleryEntry) TableName() string { return "gallery" }

// Capability implements the Tool interface for media generation.
type Capability struct {
	db *gorm.DB
}

func NewCapability(db *gorm.DB) *Capability {
	return &Capability{db: db}
}

// AsTool returns the media generation tool definition.
func (c *Capability) AsTool() pkg.Tool {
	params, _ := json.Marshal(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"prompt":     map[string]string{"type": "string", "description": "What to generate"},
			"media_type": map[string]any{"type": "string", "enum": []string{"image", "video"}},
			"style":      map[string]string{"type": "string", "description": "Style (optional)"},
			"provider":   map[string]string{"type": "string", "description": "Provider (optional)"},
		},
		"required": []string{"prompt", "media_type"},
	})

	return pkg.Tool{
		Name:        "media_generate",
		Description: "Generate images or videos from text description",
		Parameters:  params,
		Source:      "media",
		ExecuteFn:   c.Execute,
	}
}

// Execute generates media. Phase 4 stub — returns placeholder.
// Real implementation will call Gemini/DALL-E/Runway APIs.
func (c *Capability) Execute(ctx context.Context, args json.RawMessage) (*pkg.ToolResult, error) {
	var req struct {
		Prompt    string `json:"prompt"`
		MediaType string `json:"media_type"`
		Style     string `json:"style"`
		Provider  string `json:"provider"`
	}
	json.Unmarshal(args, &req)

	// TODO: call actual provider (Gemini/DALL-E/Runway)
	// For now, create a gallery entry stub
	entry := GalleryEntry{
		MediaType: req.MediaType,
		Provider:  "stub",
		Prompt:    req.Prompt,
		FileURL:   fmt.Sprintf("https://placeholder.com/%s.png", req.MediaType),
	}
	if c.db != nil {
		c.db.Create(&entry)
	}

	data, _ := json.Marshal(entry)
	return &pkg.ToolResult{
		Success: true,
		Body:    fmt.Sprintf("Generated %s: %s", req.MediaType, entry.FileURL),
		Data:    data,
	}, nil
}
