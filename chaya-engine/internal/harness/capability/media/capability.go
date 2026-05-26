package media

import "time"

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
