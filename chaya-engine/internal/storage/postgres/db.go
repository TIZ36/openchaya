package postgres

import (
	"fmt"
	"log"
	"log/slog"
	"os"

	"github.com/chaya-ai/chaya-engine/internal"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Connect(cfg internal.PostgresConfig) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{
		Logger: logger.New(log.New(os.Stdout, "\r\n", log.LstdFlags), logger.Config{
			LogLevel:                  logger.Error,
			IgnoreRecordNotFoundError: true,
			ParameterizedQueries:      true,
		}),
	})
	if err != nil {
		return nil, fmt.Errorf("postgres connect: %w", err)
	}

	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)

	slog.Info("postgres connected", "host", cfg.Host, "db", cfg.Database)
	return db, nil
}

func AutoMigrate(db *gorm.DB) error {
	// Core tables (GORM AutoMigrate)
	if err := db.AutoMigrate(
		&Tenant{},
		&User{},
		&Agent{},
		&Conversation{},
		&ConversationAgent{},
		&Message{},
		&MessagePart{},
		&LLMConfig{},
		&LLMProvider{},
		&MCPServer{},
		&Skill{},
		&AgentSkill{},
		&AgentMCPServer{},
		&ImagePromptPack{},
	); err != nil {
		return err
	}

	// pgvector extension + RAG tables (raw SQL, GORM can't handle vector type)
	stmts := []string{
		`UPDATE tenants SET plan = 'ultra' WHERE plan = 'enterprise'`,
		`UPDATE tenants SET plan = 'free' WHERE plan IS NULL OR plan NOT IN ('free', 'pro', 'ultra')`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ext JSONB DEFAULT '{}'::jsonb`,
		`UPDATE messages SET ext = '{}'::jsonb WHERE ext IS NULL`,
		`DELETE FROM llm_providers a USING llm_providers b
		 WHERE a.id < b.id
		   AND a.tenant_id = b.tenant_id
		   AND a.provider_id = b.provider_id`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_provider_tenant_provider ON llm_providers(tenant_id, provider_id)`,
		`CREATE EXTENSION IF NOT EXISTS vector`,
		`CREATE TABLE IF NOT EXISTS kb_documents (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id UUID NOT NULL,
			file_name TEXT NOT NULL,
			file_type TEXT NOT NULL,
			file_size BIGINT DEFAULT 0,
			status TEXT DEFAULT 'pending',
			error_msg TEXT,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kbdoc_agent ON kb_documents(agent_id)`,
		`CREATE TABLE IF NOT EXISTS kb_chunks (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			doc_id UUID REFERENCES kb_documents(id) ON DELETE CASCADE,
			agent_id UUID NOT NULL,
			text TEXT NOT NULL,
			heading TEXT,
			parent_id UUID,
			position INT DEFAULT 0,
			ctx_before TEXT,
			ctx_after TEXT,
			embedding vector(384),
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_kbchunk_agent ON kb_chunks(agent_id)`,
		`CREATE TABLE IF NOT EXISTS gallery (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID,
			tenant_id UUID,
			media_type TEXT NOT NULL,
			provider TEXT NOT NULL,
			prompt TEXT,
			file_url TEXT NOT NULL,
			thumbnail TEXT,
			tags TEXT,
			width INT,
			height INT,
			duration FLOAT,
			source_conv UUID,
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_gallery_user ON gallery(user_id)`,
		`CREATE TABLE IF NOT EXISTS agent_topology (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id UUID UNIQUE NOT NULL,
			graph JSONB NOT NULL DEFAULT '{}',
			version INT DEFAULT 1,
			built_at TIMESTAMPTZ,
			summary TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS agent_traces (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id UUID NOT NULL,
			user_input TEXT,
			intent_tag TEXT,
			actions JSONB,
			success BOOLEAN DEFAULT TRUE,
			duration_ms BIGINT DEFAULT 0,
			user_feedback TEXT DEFAULT 'neutral',
			created_at TIMESTAMPTZ DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_traces_agent ON agent_traces(agent_id, created_at DESC)`,
		`ALTER TABLE llm_configs ADD COLUMN IF NOT EXISTS media_visible BOOLEAN NOT NULL DEFAULT FALSE`,
		`UPDATE llm_configs SET media_visible = true WHERE (config::jsonb -> 'metadata' ->> 'media_purpose') = 'true' AND media_visible = false`,
	}
	for _, s := range stmts {
		if err := db.Exec(s).Error; err != nil {
			slog.Warn("migration stmt", "err", err, "sql", s[:min(len(s), 60)])
		}
	}

	migrateKbEmbeddingDim(db)

	return nil
}

// migrateKbEmbeddingDim upgrades legacy vector(1536) columns to vector(384) for chaya-ml sidecar.
// Existing chunk rows are cleared; re-upload documents if needed.
func migrateKbEmbeddingDim(db *gorm.DB) {
	var fmtType string
	err := db.Raw(`
		SELECT format_type(a.atttypid, a.atttypmod)
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relname = 'kb_chunks' AND a.attname = 'embedding' AND NOT a.attisdropped
	`).Scan(&fmtType).Error
	if err != nil || fmtType == "" {
		return
	}
	if fmtType == "vector(1536)" {
		slog.Warn("kb_chunks.embedding is vector(1536); migrating to vector(384) — existing KB chunks will be cleared")
		_ = db.Exec(`ALTER TABLE kb_chunks DROP COLUMN embedding`).Error
		_ = db.Exec(`ALTER TABLE kb_chunks ADD COLUMN embedding vector(384)`).Error
	}
}
