package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/rag"
	"gorm.io/gorm"
)

type KBAPI struct {
	db        *gorm.DB
	retriever *rag.Retriever
}

func RegisterKBRoutes(r chi.Router, db *gorm.DB, retriever *rag.Retriever) {
	a := &KBAPI{db: db, retriever: retriever}
	r.Get("/api/kb/documents", a.listDocs)
	r.Get("/api/kb/stats", a.stats)
	r.Post("/api/kb/documents/upload", a.upload)
	r.Post("/api/kb/documents/text", a.addText)
	r.Delete("/api/kb/documents/{id}", a.deleteDoc)
	r.Post("/api/kb/search", a.search)
}

func (a *KBAPI) listDocs(w http.ResponseWriter, r *http.Request) {
	agentID := a.resolveAgentID(r)
	if agentID == "" {
		Fail(w, CodeInvalidParam, "agent_id or conversation_id required")
		return
	}
	var docs []rag.KBDocument
	a.db.Where("agent_id = ?", agentID).Order("created_at desc").Find(&docs)
	OK(w, docs)
}

func (a *KBAPI) stats(w http.ResponseWriter, r *http.Request) {
	agentID := a.resolveAgentID(r)
	if agentID == "" {
		Fail(w, CodeInvalidParam, "agent_id or conversation_id required")
		return
	}
	var docCount, chunkCount int64
	a.db.Model(&rag.KBDocument{}).Where("agent_id = ?", agentID).Count(&docCount)
	a.db.Table("kb_chunks").Where("agent_id = ?", agentID).Count(&chunkCount)
	OK(w, M{"doc_count": docCount, "chunk_count": chunkCount, "agent_id": agentID})
}

func (a *KBAPI) upload(w http.ResponseWriter, r *http.Request) {
	r.ParseMultipartForm(100 << 20)

	agentID := a.resolveAgentID(r)
	if agentID == "" {
		Fail(w, CodeInvalidParam, "agent_id or conversation_id required")
		return
	}
	files := r.MultipartForm.File["files"]
	var results []rag.KBDocument

	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			continue
		}
		content, _ := io.ReadAll(f)
		f.Close()

		doc := rag.KBDocument{
			AgentID:  agentID,
			FileName: fh.Filename,
			FileType: filepath.Ext(fh.Filename),
			FileSize: fh.Size,
			Status:   "processing",
		}
		a.db.Create(&doc)

		go func(d rag.KBDocument, text string) {
			if err := a.retriever.Index(context.Background(), d, text); err != nil {
				a.db.Model(&rag.KBDocument{}).Where("id = ?", d.ID).Updates(map[string]any{
					"status": "error", "error_msg": err.Error(),
				})
			}
		}(doc, string(content))

		results = append(results, doc)
	}
	OK(w, M{"documents": results})
}

func (a *KBAPI) addText(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text    string `json:"text"`
		Title   string `json:"title"`
		AgentID string `json:"agent_id"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	agentID := req.AgentID
	if agentID == "" {
		agentID = a.resolveAgentID(r)
	} else {
		if !agentAccessForUser(a.db, agentID, middleware.UserID(r.Context()), middleware.TenantID(r.Context())) {
			Fail(w, CodeNotFound, "agent not found")
			return
		}
	}
	if agentID == "" {
		Fail(w, CodeInvalidParam, "agent_id or conversation_id required")
		return
	}
	title := req.Title
	if title == "" {
		title = "chat_memory"
	}

	doc := rag.KBDocument{
		AgentID: agentID, FileName: title + ".md", FileType: ".md",
		FileSize: int64(len(req.Text)), Status: "processing",
	}
	a.db.Create(&doc)

	go func() {
		if err := a.retriever.Index(context.Background(), doc, req.Text); err != nil {
			a.db.Model(&rag.KBDocument{}).Where("id = ?", doc.ID).Updates(map[string]any{
				"status": "error", "error_msg": err.Error(),
			})
		}
	}()

	OK(w, doc)
}

func (a *KBAPI) deleteDoc(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())

	var cnt int64
	q := a.db.Table("kb_documents AS kd").
		Joins("INNER JOIN agents ag ON ag.id = kd.agent_id").
		Joins("INNER JOIN users u ON u.id = ag.user_id").
		Where("kd.id = ? AND ag.user_id = ?", id, userID)
	if tenantID != "" {
		q = q.Where("u.tenant_id = ?", tenantID)
	}
	if err := q.Count(&cnt).Error; err != nil || cnt == 0 {
		Fail(w, CodeNotFound, "not found")
		return
	}
	a.retriever.DeleteByDoc(id)
	a.db.Where("id = ?", id).Delete(&rag.KBDocument{})
	OK(w, M{"ok": true})
}

func (a *KBAPI) search(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query   string `json:"query"`
		AgentID string `json:"agent_id"`
		TopK    int    `json:"top_k"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	agentID := req.AgentID
	if agentID == "" {
		agentID = a.resolveAgentID(r)
	} else {
		if !agentAccessForUser(a.db, agentID, middleware.UserID(r.Context()), middleware.TenantID(r.Context())) {
			Fail(w, CodeNotFound, "agent not found")
			return
		}
	}
	if agentID == "" {
		Fail(w, CodeInvalidParam, "agent_id or conversation_id required")
		return
	}

	tenantID := middleware.TenantID(r.Context())
	results := a.retriever.Retrieve(r.Context(), req.Query, agentID, tenantID, req.TopK)
	OK(w, M{"results": results})
}

func (a *KBAPI) resolveAgentID(r *http.Request) string {
	userID := middleware.UserID(r.Context())
	tenantID := middleware.TenantID(r.Context())
	if id := r.URL.Query().Get("agent_id"); id != "" {
		if agentAccessForUser(a.db, id, userID, tenantID) {
			return id
		}
		return ""
	}
	if id := r.FormValue("agent_id"); id != "" {
		if agentAccessForUser(a.db, id, userID, tenantID) {
			return id
		}
		return ""
	}
	if cid := r.URL.Query().Get("conversation_id"); cid != "" {
		if aid := a.agentForConversation(userID, cid); aid != "" {
			if agentAccessForUser(a.db, aid, userID, tenantID) {
				return aid
			}
		}
	}
	if cid := r.URL.Query().Get("session_id"); cid != "" {
		if aid := a.agentForConversation(userID, cid); aid != "" {
			if agentAccessForUser(a.db, aid, userID, tenantID) {
				return aid
			}
		}
	}
	if cid := r.FormValue("conversation_id"); cid != "" {
		if aid := a.agentForConversation(userID, cid); aid != "" {
			if agentAccessForUser(a.db, aid, userID, tenantID) {
				return aid
			}
		}
	}
	var agentID string
	a.db.Table("agents").Where("user_id = ? AND is_primary = true", userID).Limit(1).Pluck("id", &agentID)
	if agentID == "" {
		return ""
	}
	if agentAccessForUser(a.db, agentID, userID, tenantID) {
		return agentID
	}
	return ""
}

func (a *KBAPI) agentForConversation(userID, convID string) string {
	if convID == "" || userID == "" {
		return ""
	}
	var owner string
	a.db.Table("conversations").Select("user_id").Where("id = ?", convID).Scan(&owner)
	if owner != userID {
		return ""
	}
	var agentID string
	a.db.Table("conversation_agents").Select("agent_id").Where("conversation_id = ?", convID).Limit(1).Scan(&agentID)
	return agentID
}
