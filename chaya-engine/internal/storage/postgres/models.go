package postgres

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// BeforeCreate hook to set UUID
func setUUID(id *string) {
	if *id == "" {
		*id = uuid.New().String()
	}
}

// ========== Tenant ==========

type Tenant struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name      string          `gorm:"not null" json:"name"`
	Plan      string          `gorm:"default:free" json:"plan"` // free / pro / ultra
	Config    json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"config"`
	CreatedAt time.Time       `json:"created_at"`
}

func (t *Tenant) BeforeCreate(tx *gorm.DB) error { setUUID(&t.ID); return nil }

// ========== User ==========

type User struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TenantID    string          `gorm:"type:uuid;index" json:"tenant_id"`
	Email       string          `gorm:"uniqueIndex" json:"email"`
	Name        string          `json:"name"`
	Password    string          `gorm:"not null" json:"-"` // bcrypt hash
	Preferences json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"preferences"`
	CreatedAt   time.Time       `json:"created_at"`

	Tenant *Tenant `gorm:"foreignKey:TenantID" json:"-"`
}

func (u *User) BeforeCreate(tx *gorm.DB) error { setUUID(&u.ID); return nil }

// ========== Agent ==========

type Agent struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID      string          `gorm:"type:uuid;index" json:"user_id"`
	Type        string          `gorm:"not null" json:"type"` // primary / sub / generic（用户新建，可删）
	Name        string          `gorm:"not null" json:"name"`
	Config      json.RawMessage `gorm:"type:jsonb;not null" json:"config"` // system_prompt, persona, voice
	Permissions json.RawMessage `gorm:"type:jsonb;default:'[]'" json:"permissions"`
	IsPrimary   bool            `gorm:"default:false" json:"is_primary"`
	CreatedAt   time.Time       `json:"created_at"`

	User *User `gorm:"foreignKey:UserID" json:"-"`
}

func (a *Agent) BeforeCreate(tx *gorm.DB) error { setUUID(&a.ID); return nil }

// ========== Conversation ==========

type Conversation struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID    string          `gorm:"type:uuid;index" json:"user_id"`
	Title     string          `json:"title"`
	Type      string          `gorm:"default:private" json:"type"` // private / group
	Config    json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"config"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`

	User *User `gorm:"foreignKey:UserID" json:"-"`
}

func (c *Conversation) BeforeCreate(tx *gorm.DB) error { setUUID(&c.ID); return nil }

// ========== ConversationAgent (join table) ==========

type ConversationAgent struct {
	ConversationID string `gorm:"primaryKey;type:uuid" json:"conversation_id"`
	AgentID        string `gorm:"primaryKey;type:uuid" json:"agent_id"`
}

// ========== Message ==========

type Message struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ConvID    string          `gorm:"type:uuid;index;column:conv_id" json:"conv_id"`
	Role      string          `gorm:"not null" json:"role"` // user / assistant
	Content   string          `gorm:"type:text" json:"content"`
	Ext       json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"ext,omitempty"`
	Source    string          `json:"source,omitempty"` // primary / direct
	SourceID  string          `json:"source_id,omitempty"`
	AgentID   *string         `gorm:"type:uuid" json:"agent_id,omitempty"`
	Model     string          `json:"model,omitempty"`
	TokensIn  int             `json:"tokens_in,omitempty"`
	TokensOut int             `json:"tokens_out,omitempty"`
	CreatedAt time.Time       `json:"created_at"`

	Parts []MessagePart `gorm:"foreignKey:MessageID" json:"parts,omitempty"`
}

func (m *Message) BeforeCreate(tx *gorm.DB) error { setUUID(&m.ID); return nil }

// ========== MessagePart ==========

type MessagePart struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	MessageID string          `gorm:"type:uuid;index" json:"message_id"`
	Type      string          `gorm:"not null" json:"type"`           // text / reasoning / tool / media / subtask
	State     string          `gorm:"default:completed" json:"state"` // pending / running / completed / error
	Data      json.RawMessage `gorm:"type:jsonb" json:"data"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

func (mp *MessagePart) BeforeCreate(tx *gorm.DB) error { setUUID(&mp.ID); return nil }

// ========== LLMConfig ==========

type LLMConfig struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TenantID     string          `gorm:"type:uuid;index" json:"tenant_id"`
	Provider     string          `gorm:"not null" json:"provider"` // openai / anthropic / gemini
	Model        string          `gorm:"not null" json:"model"`
	APIKey       string          `gorm:"column:api_key" json:"api_key,omitempty"`
	APIURL       string          `json:"api_url,omitempty"`
	Config       json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"config"`
	Enabled      bool            `gorm:"default:true" json:"enabled"`
	MediaVisible bool            `gorm:"column:media_visible;default:false" json:"media_visible"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (l *LLMConfig) BeforeCreate(tx *gorm.DB) error { setUUID(&l.ID); return nil }

// ========== LocalAgentCredential ==========
// 本地 CLI Agent（cursor / codex / gemini）的凭据。纯供桌面端本地驱动使用，
// 不是后端 LLM provider，故独立于 LLMConfig，避免污染模型选择列表。按用户作用域。

type LocalAgentCredential struct {
	ID        string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID    string    `gorm:"type:uuid;uniqueIndex:idx_lac_user_provider;not null" json:"user_id"`
	TenantID  string    `gorm:"type:uuid;index" json:"tenant_id"`
	Provider  string    `gorm:"uniqueIndex:idx_lac_user_provider;not null" json:"provider"` // cursor / codex / gemini
	APIKey    string    `gorm:"column:api_key" json:"api_key,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (c *LocalAgentCredential) BeforeCreate(tx *gorm.DB) error { setUUID(&c.ID); return nil }

