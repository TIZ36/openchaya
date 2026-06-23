# Chaya Engine — Development Rules

## 项目结构

```
chaya-next/
├── chaya-engine/       # Go 后端（核心）
├── chaya-cli/          # Go TUI 终端客户端
├── docker-compose.yml  # PostgreSQL(pgvector) + Redis
└── ~/aiproj/chaya/front/  # 前端（React/Vite，复用旧项目）
```

## 核心原则

1. **前端适配后端，后端不妥协** — 后端 API 保持干净，不加兼容层/别名
2. **后端返回统一格式** — `{code: 0, data: ...}` 或 `{code: N, error: "..."}`
3. **消息全走 WebSocket** — 前端发消息 → WS → Actor → LLM stream → WS push → 前端渲染
4. **SSE 仅保留服务器主动推送**（离线通知等），不用于聊天流
5. **前端所有 fetch 必须用 `authFetch`** — 带 JWT Authorization header
6. **前端解析响应必须解包 `{code, data}`** — 用 `unwrapJson` 或 `api.get()`

## 后端架构

```
Gateway Layer:     WS Hub + HTTP Router + JWT Middleware
Harness Layer:     
  Runtime:         PrimaryAgent → DynamicSupervisor → SubActors
  Capability:      MCP + RAG + Memory + Skill + Media + Code
  Intelligence:    Topology + Router + Persona + DoomLoop + Compaction
Provider Layer:    OpenAI/Anthropic/Gemini/Ollama (ProviderRegistry)
Storage Layer:     PostgreSQL(pgvector) + Redis
```

## API 规范

### 响应格式（Code 枚举）

```go
CodeOK           = 0
CodeBadRequest   = 400
CodeUnauthorized = 401
CodeForbidden    = 403
CodeNotFound     = 404
CodeConflict     = 409
CodeInternal     = 500
CodeInvalidParam = 1001
CodeAlreadyExists= 1002
CodeLLMError     = 1101
CodeMCPError     = 1102
```

### 端点清单

```
Auth（公开）:
  POST /api/auth/register     — 注册 + 自动创建 PrimaryAgent + Conversation
  POST /api/auth/login

以下需 JWT:

Agents:
  GET    /api/agents           — 列表（含 conversation_id 字段）
  GET    /api/agents/{id}
  PUT    /api/agents/{id}
  DELETE /api/agents/{id}      — PrimaryAgent 不可删

Conversations:
  GET    /api/conversations
  POST   /api/conversations
  GET    /api/conversations/{id}  — 也支持 agent ID（自动查绑定的 conversation）
  PUT    /api/conversations/{id}
  DELETE /api/conversations/{id}
  GET    /api/conversations/{id}/messages
  POST   /api/conversations/{id}/messages
  DELETE /api/conversations/{id}/messages/{msgId}

  路由别名（前端用 sessions 命名）:
  GET/POST/PUT/DELETE /api/sessions/...  → 同上

LLM Configs:
  GET    /api/llm-configs
  POST   /api/llm-configs
  GET    /api/llm-configs/{id}
  PUT    /api/llm-configs/{id}
  DELETE /api/llm-configs/{id}
  GET    /api/llm-configs/{id}/api-key
  GET    /api/llm-configs/providers     — 内置 provider 类型列表
  GET    /api/llm/models?provider=X&api_key=X  — 从 provider API 获取模型列表

  路由别名:
  GET/POST/PUT/DELETE /api/llm/configs/...
  GET /api/llm/providers/supported
  GET /api/llm/providers

MCP Servers:
  GET/POST/PUT/DELETE /api/mcp/servers

Skills:
  GET/POST/GET/PUT/DELETE /api/skills

Knowledge Base:
  GET    /api/kb/documents
  POST   /api/kb/documents/upload
  POST   /api/kb/documents/text
  DELETE /api/kb/documents/{id}
  POST   /api/kb/search

Gallery:
  GET/GET/DELETE /api/gallery

Topology:
  GET    /api/agents/{id}/topology
  GET    /api/agents/{id}/topology/traces
  POST   /api/agents/{id}/topology/rebuild

WebSocket:
  GET /ws?token=<jwt>

Health:
  GET /health
```

