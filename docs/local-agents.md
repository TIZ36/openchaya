# 本地 Agent 多 Provider 接入设计

> 桌面版（Electron）在对话框里直接驱动用户机器上已装的 CLI Agent。纯本地执行，
> 仅「凭据」走后端存储。Claude Code 已端到端打通；本文档规划 **cursor → codex → gemini** 的接入。

## 现状（claude）

- 渲染层 `useLocalAgent.ts` + `LocalAgentView.tsx`，主进程 `electron/localAgent.cjs`。
- claude 走 `@anthropic-ai/claude-agent-sdk` 的常驻 `query()`：streaming-input、`canUseTool` 逐工具权限暂停、`setModel`/`setPermissionMode`/`interrupt`、`supportedModels()`、`resume`。
- 历史读 `~/.claude/projects/<enc(cwd)>/<sessionId>.jsonl`。
- 事件经 `ipcRenderer` `localAgent:event` 按 `cwd` 路由回标签。

**关键契约**：渲染层 `handleEvent` 吃的是 **SDK 形状**的事件：
`{type:'system',subtype:'init',session_id,mcp_servers}`、
`{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}}`、
`{type:'assistant'|'user',message:{content:[{type:'text'|'thinking'|'tool_use'|'tool_result',...}]}}`、
`{type:'result',session_id,subtype}`、`{type:'error',error}`、`{type:'session_closed'}`。
**任何新 provider 的 driver 必须把自家事件翻译成这套形状**，渲染层零改动。

## Provider 能力矩阵

| | claude（已做） | cursor（1） | codex（2） | gemini（3） |
|---|---|---|---|---|
| 实时传输 | Agent SDK | `-p --output-format stream-json --stream-partial-output` | `codex exec --json` | `-o stream-json` |
| 续接 | SDK resume | `--resume <agentId>` | `codex exec resume <id>` / `--last` | `--resume latest\|<index>` |
| 列会话 | 读 JSONL | 读 `store.db` | 读 rollout JSONL | CLI `--list-sessions` |
| 历史落盘 | `~/.claude/projects/<enc(cwd)>/*.jsonl` | `~/.cursor/chats/<md5(cwd)>/<uuid>/store.db` | `~/.codex/sessions/Y/M/D/rollout-*.jsonl`（cwd 在 session_meta） | `~/.gemini/...`（优先用 CLI flag，免解析） |
| 鉴权 | 复用登录 | **必须 API Key**（headless） | ChatGPT 登录 / `OPENAI_API_KEY` | Google 登录 / `GEMINI_API_KEY` |
| 权限档 | 逐工具 canUseTool | plan / ask / force | full-auto / sandbox / bypass | `--approval-mode default\|auto_edit\|yolo` |
| 模型列表 | `supportedModels()` | `cursor-agent models` | config.toml | `-m` 任意 |

**洞察**：只有 cursor 强制要 API Key；codex/gemini 能复用本机登录态。没有任一能复刻 claude 的逐工具权限暂停 → 统一为 plan/ask/force 三档。

## 统一抽象

claude 保持 SDK 特例。其余 provider 走同一个 spawn + 逐行 JSON 框架，各写一个 driver：

```
LocalProviderDriver:
  spec:        { id, label, bin, live, needsApiKey, permModes[] }
  spawnArgs(opts):           → 命令行参数（model / resume / permMode / cwd）
  normalizeEvent(rawJson):   → SDK 形状事件（见上「关键契约」）
  listSessions(cwd):         → SessionSummary[]
  readSession(cwd, id):      → TranscriptMessage[]
  models():                  → ModelInfo[]
```

渲染层 `MsgPart` / 权限三档 / 模型选择器全复用；`PERM_META` 按 provider 给不同档位集合。

## cursor 落盘结构（已逆向验证）

```
~/.cursor/chats/<md5(workspace_path)>/<agent-uuid>/store.db   (SQLite)
  meta 表:  value = hex(JSON) → {agentId, name(标题), mode, createdAt, latestRootBlobId}
  blobs 表: (id=内容哈希, data)
    ├ 根 blob   = protobuf: field1=有序子blob哈希(=消息顺序), field5=token, field9=workspace URI, field18=上下文文件
    └ 消息 blob = 纯 JSON: {role, content, id}   ← Vercel AI SDK 格式
```

- cwd→目录 **O(1)**：`<hash> = md5(cwd)`（裸路径，非 file:// 前缀）。同 workspace 下多个 `<agent-uuid>/` = 多个会话。
- 消息 `role`: system/user/assistant/tool；`content`: string 或 part 数组，`type` ∈ text/tool-call/tool-result(/reasoning)。
- 映射 → MsgPart：text→text、tool-call→tool_use、tool-result→tool_result、reasoning→thinking。
- 读历史 = SQLite 读 + ~20 行 protobuf field-1 游走（取根 blob 所有 len==32 的 field-1 值）+ 每条 `JSON.parse`。
- 脆弱点：根 blob 是未公开 protobuf，field 编号可能随版本漂 → 防御性「取所有 len==32 的 field-1 值」，不依赖其他 field。

## 后端凭据（方案 B：独立表 + 端点）

`LLMConfig.api_key` 是 PG 明文（无加密层），安全靠 JWT + 列表 mask + 单独取明文端点。本地 Agent 凭据沿用此安全档，但**独立成表**（语义：本机 CLI 凭据 ≠ 后端 LLM provider，不污染模型选择列表）。

- 模型 `LocalAgentCredential`：`{id, user_id, tenant_id, provider, api_key, created_at, updated_at}`，`uniqueIndex(user_id, provider)`。**按用户**作用域。
- 端点（JWT 后）：
  - `GET    /api/local-agent/credentials` — 列表（key 打码）
  - `PUT    /api/local-agent/credentials/{provider}` — upsert `{api_key}`
  - `DELETE /api/local-agent/credentials/{provider}`
  - `GET    /api/local-agent/credentials/{provider}/api-key` — 取明文（driver 起进程时用）
- 取 key 流：渲染层（持 JWT）`authFetch` 拉明文 → 随 `send`/`warm` payload 传给主进程 → 注入 spawn 的 `CURSOR_API_KEY` env。主进程不直连后端，职责干净。

## 实施阶段

1. **后端凭据**（方案 B，简单，与驱动并行）— 模型 + AutoMigrate + handler + 路由 + 前端 SettingsModal 录入入口。
2. **cursor 实时驱动**（先）— `electron/cursorDriver.cjs`：spawnArgs + stream-json normalizeEvent；`PROVIDERS.cursor.live=true`；session 按 provider 分发（claude 仍走 SDK）。拿真实 key 验 stream-json 事件结构、校准 normalizeEvent。
3. **cursor 历史读取**（再）— store.db 解析（md5(cwd) 定位 → 根 blob field-1 游走 → 消息 JSON.parse → MsgPart）。
4. **codex**（cursor 完成后）— 二进制当前损坏需重装；driver 走 `codex exec --json`，历史读 rollout JSONL。
5. **gemini** — driver 走 `-o stream-json`，会话列举优先用 CLI `--list-sessions`/`--resume`。

## 未决/风险

- cursor stream-json 实际事件结构需拿 key 亲验（阶段 2 第一步）。
- cursor 根 blob protobuf 未公开，防御性解析。
- codex 二进制损坏：接 codex 前 `npm i -g @openai/codex` 重装。
- gemini `--resume <index>` 是序号会随新会话漂移，做 ID 映射时注意时序。