// ========== LLMProvider ==========

type LLMProvider struct {
	ID            string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TenantID      string          `gorm:"type:uuid;uniqueIndex:idx_llm_provider_tenant_provider" json:"tenant_id"`
	ProviderID    string          `gorm:"column:provider_id;not null;uniqueIndex:idx_llm_provider_tenant_provider" json:"provider_id"`
	Supplier      string          `gorm:"default:''" json:"supplier,omitempty"`
	Name          string          `gorm:"not null" json:"name"`
	ProviderType  string          `gorm:"column:provider_type;not null" json:"provider_type"`
	IsSystem      bool            `gorm:"column:is_system;default:false" json:"is_system"`
	OverrideURL   bool            `gorm:"column:override_url;default:false" json:"override_url"`
	DefaultAPIURL string          `gorm:"column:default_api_url" json:"default_api_url,omitempty"`
	LogoLight     string          `gorm:"column:logo_light" json:"logo_light,omitempty"`
	LogoDark      string          `gorm:"column:logo_dark" json:"logo_dark,omitempty"`
	LogoTheme     string          `gorm:"column:logo_theme;default:'auto'" json:"logo_theme,omitempty"`
	Metadata      json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"metadata,omitempty"`
	SortOrder     int             `gorm:"column:sort_order;default:9999" json:"sort_order"`
	CreatedAt     time.Time       `json:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at"`
}

func (p *LLMProvider) BeforeCreate(tx *gorm.DB) error { setUUID(&p.ID); return nil }

// ========== MCPServer ==========

type MCPServer struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TenantID  string          `gorm:"type:uuid;index" json:"tenant_id"`
	Name      string          `gorm:"not null" json:"name"`
	URL       string          `gorm:"not null" json:"url"`
	Type      string          `gorm:"default:http" json:"type"` // http / stdio
	Config    json.RawMessage `gorm:"type:jsonb;default:'{}'" json:"config"`
	Enabled   bool            `gorm:"default:true" json:"enabled"`
	Healthy   bool            `gorm:"default:true" json:"healthy"`
	CreatedAt time.Time       `json:"created_at"`
}

func (m *MCPServer) BeforeCreate(tx *gorm.DB) error { setUUID(&m.ID); return nil }

// ========== Skill ==========

type Skill struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TenantID    string          `gorm:"type:uuid;index" json:"tenant_id"`
	Name        string          `gorm:"not null" json:"name"`
	Description string          `json:"description"`
	Keywords    json.RawMessage `gorm:"type:jsonb;default:'[]'" json:"keywords"`
	Steps       json.RawMessage `gorm:"type:jsonb;not null" json:"steps"`
	RequiredMCP json.RawMessage `gorm:"type:jsonb;default:'[]'" json:"required_mcp"`
	CreatedAt   time.Time       `json:"created_at"`
}

func (s *Skill) BeforeCreate(tx *gorm.DB) error { setUUID(&s.ID); return nil }

// ========== AgentSkill (join table) ==========

type AgentSkill struct {
	AgentID string `gorm:"primaryKey;type:uuid" json:"agent_id"`
	SkillID string `gorm:"primaryKey;type:uuid" json:"skill_id"`
}

// ========== AgentMCPServer (join table) ==========
// Controls which MCP servers are visible to which agents (harness scope).

type AgentMCPServer struct {
	AgentID     string    `gorm:"primaryKey;type:uuid" json:"agent_id"`
	MCPServerID string    `gorm:"primaryKey;type:uuid;column:mcp_server_id" json:"mcp_server_id"`
	CreatedAt   time.Time `json:"created_at"`
}

// ========== ImagePromptPack ==========

type ImagePromptPack struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID    string          `gorm:"type:uuid;index" json:"user_id"`
	TenantID  string          `gorm:"type:uuid;index" json:"tenant_id"`
	Title     string          `gorm:"not null" json:"title"`
	Pinned    bool            `gorm:"default:false" json:"pinned"`
	Payload   json.RawMessage `gorm:"type:jsonb;not null" json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

func (p *ImagePromptPack) BeforeCreate(tx *gorm.DB) error { setUUID(&p.ID); return nil }
