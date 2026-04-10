package gateway

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// WSMessage is the envelope for all WebSocket communication.
type WSMessage struct {
	Type    string          `json:"type"`    // subscribe, unsubscribe, message, event, ping, pong
	Topic   string          `json:"topic"`   // subscribe/unsubscribe: convid (conversation id), not usersession id
	Payload json.RawMessage `json:"payload"`
	ID      string          `json:"id"`      // for request-response correlation
}

// TopicMessage wraps a message to broadcast to a topic's subscribers.
type TopicMessage struct {
	Topic   string
	Message []byte
}

// Hub manages all WebSocket clients and topic subscriptions.
// Each user may have at most one connection per device type (web/app/cli).
type Hub struct {
	clients     map[string]*Client                      // clientID → client
	topics      map[string]map[string]*Client            // topicID → {clientID → client}
	userDevices map[string]map[string]*Client             // userID → {device → client}
	mu          sync.RWMutex
	broadcast   chan *TopicMessage
	register    chan *Client
	unregister  chan *Client
}

func NewHub() *Hub {
	return &Hub{
		clients:     make(map[string]*Client),
		topics:      make(map[string]map[string]*Client),
		userDevices: make(map[string]map[string]*Client),
		broadcast:   make(chan *TopicMessage, 256),
		register:    make(chan *Client),
		unregister:  make(chan *Client),
	}
}

// Run starts the hub event loop. Call in a goroutine.
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ID] = client

			// Enforce one connection per user per device type.
			if h.userDevices[client.UserID] == nil {
				h.userDevices[client.UserID] = make(map[string]*Client)
			}
			if old, exists := h.userDevices[client.UserID][client.Device]; exists && old.ID != client.ID {
				// Notify the old connection before kicking it.
				kickMsg, _ := json.Marshal(&WSMessage{
					Type:  "event",
					Payload: mustMarshal(map[string]any{
						"type":   "session_replaced",
						"device": client.Device,
					}),
				})
				select {
				case old.Send <- kickMsg:
				default:
				}
				// Remove old client from all maps and close its channel.
				delete(h.clients, old.ID)
				for topic, subs := range h.topics {
					delete(subs, old.ID)
					if len(subs) == 0 {
						delete(h.topics, topic)
					}
				}
				close(old.Send)
				old.Conn.Close()
				slog.Info("ws kicked old connection", "old_id", old.ID, "user", client.UserID, "device", client.Device)
			}
			h.userDevices[client.UserID][client.Device] = client

			h.mu.Unlock()
			slog.Info("ws client registered", "id", client.ID, "user", client.UserID, "device", client.Device)

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.ID]; ok {
				delete(h.clients, client.ID)
				// Clean up userDevices index (only if this client is still the active one for that device slot).
				if devs, ok := h.userDevices[client.UserID]; ok {
					if cur, ok := devs[client.Device]; ok && cur.ID == client.ID {
						delete(devs, client.Device)
					}
					if len(devs) == 0 {
						delete(h.userDevices, client.UserID)
					}
				}
				// Remove from all topics
				for topic, subs := range h.topics {
					delete(subs, client.ID)
					if len(subs) == 0 {
						delete(h.topics, topic)
					}
				}
				close(client.Send)
			}
			h.mu.Unlock()
			slog.Info("ws client unregistered", "id", client.ID, "device", client.Device)

		case msg := <-h.broadcast:
			h.mu.RLock()
			if subs, ok := h.topics[msg.Topic]; ok {
				for _, client := range subs {
					select {
					case client.Send <- msg.Message:
					default:
						// Client send buffer full, skip
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

// Subscribe adds a client to a topic.
func (h *Hub) Subscribe(clientID, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	client, ok := h.clients[clientID]
	if !ok {
		return
	}
	if h.topics[topic] == nil {
		h.topics[topic] = make(map[string]*Client)
	}
	h.topics[topic][clientID] = client
	client.Subs[topic] = true
}

// Unsubscribe removes a client from a topic.
func (h *Hub) Unsubscribe(clientID, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if subs, ok := h.topics[topic]; ok {
		delete(subs, clientID)
		if len(subs) == 0 {
			delete(h.topics, topic)
		}
	}
	if client, ok := h.clients[clientID]; ok {
		delete(client.Subs, topic)
	}
}

// Publish sends a message to all subscribers of a topic.
func (h *Hub) Publish(topic string, data any) {
	raw, err := json.Marshal(&WSMessage{
		Type:    "event",
		Topic:   topic,
		Payload: mustMarshal(data),
	})
	if err != nil {
		slog.Error("ws publish marshal error", "err", err)
		return
	}

	h.broadcast <- &TopicMessage{Topic: topic, Message: raw}
}

// SendTo sends a message directly to a specific client.
func (h *Hub) SendTo(clientID string, msg *WSMessage) {
	h.mu.RLock()
	client, ok := h.clients[clientID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	raw, _ := json.Marshal(msg)
	select {
	case client.Send <- raw:
	default:
	}
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
