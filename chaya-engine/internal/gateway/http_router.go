package gateway

import (
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/gorilla/websocket"
)

// parseJWTClaims does a quick decode without verification (WS upgrade only).
// Full verification happens in the middleware for HTTP routes.
func parseJWTClaims(tokenStr string) map[string]any {
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	return claims
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true }, // TODO: restrict in production
}

// RegisterRoutes is a hook for main to mount API routes after the router is created.
type RouteRegistrar func(r chi.Router)

// NewRouter creates the HTTP router with WS upgrade and REST endpoints.
// convAccess, when non-nil, restricts WS subscribe to conversations the user may access.
func NewRouter(hub *Hub, onWSMessage func(*Client, *WSMessage), convAccess func(userID, tenantID, convID string) bool, registrars ...RouteRegistrar) *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	}))

	// WebSocket upgrade (token passed as query param since WS doesn't support headers)
	r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Error("ws upgrade failed", "err", err)
			return
		}

		// Extract user info from JWT token in query param
		userID := r.URL.Query().Get("user_id")
		tenantID := r.URL.Query().Get("tenant_id")
		if token := r.URL.Query().Get("token"); token != "" {
			if claims := parseJWTClaims(token); claims != nil {
				if uid, ok := claims["user_id"].(string); ok {
					userID = uid
				}
				if tid, ok := claims["tenant_id"].(string); ok {
					tenantID = tid
				}
			}
		}

		device := r.URL.Query().Get("device")
		client := NewClient(hub, conn, tenantID, userID, device)
		client.OnMessage = onWSMessage
		client.ConvAccess = convAccess

		hub.register <- client

		// First frame after connect: bind usersession id (WS connection identity on Gateway).
		// Distinct from convid (topic) and agid; see usersession-agid-convid rule.
		welcome, _ := json.Marshal(&WSMessage{
			Type:  "event",
			Topic: "",
			Payload: mustMarshal(map[string]any{
				"type":           "usersession_ready",
				"usersession_id": client.ID,
			}),
		})
		select {
		case client.Send <- welcome:
		default:
		}

		go client.WritePump()
		go client.ReadPump()
	})

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Mount API routes
	for _, reg := range registrars {
		reg(r)
	}

	return r
}
