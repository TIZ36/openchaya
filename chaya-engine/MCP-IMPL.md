# Chaya MCP — 实现笔记

记录 MCP（Model Context Protocol）能力在 Chaya 里的完整实现：架构分层、数据模型、协议流程、踩过的坑。

## 一句话总结

MCP server 是个**租户级**资源（tenant 内共享配置），通过 **agent ↔ server 多对多绑定**进入某只 agent 的工具范围。OAuth token 是**用户级**的（每用户一份）。运行时由 `harness/capability/mcp/registry.go` 统一管理连接 + 工具发现 + cooldown，actor 只调用 `ListToolsForAgent` 拿工具列表。

---

## 1. 数据模型

### `mcp_servers` 表
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | 租户隔离 |
| `name` | text | 显示名 |
| `url` | text | 端点（HTTP/SSE 是 URL；stdio 用 command 顶位） |
| `type` | text | `http` / `sse` / `stdio` |
| `config` | jsonb | command/args/env/headers 都进这里 |
| `enabled` | bool | 总开关 |
| `healthy` | bool | 探测结果（probe 后写） |
| `created_at` | timestamptz | |

### `agent_mcp_servers` 表（多对多）
| 字段 | 说明 |
|---|---|
| `agent_id` (PK) | 哪只 agent |
| `mcp_server_id` (PK) | 绑哪个 server |
| `created_at` | |

绑定后该 server 进入这只 agent 的工具范围。无绑定 = agent 看不到。

### Redis Keys（OAuth）
- `mcp:oauth:state:<state>` — TTL 15 分钟，PKCE verifier + token_endpoint + client_id + mcp_url + tenant_id + user_id + redirect_uri
- `mcp:oauth:token:<tenant>:<user>:<mcp_url>` — TTL 90 天，access_token + token_type + refresh_token + expires_at

---

## 2. 后端分层

```
internal/api/mcp.go              ── REST: /api/mcp/servers CRUD + /probe
internal/api/agent_mcp.go        ── REST: 绑定 /api/agents/{id}/mcp-servers
internal/api/mcp_oauth.go        ── REST: discover/authorize/callback/token-status
internal/api/mcp_proxy.go        ── 浏览器直连 MCP 的 CORS 代理（带 JWT → token 注入）

internal/harness/capability/mcp/
  registry.go    ── 连接池 + cooldown + 工具发现总入口
  client.go      ── HTTP/SSE 客户端：Initialize / ListTools / CallTool
  client_sse.go  ── SSE-specific 帧解析
  descriptions.go── 工具 description 增强（命名规范化）
  localhost_rewrite.go ── stdio MCP 用 localhost 桥转
```

### Registry 关键状态

```go
type Registry struct {
    clients      map[string]*Client          // 无 OAuth 直连客户端
    oauthMetas   map[string]*oauthServerMeta // OAuth 服务器元数据，按需 per-user 拿 client
    cache        map[string]*cachedTools     // 工具列表缓存（每个 server 一份）
    cooldown     map[string]time.Time        // 失败 5 分钟惩罚，key = serverID 或 serverID:userID
}
```

**`clients` 与 `oauthMetas` 互斥**：一个 server 要么走匿名 client（startup 时连），要么走 per-user OAuth client（每 request 临时建）。同一时刻只在一个 map 里。

### Client（`client.go`）

实现 MCP streamable-HTTP 协议（JSON-RPC 2.0 over HTTP/SSE）：
- `Initialize` — 协议握手，拿到 server capabilities
- `ListTools` / `ListToolsWithHeaders` — `tools/list`
- `CallTool` / `CallToolWithHeaders` — `tools/call`

`WithHeaders` 变体用于 OAuth：调用时把 `Authorization: Bearer <token>` 注入。

---

## 3. API 端点清单

```
# 服务器 CRUD（租户级，需 JWT）
GET    /api/mcp/servers
POST   /api/mcp/servers              body: {name, url, type, command?, args?, env?, headers?}
PUT    /api/mcp/servers/{id}
DELETE /api/mcp/servers/{id}
POST   /api/mcp/servers/{id}/probe   → {ok, tool_count, tools[], error?}

# 绑定（agent 级，需 JWT）
GET    /api/agents/{agentId}/mcp-servers
POST   /api/agents/{agentId}/mcp-servers   body: {mcp_server_id}
DELETE /api/agents/{agentId}/mcp-servers/{mcpId}

# OAuth（需 JWT）
POST   /api/mcp/oauth/discover       body: {mcp_url}  → 嵌套结构（见下文）
POST   /api/mcp/oauth/authorize      body: {authorization_endpoint, token_endpoint, registration_endpoint?, mcp_url, ...}
GET    /api/mcp/oauth/token-status?mcp_url=...

# OAuth 回调（公开，无 JWT，浏览器直跳）
GET    /mcp/oauth/callback?code=...&state=...
POST   /mcp/oauth/callback
```

