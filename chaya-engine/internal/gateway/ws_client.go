package gateway

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingInterval   = 30 * time.Second
	maxMessageSize = 1 << 20 // 1MB
)

// Client represents a single WebSocket connection (first host / Gateway side).
// ID is the per-connection user session id (login hot path); it is not convid nor agid.
type Client struct {
	ID       string // usersession id: one per WS connection
	TenantID string
	UserID   string
	Device   string // "web", "app", "cli" — one connection per device type per user
	Hub      *Hub
	Conn     *websocket.Conn
	Send     chan []byte
	Subs     map[string]bool

	// Callback for handling incoming messages from this client.
	OnMessage func(client *Client, msg *WSMessage)

	// ConvAccess optional: when set, subscribe is only allowed for conversations the user may access (e.g. tenant + owner).
	ConvAccess func(userID, tenantID, convID string) bool
}

func NewClient(hub *Hub, conn *websocket.Conn, tenantID, userID, device string) *Client {
	if device == "" {
		device = "web"
	}
	return &Client{
		ID:       uuid.New().String(),
		TenantID: tenantID,
		UserID:   userID,
		Device:   device,
		Hub:      hub,
		Conn:     conn,
		Send:     make(chan []byte, 256),
		Subs:     make(map[string]bool),
	}
}

// ReadPump reads messages from the WebSocket connection.
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, raw, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Warn("ws read error", "id", c.ID, "err", err)
			}
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			slog.Warn("ws unmarshal error", "id", c.ID, "err", err)
			continue
		}

		switch msg.Type {
		case "ping":
			c.sendJSON(&WSMessage{Type: "pong", ID: msg.ID})
		case "subscribe":
			if msg.Topic != "" && c.ConvAccess != nil && !c.ConvAccess(c.UserID, c.TenantID, msg.Topic) {
				slog.Warn("ws subscribe denied", "user", c.UserID, "topic", msg.Topic)
				break
			}
			c.Hub.Subscribe(c.ID, msg.Topic)
		case "unsubscribe":
			c.Hub.Unsubscribe(c.ID, msg.Topic)
		default:
			if c.OnMessage != nil {
				c.OnMessage(c, &msg)
			}
		}
	}
}

// WritePump writes messages to the WebSocket connection.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendJSON(msg *WSMessage) {
	raw, _ := json.Marshal(msg)
	select {
	case c.Send <- raw:
	default:
	}
}