### WebSocket 协议

```
Client → Server:
  {"type": "subscribe", "topic": "<conv_id>"}
  {"type": "unsubscribe", "topic": "<conv_id>"}
  {"type": "message", "payload": {"conv_id": "...", "content": "..."}}
  {"type": "interrupt", "topic": "<conv_id>"}
  {"type": "ping", "id": "..."}

Server → Client:
  {"type": "event", "topic": "<conv_id>", "payload": {...}}
  {"type": "pong", "id": "..."}

Event payload types:
  agent_thinking      — Agent 开始处理
  agent_stream_chunk  — 流式文本块 {content, chunk, agent_id, message_id}
  agent_stream_done   — 流式完成 {content, agent_id, message_id}
  new_message         — 新消息通知
  agent_deciding      — Agent 决策中
  execution_log       — 执行日志
```

## 数据模型关系

```
User → Tenant (多租户)
User → Agent (1:N, 其中一个 is_primary=true 不可删)
Agent → Conversation (1:1, 通过 conversation_agents 关联)
Conversation → Messages (1:N, conv_id)
Message → MessageParts (1:N)

Agent.id ≠ Conversation.id
前端用 conversation_id 作为 session_id
后端 Agent 响应包含 conversation_id 字段
```

## 前端适配规则

### 字段映射（在前端 normalize 函数中做）

```typescript
// sessionApi.ts normalizeSessionAvatar():
session_id = conversation_id || id    // agent 用 conversation_id
name = name || title                  // conversation 用 title
session_type = session_type || (type === 'primary' ? 'agent' : type)

// llmApi.ts:
config_id = config_id || id           // LLM config 字段映射

// 消息:
message_id = message_id || id
session_id = session_id || conv_id
```

### authFetch 模式

每个 service 文件都有：
```typescript
const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers = { ...(init?.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};
```

### {code, data} 解包

```typescript
const raw = await response.json();
const data = (raw && raw.code === 0 && raw.data) ? raw.data : raw;
```

## 消息流程

```
用户输入 → Workflow.tsx handleSend()
  → topicWsRef.current.send({type:"message", payload:{conv_id, content}})
  → Gateway WS Hub → ActorPool.SendToUser()
  → PrimaryAgent.Mailbox ← envelope
  → streamChat():
    → 存 user message 到 DB
    → Provider.ChatStream()
    → Hub.Publish("agent_thinking")
    → Hub.Publish("agent_stream_chunk") × N
    → 存 assistant message 到 DB  
    → Hub.Publish("agent_stream_done")
  → WS → 前端 setupTopicStream onmessage → 渲染
```

## 启动方式

> PG / Redis / MySQL 已统一到「本地共享基础设施」`~/docker-shared`（name: shared-infra，
> 见其 README）。本项目 **不再自带 pg/redis**；共享实例端口/账号与原来一致，后端配置无需改动。
> PG=shared-postgres(:5432, postgres/postgres, db=chaya)，Redis=shared-redis(:6379, pwd=123456, db=1)。

```bash
cd ~/docker-shared && docker compose up -d         # 共享 PG + Redis(+MySQL)
cd ~/aiproj/chaya-next
docker compose --profile ml up -d                  # 仅本项目专属 ML 向量 sidecar :8100（按需）
cd chaya-engine && ./restart.sh                    # 后端 :3002
cd ~/aiproj/chaya-next/chaya-front && pnpm dev      # 前端 :5177
```

## 技术选型

| 组件 | 选型 |
|------|------|
| HTTP | chi |
| WebSocket | gorilla/websocket |
| ORM | gorm |
| DB | PostgreSQL + pgvector |
| Cache | Redis (go-redis/v9) |
| Config | viper |
| Auth | JWT (golang-jwt/v5) |
| LLM SDK | sashabaranov/go-openai |
| Frontend | React + Vite + TailwindCSS |