---

## 4. OAuth 完整流程

按 RFC 9728（Protected Resource Metadata）+ RFC 8414（AS Metadata）+ RFC 7636（PKCE）实现。

### 时序

```
[Browser]            [Chaya 后端]                [MCP Server]            [Auth Server / IdP]
   │                      │                          │                          │
   │ 1. POST /discover    │                          │                          │
   ├─────────────────────►│                          │                          │
   │                      │  GET /.well-known/oauth-protected-resource          │
   │                      ├─────────────────────────►│                          │
   │                      │  ← {authorization_servers: [...]}                   │
   │                      │                          │                          │
   │                      │  GET <as>/.well-known/oauth-authorization-server    │
   │                      ├─────────────────────────────────────────────────────►│
   │                      │  ← {authorization_endpoint, token_endpoint, ...}    │
   │  ← 嵌套 metadata     │                          │                          │
   │                      │                          │                          │
   │ 2. POST /authorize   │                          │                          │
   ├─────────────────────►│                          │                          │
   │                      │  POST <registration_endpoint> (动态注册)            │
   │                      ├─────────────────────────────────────────────────────►│
   │                      │  ← {client_id, ...}                                 │
   │                      │                          │                          │
   │                      │ ─ 生成 PKCE pair ─       │                          │
   │                      │ ─ 写 Redis state ─       │                          │
   │  ← {authorization_url}                          │                          │
   │                      │                          │                          │
   │ 3. window.open(authorization_url)               │                          │
   ├─────────────────────────────────────────────────────────────────────────────►│
   │                      │                          │     用户登录 + 同意      │
   │  ← 302 redirect_uri = http://localhost:3002/mcp/oauth/callback?code=&state= │
   │                      │                          │                          │
   │ 4. GET /mcp/oauth/callback?code=&state=                                    │
   ├─────────────────────►│                          │                          │
   │                      │  ─ 读 Redis state ─       │                          │
   │                      │  POST <token_endpoint>   │                          │
   │                      ├─────────────────────────────────────────────────────►│
   │                      │     grant=authorization_code, code_verifier, ...    │
   │                      │  ← {access_token, refresh_token, expires_in}        │
   │                      │  ─ 写 Redis token ─       │                          │
   │                      │  ─ ClearAuthCooldown ─   │                          │
   │                      │  ─ EnsureClient (重连) ─  │                          │
   │  ← HTML "授权成功"   │                          │                          │
   │                      │                          │                          │
   │ 5. 前端 polling: GET /token-status?mcp_url=...                             │
   ├─────────────────────►│                          │                          │
   │  ← {has_token: true} │                          │                          │
   │ 弹窗自动关 + chip 变「已授权」                                             │
```

### 后端 `discover` 返回的嵌套结构

```json
{
  "protected_resource": {
    "resource": "https://...",
    "authorization_servers": ["https://..."],
    "bearer_methods_supported": ["header"]
  },
  "authorization_server": {
    "issuer": "https://...",
    "authorization_endpoint": "https://.../authorize",
    "token_endpoint": "https://.../token",
    "registration_endpoint": "https://.../register",
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]
  },
  "resource": "https://..."
}
```

**前端必须 flatten** 才能传给 `/authorize`（它要扁平字段）。`integrationsApi.ts:flattenDiscovery()` 干这事。

### Discovery 多 URL 探测策略

`discoverOAuthMetadata` 按顺序试：
1. `<mcp_url>/.well-known/oauth-protected-resource` — base 拼后缀
2. `<scheme>://<host>/.well-known/oauth-protected-resource` — 主机根

`fetchAuthorizationServerMetadata` 类似多候选：
1. 从 `protected_resource.issuer` 拼主机根
2. `authorization_servers[0]` 主机根
3. `authorization_servers[0]` 自身 + `/.well-known/...`

设计原因：飞书项目 MCP 在 `https://host/b/auth/mcp` 列 AS，但元数据只发在主机根；不能盯着 AS URL 拼后缀。

### 动态注册细节

`dynamicRegisterClient` 默认请求：
```json
{
  "client_name": "Chaya MCP",
  "redirect_uris": ["http://<public_url>/mcp/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

`token_endpoint_auth_method: "none"` = **public client + 仅 PKCE 验证**。即使服务器 metadata 声明 `token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"]`，实测多数实现接受 `"none"` 注册并签发 public client（不返回 client_secret）。Token exchange 时不带 secret，靠 `code_verifier` 验证。

---

## 5. Cooldown 机制（最大的坑）

### 设计意图

OAuth 失败 ≠ 网络错。多数情况是**用户没授权 / token 过期 / 权限不足**。每次 chat turn 都重试会：
1. 给用户刷 N 条「请授权」错误
2. 拖慢工具收集（每次都等 OAuth 失败的超时）
3. 给 OAuth server 打 DDoS

