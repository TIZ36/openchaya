# Chaya Engine API Reference

## Authentication

All protected endpoints require `Authorization: Bearer <token>` header.
WebSocket uses `?token=<token>` query parameter.

### POST /api/auth/register
Create account + default tenant + PrimaryAgent.
```json
// Request
{"email": "user@example.com", "name": "Alice", "password": "secret"}

// Response 201
{"token": "jwt...", "user": {"id": "uuid", "email": "...", "name": "..."}}
```

### POST /api/auth/login
```json
// Request
{"email": "user@example.com", "password": "secret"}

// Response 200
{"token": "jwt...", "user": {"id": "uuid", "email": "...", "name": "..."}}
```

---

## Conversations

### GET /api/conversations
List current user's conversations.
```json
// Response 200
[{"id": "uuid", "title": "...", "type": "private", "created_at": "..."}]
```

### POST /api/conversations
```json
// Request
{"title": "New Chat", "type": "private"}

// Response 201
{"id": "uuid", "title": "New Chat", "type": "private", ...}
```

### GET /api/conversations/{id}
### DELETE /api/conversations/{id}

### GET /api/conversations/{id}/messages
```json
// Response 200
[{
  "id": "uuid",
  "role": "user",
  "content": "Hello",
  "source": "direct",
  "created_at": "...",
  "parts": [{"id": "uuid", "type": "text", "state": "completed", "data": {"text": "Hello"}}]
}]
```

---

## Agents

### GET /api/agents
List current user's agents (PrimaryAgent first).
```json
// Response 200
[{"id": "uuid", "type": "primary", "name": "Chaya", "is_primary": true, "config": {...}}]
```

### GET /api/agents/{id}
### PUT /api/agents/{id}
Update agent config (name, system_prompt, persona, permissions).
PrimaryAgent: only non-core fields changeable.
```json
// Request
{"name": "My Chaya", "config": {"system_prompt": "..."}}
```

### DELETE /api/agents/{id}
Delete agent. Returns 403 for PrimaryAgent.

---

## LLM Configs

### GET /api/llm-configs
List tenant's LLM configurations.

### POST /api/llm-configs
```json
// Request
{
  "tenant_id": "uuid",
  "provider": "openai",
  "model": "gpt-4o",
  "api_key": "sk-...",
  "api_url": "",
  "enabled": true
}
```

### PUT /api/llm-configs/{id}
### DELETE /api/llm-configs/{id}

---

## WebSocket Protocol

### Connect
```
ws://localhost:3001/ws?token=<jwt>
```

### Client → Server Messages

#### Subscribe to conversation
```json
{"type": "subscribe", "topic": "conv_uuid"}
```

#### Unsubscribe
```json
{"type": "unsubscribe", "topic": "conv_uuid"}
```

#### Send chat message
```json
{
  "type": "message",
  "payload": {
    "content": "Hello, help me with...",
    "conv_id": "conv_uuid"
  }
}
```

#### Interrupt generation
```json
{"type": "interrupt", "topic": "conv_uuid"}
```

#### Ping
```json
{"type": "ping", "id": "req_1"}
```

### Server → Client Events

All events are wrapped in:
```json
{"type": "event", "topic": "conv_uuid", "payload": {...}}
```

#### stream_start
Agent begins generating response.
```json
{"type": "stream_start", "agent_id": "uuid", "message_id": "uuid"}
```

#### stream_chunk
Streaming text chunk.
```json
{
  "type": "stream_chunk",
  "agent_id": "uuid",
  "message_id": "uuid",
  "chunk": "Hello",
  "accumulated": "Hello, I can help"
}
```

#### stream_done
Generation complete.
```json
{
  "type": "stream_done",
  "agent_id": "uuid",
  "message_id": "uuid",
  "content": "full response text",
  "time": 1712345678
}
```

#### stream_error
```json
{"type": "stream_error", "agent_id": "uuid", "message_id": "uuid", "error": "..."}
```

#### agent_delegating
PrimaryAgent is delegating to a SubAgent.
```json
{"type": "agent_delegating", "agent_id": "uuid", "message": "Analyzing your request..."}
```

#### pong
Response to ping.
```json
{"type": "pong", "id": "req_1"}
```

---

## Architecture: Message Flow

```
User sends message via WS
  ↓
ActorPool.SendToUser(userID, envelope)
  ↓
Supervisor.primary.Mailbox ← envelope
  ↓
PrimaryAgent.handleChat()
  ├─ classifyIntent() → "simple_chat"
  │   └─ streamChat() → direct LLM response to user
  │
  └─ classifyIntent() → "need_delegate"
      ├─ supervisor.EnsureSubActor("general")
      ├─ send Task envelope to SubAgent
      ├─ SubAgent.handleTask() → LLM call → result
      ├─ supervisor.DeliverResult(taskID, result)
      └─ PrimaryAgent.summarizeAndStream() → final response to user
```

## Envelope Protocol (Internal)

Three-layer communication between actors:

| Layer | Type | LLM Cost | Examples |
|-------|------|----------|---------|
| Control | structured | 0 token | ping, interrupt, park, resume |
| Logic | JSON Data | 0 token | tool_call, tool_result, rag_query, mem_read |
| Semantic | Body string | ~tokens | chat, task, result, question, notify |

---

## Health

### GET /health
```json
{"status": "ok"}
```
