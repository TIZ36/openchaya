package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/chaya-ai/chaya-engine/internal"
	"github.com/chaya-ai/chaya-engine/internal/api"
	"github.com/chaya-ai/chaya-engine/internal/gateway"
	mw "github.com/chaya-ai/chaya-engine/internal/gateway/middleware"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/mcp"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/memory"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/rag"
	"github.com/chaya-ai/chaya-engine/internal/harness/capability/skill"
	"github.com/chaya-ai/chaya-engine/internal/harness/runtime"
	"github.com/chaya-ai/chaya-engine/internal/provider"
	pgstore "github.com/chaya-ai/chaya-engine/internal/storage/postgres"
	"github.com/chaya-ai/chaya-engine/internal/teahouse"
	redisstore "github.com/chaya-ai/chaya-engine/internal/storage/redis"
	"github.com/chaya-ai/chaya-engine/pkg/envelope"
	"github.com/go-chi/chi/v5"
)

func harnessRuntimeFromConfig(cfg *internal.Config) *capability.HarnessRuntimeConfig {
	var z internal.HarnessConfig
	if cfg == nil || cfg.Harness == z {
		return nil
	}
	return &capability.HarnessRuntimeConfig{
		PromptToolsTextEstTokens:    cfg.Harness.PromptBudgetToolsEstTokens,
		PromptRAGEstTokens:          cfg.Harness.PromptBudgetRAGEstTokens,
		PromptSkillSOPEstTokens:     cfg.Harness.PromptBudgetSkillSOPEstTokens,
		PromptMemoryEstTokens:       cfg.Harness.PromptBudgetMemoryEstTokens,
		ToolSelectMaxPerServer:      cfg.Harness.ToolSelectMaxPerServer,
		ToolSelectMinKeywordScore:   cfg.Harness.ToolSelectMinKeywordScore,
		MetricsVerbose:              cfg.Harness.MetricsVerbose,
	}
}