所以失败后 5 分钟黑名单（`oauthCooldown = 5 * time.Minute`），中间所有 probe / `ListTools` 静默跳过。

### Cooldown key 双形态

```go
// 全局失败（服务器死了，不是单个用户的问题）
cooldownKey = serverID

// 单个用户失败（用户没授权，别人没影响）
cooldownKey = serverID + ":" + userID
```

OAuth 客户端失败用后者；非 OAuth 客户端失败用前者。

### `ClearAuthCooldown` —— 之前的 bug

函数定义了，但**全代码库没人调**。后果：

> 用户加了个 MCP server → 立刻点「测连接」（此时未授权）→ OAuth 路径失败 → 进 5 分钟 cooldown → 用户跑去授权完成 → token 写入 Redis → **用户再点测连接，仍然 0 个工具**（cooldown 还在）

修：在 `exchangeOAuthCode` token 写完之后，立即：
1. 按 `tenant_id + url` 查 server 行
2. `mcpReg.ClearAuthCooldown(s.ID, userID)` —— 清 `serverID:userID` + `serverID` 双 key
3. `mcpReg.EnsureClient(...)` 异步重连，下次 probe 直接命中

```go
// internal/api/mcp_oauth.go：exchangeOAuthCode 末尾
if a.db != nil && a.mcpReg != nil {
    var s pgstore.MCPServer
    if err := a.db.Where("tenant_id = ? AND url = ?", tenantID, mcpURL).First(&s).Error; err == nil {
        a.mcpReg.ClearAuthCooldown(s.ID, userID)
        go a.mcpReg.EnsureClient(context.Background(), mcp.ServerConfig{...})
    }
}
```

**经验**：写带「副作用清理」的 API 时，**同一 commit 把调用点也连上**，否则函数会在代码里腐烂。Reviewer 看到独立函数无引用要警惕（`grep -r ClearAuthCooldown` 是 5 秒就能做的检查）。

---

## 6. Probe 端点（`/api/mcp/servers/{id}/probe`）

```go
POST /api/mcp/servers/{id}/probe
→ {ok: bool, tool_count: int, tools: string[], error?: string}
```

实现要点：
- 先 `EnsureClient` —— 防止「刚 create 后立刻 probe」抢在 autoConnect goroutine 前
- 调 `ListToolsForServerIDsWithProgress` 限定单 server，5s 超时
- 返回前**写回 `healthy` 字段**到 DB，让列表 UI 下次拉到准确状态

为什么不主动定时探活：MCP server 多数是远程 HTTP，主动探活 = 持续给所有租户的 N 个服务器打请求。按需探活 + cache（5 分钟）就够。

---

## 7. 多租户 + 多用户隔离

| 资源 | 隔离粒度 |
|---|---|
| `mcp_servers` 配置 | 按 `tenant_id` |
| `agent_mcp_servers` 绑定 | 按 agent（agent 隶属于 user） |
| OAuth token | 按 `tenant_id + user_id + mcp_url` |
| Cooldown key | 按 `serverID + userID`（OAuth 路径）或 `serverID`（匿名路径） |
| 工具列表 cache | 按 `serverID`（匿名）/ 按 OAuth client 实例（per-request） |

**陷阱**：tools cache 是按 `serverID` 而不是 `serverID + userID`。OAuth server 因为每用户的 token 可能授权范围不同，理论上工具列表也可能不同。当前实现假设「同一 server 不同用户看到的工具相同」—— 对绝大多数 MCP server 成立，但**带 scope 选择的 server 会出错**。修起来要把 cache key 加上 userID。

---

## 8. 前端集成

```
src/services/integrationsApi.ts    ── mcpApi + skillsApi + oauthApi
src/components/IntegrationsPage.tsx── /integrations 章节，MCP / Skill 双 tab
src/components/PersonaPage.tsx     ── agent 详情页里的「挂的工具」section + BindPicker 模态
```

### `flattenDiscovery` 必须做

```ts
function flattenDiscovery(raw: any): OAuthMetadata {
  const as = raw.authorization_server || {};
  return {
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
    // ...
  };
}
```

否则前端读 `meta.authorization_endpoint` 永远 undefined → 走「不需要 OAuth」分支静默退出 → 看起来「discover 200 但没下文」。

### Polling 策略

```
打开 popup → 1.5s 间隔 GET /token-status?mcp_url=...
  ├─ has_token=true → 关 popup，chip 变「已授权」，触发 onProbed() 重拉列表
  ├─ popup.closed → 用户取消，停 polling
  └─ 超过 3 分钟 → 超时
```

不用 `window.postMessage`：callback 是 server-side 渲染的纯 HTML 页（不是 SPA），无法 postMessage 回 opener。

