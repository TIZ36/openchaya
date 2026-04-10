package rag

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"gorm.io/gorm"
)

// KBDocument represents an uploaded document.
type KBDocument struct {
	ID        string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AgentID   string    `gorm:"type:uuid;index" json:"agent_id"`
	FileName  string    `json:"file_name"`
	FileType  string    `json:"file_type"`
	FileSize  int64     `json:"file_size"`
	Status    string    `gorm:"default:pending" json:"status"` // pending/processing/ready/error
	ErrorMsg  string    `json:"error_msg,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (KBDocument) TableName() string { return "kb_documents" }

// KBChunk represents a chunk stored with its embedding in pgvector.
type KBChunk struct {
	ID        string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	DocID     string    `gorm:"type:uuid;index" json:"doc_id"`
	AgentID   string    `gorm:"type:uuid;index" json:"agent_id"`
	Text      string    `gorm:"type:text;not null" json:"text"`
	Heading   string    `json:"heading,omitempty"`
	ParentID  string    `gorm:"type:uuid" json:"parent_id,omitempty"`
	Position  int       `json:"position"`
	CtxBefore string    `json:"ctx_before,omitempty"`
	CtxAfter  string    `json:"ctx_after,omitempty"`
	Embedding string    `gorm:"type:vector(384)" json:"-"` // pgvector column (sidecar MiniLM 384; OpenAI API mode uses 1536 + separate schema)
	CreatedAt time.Time `json:"created_at"`
}

func (KBChunk) TableName() string { return "kb_chunks" }

// SearchResult is a chunk with its similarity score.
type SearchResult struct {
	KBChunk
	Score float64 `json:"score"`
}

// Retriever handles RAG: embed query → pgvector search → context expansion.
type Retriever struct {
	db       *gorm.DB
	embedder *Embedder
}

func NewRetriever(db *gorm.DB, embedder *Embedder) *Retriever {
	return &Retriever{db: db, embedder: embedder}
}

// Index processes a document: chunks → embeds → stores in pgvector.
func (r *Retriever) Index(ctx context.Context, doc KBDocument, fullText string) error {
	// 1. Smart chunk
	chunks := SmartChunk(fullText, 1500)
	if len(chunks) == 0 {
		return fmt.Errorf("no chunks generated")
	}

	slog.Info("rag indexing", "doc", doc.FileName, "chunks", len(chunks))

	// 2. Embed all chunks
	texts := make([]string, len(chunks))
	for i, c := range chunks {
		texts[i] = c.Text
	}

	vectors, err := r.embedder.Embed(ctx, texts)
	if err != nil {
		return fmt.Errorf("embed: %w", err)
	}

	// 3. Store in DB with pgvector
	for i, chunk := range chunks {
		vecStr := vectorToString(vectors[i])
		kbChunk := KBChunk{
			DocID:     doc.ID,
			AgentID:   doc.AgentID,
			Text:      chunk.Text,
			Heading:   chunk.Heading,
			Position:  chunk.Position,
			CtxBefore: chunk.CtxBefore,
			CtxAfter:  chunk.CtxAfter,
			Embedding: vecStr,
		}

		if err := r.db.Exec(
			`INSERT INTO kb_chunks (id, doc_id, agent_id, text, heading, position, ctx_before, ctx_after, embedding, created_at)
			 VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, ?, ?, ?::vector, NOW())`,
			kbChunk.DocID, kbChunk.AgentID, kbChunk.Text, kbChunk.Heading,
			kbChunk.Position, kbChunk.CtxBefore, kbChunk.CtxAfter, vecStr,
		).Error; err != nil {
			slog.Error("insert chunk", "err", err)
		}
	}

	// 4. Update doc status
	r.db.Model(&KBDocument{}).Where("id = ?", doc.ID).Updates(map[string]any{
		"status": "ready",
	})

	slog.Info("rag indexed", "doc", doc.FileName, "chunks", len(chunks))
	return nil
}

// Retrieve searches for relevant chunks and expands context.
// tenantID, when non-empty, restricts hits to agents owned by users in that tenant (defense in depth).
func (r *Retriever) Retrieve(ctx context.Context, query, agentID, tenantID string, topK int) []SearchResult {
	if topK <= 0 {
		topK = 5
	}

	// 1. Embed query
	vecs, err := r.embedder.Embed(ctx, []string{query})
	if err != nil || len(vecs) == 0 {
		slog.Warn("rag query embed failed", "err", err)
		return nil
	}

	queryVec := vectorToString(vecs[0])

	// 2. pgvector cosine similarity search
	var results []SearchResult
	if tenantID != "" {
		r.db.Raw(`
			SELECT c.*, 1 - (c.embedding <=> ?::vector) AS score
			FROM kb_chunks c
			INNER JOIN agents a ON a.id = c.agent_id
			INNER JOIN users u ON u.id = a.user_id
			WHERE c.agent_id = ? AND u.tenant_id = ?
			ORDER BY c.embedding <=> ?::vector
			LIMIT ?
		`, queryVec, agentID, tenantID, queryVec, topK).Scan(&results)
	} else {
		r.db.Raw(`
			SELECT *, 1 - (embedding <=> ?::vector) AS score
			FROM kb_chunks
			WHERE agent_id = ?
			ORDER BY embedding <=> ?::vector
			LIMIT ?
		`, queryVec, agentID, queryVec, topK).Scan(&results)
	}

	if len(results) == 0 {
		return nil
	}

	// 3. Context expansion: for each hit, also get adjacent chunks
	expanded := r.expandContext(results)

	return expanded
}

// FormatForPrompt formats retrieved chunks for system prompt injection.
func FormatForPrompt(results []SearchResult) string {
	if len(results) == 0 {
		return ""
	}

	var b strings.Builder
	b.WriteString("【知识库参考资料】\n")
	for i, r := range results {
		b.WriteString(fmt.Sprintf("\n[参考%d]", i+1))
		if r.Heading != "" {
			b.WriteString(fmt.Sprintf(" (%s)", r.Heading))
		}
		b.WriteString(fmt.Sprintf(" (相关度: %.2f)\n", r.Score))

		if r.CtxBefore != "" {
			b.WriteString(fmt.Sprintf("[前文] %s\n", r.CtxBefore))
		}
		b.WriteString(r.Text + "\n")
		if r.CtxAfter != "" {
			b.WriteString(fmt.Sprintf("[后文] %s\n", r.CtxAfter))
		}
	}
	return b.String()
}

// expandContext adds adjacent chunks for each hit to preserve reading context.
func (r *Retriever) expandContext(results []SearchResult) []SearchResult {
	seen := make(map[string]bool)
	var expanded []SearchResult

	for _, res := range results {
		if seen[res.ID] {
			continue
		}
		seen[res.ID] = true
		expanded = append(expanded, res)

		// Get neighbors (position-1 and position+1 in same doc)
		var neighbors []KBChunk
		r.db.Where("doc_id = ? AND position IN (?, ?) AND id != ?",
			res.DocID, res.Position-1, res.Position+1, res.ID,
		).Order("position").Find(&neighbors)

		for _, n := range neighbors {
			if !seen[n.ID] {
				seen[n.ID] = true
				expanded = append(expanded, SearchResult{KBChunk: n, Score: res.Score * 0.8})
			}
		}
	}

	return expanded
}

// vectorToString converts []float32 to pgvector format "[0.1,0.2,...]"
func vectorToString(vec []float32) string {
	parts := make([]string, len(vec))
	for i, v := range vec {
		parts[i] = fmt.Sprintf("%f", v)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

// DeleteByDoc removes all chunks for a document.
func (r *Retriever) DeleteByDoc(docID string) {
	r.db.Where("doc_id = ?", docID).Delete(&KBChunk{})
}