func main() {
	// ── Config ──
	cfg, err := internal.LoadConfig()
	if err != nil {
		slog.Error("load config", "err", err)
		os.Exit(1)
	}

	// ── Storage ──
	db, err := pgstore.Connect(cfg.Postgres)
	if err != nil {
		slog.Error("postgres", "err", err)
		os.Exit(1)
	}
	if err := pgstore.AutoMigrate(db); err != nil {
		slog.Error("auto migrate", "err", err)
		os.Exit(1)
	}

	rdb, err := redisstore.Connect(cfg.Redis)
	if err != nil {
		slog.Warn("redis unavailable, continuing without cache", "err", err)
	}

	// ── WebSocket Hub ──
	hub := gateway.NewHub()
	go hub.Run()

	// ── Provider Registry (loads from DB on demand) ──
	providerRegistry := provider.NewRegistry(db)

	// ── RAG Retriever ──
	embedder := rag.NewEmbedder(rag.EmbedderConfig{
		Mode:       cfg.Embedding.Mode,
		APIKey:     cfg.Embedding.APIKey,
		APIURL:     cfg.Embedding.APIURL,
		Model:      cfg.Embedding.Model,
		SidecarURL: cfg.Embedding.SidecarURL,
	})
	ragRetriever := rag.NewRetriever(db, embedder)

	// ── Harness capabilities ──
	mcp.LoadDescriptionsDefault()
	mcpReg := mcp.NewRegistry(db, rdb)
	if err := mcpReg.LoadServers(context.Background()); err != nil {
		slog.Warn("mcp registry load", "err", err)
	}
	var memStore *memory.Store
	if rdb != nil {
		memStore = memory.NewStore(rdb)
	}
	skillReg := skill.NewRegistry(db)
	orch := capability.NewOrchestrator(mcpReg, memStore, skillReg, db, ragRetriever, harnessRuntimeFromConfig(cfg))

	// ── Actor Pool ──
	actorPool := runtime.NewActorPool(hub, providerRegistry, db, orch, rdb)

	// ── Teahouse (Agent-less direct LLM chat) ──
	teahouseSvc := teahouse.NewService(db, hub, providerRegistry)

	// ── WS Message Handler ──
	onWSMessage := func(client *gateway.Client, msg *gateway.WSMessage) {
		switch msg.Type {
		case "interrupt":
			// Client wants to stop the current in-flight turn on this topic.
			// msg.Topic = conv_id. We deliver a TypeInterrupt envelope to the
			// user's primary actor; actors (generic_mailbox / primary_agent /
			// sub_actor) already handle TypeInterrupt to cancel their current
			// work and ack back via the topic (agent_interrupt_ack event).
			convID := msg.Topic
			if convID == "" {
				slog.Warn("ws interrupt missing topic")
				break
			}
			if !api.ConversationAccessForUser(db, convID, client.UserID, client.TenantID) {
				slog.Warn("ws interrupt denied: conv not accessible", "user", client.UserID, "conv", convID)
				break
			}
			env := envelope.New(envelope.TypeInterrupt, client.UserID, "")
			env.ConvID = convID
			if err := actorPool.SendToUser(client.UserID, env); err != nil {
				slog.Warn("interrupt deliver failed", "err", err, "conv", convID)
			}

		case "message":
			var payload struct {
				Content string         `json:"content"`
				ConvID  string         `json:"conv_id"` // conversation id; not WebSocket usersession (client.ID)
				Ext     map[string]any `json:"ext"`
			}
			json.Unmarshal(msg.Payload, &payload)

			if payload.ConvID == "" {
				slog.Warn("ws message missing conv_id")
				break
			}
			if !api.ConversationAccessForUser(db, payload.ConvID, client.UserID, client.TenantID) {
				slog.Warn("ws message denied: conv not accessible", "user", client.UserID, "conv", payload.ConvID)
				break
			}

			hub.Subscribe(client.ID, payload.ConvID) // topic = convid

			// 首包提示：SendToUser 前（含首次拉起 Supervisor/Primary）可能阻塞数秒，先推 execution_log 让前端有反馈。
			if aid := runtime.PrimaryAgentIDForUser(db, client.UserID); aid != "" {
				ts := time.Now().UnixMilli()
				hub.Publish(payload.ConvID, map[string]any{
					"type":       "execution_log",
					"id":         fmt.Sprintf("gw-preamble-%d", ts),
					"log_type":   "step",
					"message":    "已收到消息，正在接入智能体（首次连接可能需要几秒）…",
					"timestamp":  ts,
					"agent_id":   aid,
					"agent_name": "Chaya",
				})
			}

			env := envelope.Chat(client.UserID, payload.ConvID, payload.Content)
			if len(payload.Ext) > 0 {
				env.WithData(payload.Ext)
			}
			if err := actorPool.SendToUser(client.UserID, env); err != nil {
				slog.Error("send to user", "err", err)
				if aid := runtime.PrimaryAgentIDForUser(db, client.UserID); aid != "" {
					ts := time.Now().UnixMilli()
					hub.Publish(payload.ConvID, map[string]any{
						"type":       "execution_log",
						"id":         fmt.Sprintf("gw-err-%d", ts),
						"log_type":   "error",
						"message":    "消息未能进入处理队列：" + err.Error(),
						"timestamp":  ts,
						"agent_id":   aid,
						"agent_name": "Chaya",
					})
				}
			}

		case "teahouse_message":
			var payload struct {
				ConvID  string         `json:"conv_id"`
				Content string         `json:"content"`
				Ext     map[string]any `json:"ext"`
			}
			json.Unmarshal(msg.Payload, &payload)
			if payload.ConvID == "" {
				slog.Warn("ws teahouse_message missing conv_id")
				break
			}
			if !api.ConversationAccessForUser(db, payload.ConvID, client.UserID, client.TenantID) {
				slog.Warn("ws teahouse denied: conv not accessible", "user", client.UserID, "conv", payload.ConvID)
				break
			}
			hub.Subscribe(client.ID, payload.ConvID)
			if err := teahouseSvc.Start(teahouse.TurnRequest{
				ConvID:  payload.ConvID,
				UserID:  client.UserID,
				Content: payload.Content,
				Ext:     payload.Ext,
			}); err != nil {
				slog.Warn("teahouse start failed", "err", err, "conv", payload.ConvID)
				hub.Publish(payload.ConvID, map[string]any{
					"type":       "agent_stream_done",
					"agent_id":   "teahouse",
					"message_id": "",
					"content":    "❌ " + err.Error(),
					"error":      err.Error(),
				})
			}

		case "teahouse_interrupt":
			convID := msg.Topic
			if convID == "" {
				slog.Warn("ws teahouse_interrupt missing topic")
				break
			}
			if !api.ConversationAccessForUser(db, convID, client.UserID, client.TenantID) {
				slog.Warn("ws teahouse_interrupt denied", "user", client.UserID, "conv", convID)
				break
			}
			teahouseSvc.Cancel(convID)
		}
	}

	// ── HTTP Router + API ──
	router := gateway.NewRouter(hub, onWSMessage, func(userID, tenantID, convID string) bool {
		return api.ConversationAccessForUser(db, convID, userID, tenantID)
	}, func(r chi.Router) {
		// Public routes (no JWT)
		api.RegisterAuthRoutes(r, db, cfg.Auth.JWTSecret, cfg.Auth.TokenTTL)
		// MCP streamable HTTP proxy (CORS); optional server_id + JWT injects auth
		api.RegisterMCPProxyRoutes(r, db, rdb, cfg.Auth.JWTSecret)
		api.RegisterMCPOAuthPublicRoutes(r, rdb, cfg, db, mcpReg)
		api.RegisterMediaOutputPublicRoutes(r, db)

		// Protected routes (JWT required)
		r.Group(func(r chi.Router) {
			r.Use(mw.JWTAuth(cfg.Auth.JWTSecret))
			api.RegisterAdminRoutes(r, db)
			api.RegisterConversationRoutes(r, db, providerRegistry, actorPool)
			api.RegisterTeahouseRoutes(r, db)
			api.RegisterChatFollowupRoutes(r, db, providerRegistry)
			api.RegisterAgentRoutes(r, db)
			api.RegisterAgentHarnessRoutes(r, db, mcpReg)
			api.RegisterLLMConfigRoutes(r, db, providerRegistry)
			api.RegisterLocalAgentRoutes(r, db)
			api.RegisterMCPRoutes(r, db, mcpReg)
			api.RegisterAgentMCPRoutes(r, db, mcpReg)
			api.RegisterMCPOAuthRoutes(r, rdb, cfg, db, mcpReg)
			api.RegisterSkillRoutes(r, db)
			api.RegisterKBRoutes(r, db, ragRetriever)
			api.RegisterKBAnswerRoutes(r, db, providerRegistry)
			api.RegisterGalleryRoutes(r, db)
			api.RegisterTopologyRoutes(r, db, providerRegistry)
			api.RegisterMediaRoutes(r, db)
			api.RegisterMediaPackRoutes(r, db)
			api.RegisterGeminiMediaRoutes(r, db)
			api.RegisterOpenAIMediaRoutes(r, db)
			api.RegisterMediaOutputRoutes(r, db)
		})
	})

	// ── Start Server ──
	addr := cfg.Server.Addr()
	srv := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	go func() {
		slog.Info("chaya-engine starting", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	// ── Graceful Shutdown ──
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down...")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	slog.Info("bye")
}