### stdio server 跳过 OAuth UI

```ts
const oauthEligible = sv.type !== 'stdio';
```

stdio = 子进程，本地认证（env / args 传 token），不需要浏览器 OAuth。

---

## 9. 踩过的坑（汇总）

| 坑 | 表现 | 根因 | 修法 |
|---|---|---|---|
| `ClearAuthCooldown` 没人调 | 授权完后 probe 仍 0 工具 | 函数定义后没接通 | 在 `exchangeOAuthCode` 末尾调 |
| Discover 嵌套 vs 扁平 | 前端「discover 200 但没下一步」 | 后端返 `{authorization_server: {...}}`，前端读 `.authorization_endpoint` | 前端 `flattenDiscovery` |
| `token_endpoint_auth_method=none` 不在支持列表 | 担心注册失败 | 多数实现宽松接受，发 public client | 默认就 none，PKCE 顶 |
| OAuth metadata 路径多变 | 飞书等服务 metadata 在主机根但 AS URL 在子路径 | RFC 没强制 metadata 位置 | 多 URL 候选回退 |
| Probe 列出 0 个工具 | 服务器返 `[]` | 不是错，但用户以为坏了 | UI 区分「连不上」vs「0 个工具」 |
| 缓存按 server 不按 user | 不同 user 看同样工具 | scope-aware server 会错 | 暂时不修；记录在「已知限制」 |
| WS 鉴权 token 进 URL | JWT 进 nginx access log | `?token=` 是字符串 query | 已改用 `Sec-WebSocket-Protocol: bearer, <jwt>` |
| Tool 第二轮 LLM 调用 400 | `reasoning_content must be passed back` | 接了 reasoning **入方向**，没接**出方向**——sub_actor append assistant message 时丢 reasoning | `provider.Message` + `ChatResponse` 加 `Reasoning` 字段；`openaiToOAIMessages` 装回 `ReasoningContent`；sub_actor tool loop append 带 `Reasoning: resp.Reasoning` |

### 关于 reasoning 双向流的额外说明

DeepSeek-Reasoner / Qwen-thinking / o1 系列模型用 `reasoning_content` 字段输出「思考」，**协议强制**要求多轮对话里上一轮的 reasoning_content 在下一轮请求里原样回传。如果只做了 provider→UI 单向展示（chunks 进 `agent_reasoning_chunk` 事件），多轮 tool call 一定 400。

**双向打通的检查清单**：
1. 入方向：流式 `delta.reasoning_content` 和非流式 `message.reasoning_content` 都要解析进 `StreamChunk.Reasoning` / `ChatResponse.Reasoning`
2. 出方向：构造 `oai.ChatCompletionMessage` 时填 `ReasoningContent: m.Reasoning`
3. Sub_actor tool loop：append 上一轮 assistant 消息时带 `Reasoning: resp.Reasoning`
4. Actor in-memory history：append assistant 消息时也带 reasoning（跨用户 turn 的 round-trip）
5. 持久化：`message.ext.reasoning` 已写入；如果重启 actor 后从 DB 重建 history，要把这个字段也填进 `provider.Message.Reasoning`（**当前未实现** —— 重启后第一次 tool call 会丢）

**经验**：接外部协议字段时**永远问一遍：这字段是单向还是双向？** 单向（如 token usage）只读就行，双向（reasoning_content / refusal / function_call_id）必须出入都接，否则 N 轮之后炸。

---

## 10. 端到端测试清单

新接 MCP server 时手动验：

1. **加服务器**：`POST /api/mcp/servers` 返回 200 + 有 id
2. **autoConnect 触发**：日志看到 `mcp ensure client` 或 `oauth server registered`
3. **未授权状态**：列表 UI 出现「未授权」chip（只对 http/sse server）
4. **授权流程**：
   - 点「授权」→ 弹窗 → 显示 IdP 登录页（不是 404 不是空白）
   - 登完弹窗自动关
   - chip 变「已授权」
5. **测连接**：返回 `{ok: true, tool_count > 0, tools: [...]}`
6. **绑定 agent**：到 PersonaPage「挂的工具」点 + 挂 → 出现 chip
7. **chat 时调用**：发条会触发工具的消息，看后端日志 `调用工具 <name>`
8. **解绑**：chip 上点 ✕ → 立即解绑，下次 chat 不再有该工具

任意一步失败 → 看日志关键词：
- `oauth-protected-resource` 没找到 → discovery 失败
- `registration` 失败 → 动态注册被拒（看返回 status + body）
- `token exchange failed` → callback 拿到 code 但换不到 token
- `mcp oauth client failed — cooldown 5m` → 5 分钟黑名单生效中
- `tools collected count=0 servers=0 oauth_servers=1` → OAuth 路径走了但没拉到工具（看上一行）
