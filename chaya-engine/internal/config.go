package internal

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Server    ServerConfig    `mapstructure:"server"`
	Postgres  PostgresConfig  `mapstructure:"postgres"`
	Redis     RedisConfig     `mapstructure:"redis"`
	Auth      AuthConfig      `mapstructure:"auth"`
	Embedding EmbeddingConfig `mapstructure:"embedding"`
	Harness   HarnessConfig   `mapstructure:"harness"`
}

// HarnessConfig controls prompt budgets and tool selection for the capability orchestrator.
type HarnessConfig struct {
	PromptBudgetToolsEstTokens    int  `mapstructure:"prompt_budget_tools_est_tokens"`
	PromptBudgetRAGEstTokens      int  `mapstructure:"prompt_budget_rag_est_tokens"`
	PromptBudgetSkillSOPEstTokens int  `mapstructure:"prompt_budget_skill_sop_est_tokens"`
	PromptBudgetMemoryEstTokens   int  `mapstructure:"prompt_budget_memory_est_tokens"`
	ToolSelectMaxPerServer        int  `mapstructure:"tool_select_max_per_server"`
	ToolSelectMinKeywordScore     int  `mapstructure:"tool_select_min_keyword_score"`
	MetricsVerbose                bool `mapstructure:"metrics_verbose"`
}

// EmbeddingConfig configures RAG embeddings (OpenAI API or chaya-ml sidecar).
type EmbeddingConfig struct {
	Mode       string `mapstructure:"mode"`        // "api" | "sidecar"
	APIKey     string `mapstructure:"api_key"`
	APIURL     string `mapstructure:"api_url"`     // default https://api.openai.com/v1
	Model      string `mapstructure:"model"`       // e.g. text-embedding-3-small
	SidecarURL string `mapstructure:"sidecar_url"`   // e.g. http://localhost:8100
}

type ServerConfig struct {
	Host string `mapstructure:"host"`
	Port int    `mapstructure:"port"`
	// PublicURL is the base URL browsers use (e.g. http://localhost:3002) for OAuth redirects and MCP proxy.
	PublicURL string `mapstructure:"public_url"`
}

func (s ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}

// PublicBaseURL returns the externally reachable base URL (no trailing slash).
func (s ServerConfig) PublicBaseURL() string {
	if s.PublicURL != "" {
		return strings.TrimSuffix(s.PublicURL, "/")
	}
	return fmt.Sprintf("http://localhost:%d", s.Port)
}

type PostgresConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	User     string `mapstructure:"user"`
	Password string `mapstructure:"password"`
	Database string `mapstructure:"database"`
	SSLMode  string `mapstructure:"sslmode"`
}

func (p PostgresConfig) DSN() string {
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		p.Host, p.Port, p.User, p.Password, p.Database, p.SSLMode)
}

type RedisConfig struct {
	Addr     string `mapstructure:"addr"`
	Password string `mapstructure:"password"`
	DB       int    `mapstructure:"db"`
}

type AuthConfig struct {
	JWTSecret string        `mapstructure:"jwt_secret"`
	TokenTTL  time.Duration `mapstructure:"token_ttl"`
}

func LoadConfig() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath("./config")
	viper.AddConfigPath(".")

	viper.AutomaticEnv()

	if err := viper.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}

	return &cfg, nil
}
