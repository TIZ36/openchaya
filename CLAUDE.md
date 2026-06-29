# Chaya — Development Rules

> **纯客户端桌面应用（Electron）。已抛弃 Go 服务器，无账号、无登录、零联网即可用。**
> 历史：早期是「Electron 前端 + Go 后端（chaya-server）」。2026-06 起转为纯本地客户端，
> 服务器与其 API 全部删除；用户配置/凭证落本地 SQLite；云能力只保留按需的 SmartNote Cloud。

## 项目结构

```
chaya-next/
├── app/                       # Electron 桌面应用（唯一产物）
│   ├── electron/              # 主进程（.cjs）
│   │   ├── main.cjs           # 入口：建窗 + 注册各桥
│   │   ├── preload.cjs        # contextBridge 暴露 window.chateeElectron.*
│   │   ├── configDb.cjs       # 本地 SQLite 配置/凭证库（better-sqlite3）
│   │   ├── localAgent.cjs     # 本地 CLI agent 驱动（claude/codex/cursor/gemini/copilot/opencode）
│   │   ├── evolve.cjs         # 自进化引擎（升格 agent 会话的 reflect + consolidate）
│   │   ├── automation.cjs / cron.cjs / review.cjs / fbot*.cjs / notes.cjs
│   │   └── *AcpDriver.cjs / cursorDriver.cjs
│   └── src/                   # 渲染层（React + Vite + TS）
│       ├── v2/                # 当前 UI 外壳（ClientShell 是根）
│       ├── services/          # 渲染层服务（configStore / smartnoteApi / kbApi …）
│       └── i18n/              # 语言系统（默认英文 + 可切中文）
├── restart-client.sh          # 起 Electron 开发态（electron:dev）
└── restart-front.sh           # 仅起 Vite（一般用 restart-client.sh）
```

> 已删除：`chaya-server/`（Go 后端）、`embedding/`、`docker-compose.yml`、`chaya-cli/`、所有 server 脚本。

## 核心原则

1. **纯本地优先** — 所有核心功能（本地 CLI agent、自动化、评审、定时、笔记、自进化）零服务器、零登录可用。
2. **无账号** — 不登录。首启只问「怎么称呼你」（个性化，可跳过/随时改），存本地 SQLite。
3. **配置/凭证唯一真源 = 本地 SQLite**（`userData/chaya.db`），不再用 localStorage 存凭证。
   - 普通配置走 `kv` 表；凭证（SmartNote / cursor / MCP OAuth …）走 `secrets` 表。
   - 渲染层经 `src/services/configStore.ts` 同步读（启动快照）/ 异步写。**新增凭证/配置一律走它，别再写 localStorage。**
   - localStorage 仅留纯 UI 状态（面板宽度、pin、草稿、主题等）。
4. **云能力按需** — 只保留 SmartNote Cloud（知识库/记忆，自带 API key 凭证）。其它一切本地。
5. **主进程能力经 preload 桥暴露**，渲染层用 `window.chateeElectron.*`；新增主进程能力 = 加 IPC handler + preload 桥 + 渲染层薄封装。

## 架构

```
渲染层 (React, src/v2)                     主进程 (electron/*.cjs)
  ClientShell（根，本地优先外壳）   ──IPC──▶  configDb   (SQLite: kv / secrets / agent_memory / agent_skill)
  useLocalAgent（本地 agent 状态机）        localAgent (provider 无关 CLI 驱动 + runHeadless 一次性补全)
  services/configStore（配置/凭证）          evolve     (post-turn reflect + consolidate + 记忆文件)
  services/evolve（自进化桥）                automation / cron / review / fbot / notes
  KnowledgeView（KB→SmartNote Cloud）
```

### 本地 Agent（核心交互面）

- 一个工作目录可并存多个 session（每个 = 独立 tab/lane 同时跑）；按 `realDir(t.cwd)` 判项目。
- 6 个 provider：claude(默认) / codex / cursor / gemini / copilot / opencode；各读自己的 MCP 配置。
- Skill = prompt 模板（composer 发送前展开），provider 通用。
- 「会话升格为 Agent」：给会话一个身份（名/人设/记忆），@召唤、自动注入；见 `src/v2/services/agents.ts`。

### 自进化（只服务升格为 Agent 的会话）

- 借鉴 `~/aiproj/eva`（agent-runtime 库）的三层时序，单机简化版，**不做 skill 物化**。
- **post-turn 反思**（`evolve.cjs`）：每回合结束后台异步蒸馏 偏好(block)/笔记(note)/可复用 SOP(induced skill)
  + 负反馈闭环（用户纠错 → 修订/否决草稿）。LLM 调用复用 `localAgent.runHeadless`（provider 无关一次性补全）。
- **成熟阶梯**：draft ──人工 approve──▶ trusted ──uses≥N──▶ promoted；draft ──veto──▶ rejected（不进记忆/不删/留痕）。
- **喂给 agent = 被引用的记忆文件**：写 `<cwd>/.chaya/AGENT_MEMORY.md`（block + trusted/promoted 技能）；
  claude 经 systemPrompt 指引读取，其它 provider 经 prompt 前缀指引。
- 触发点：`useLocalAgent.finalizeTurn → maybeReflectTurn`（仅 `agentBySession(sid)` 命中）。
- UI：AgentsManager 编辑弹层的「自进化记忆」面板（认可/修订/否决/删除）+ 进化 toast。

## 数据库（userData/chaya.db, better-sqlite3）

```
kv(k PK, v, updated_at)                                  -- 普通配置（JSON 文本）
secrets(name PK, value, meta JSON, updated_at)           -- 凭证（smartnote_api_key / cursor_api_key / mcp_oauth:* …）
agent_memory(id, agent_id, kind[block|note], label, value, tags, uses, consolidated, …)
agent_skill(agent_id, name, description, body, keywords, maturity[draft|trusted|promoted|rejected|archived], uses, reject_reason, source, last_used_at, …)
```

- 原生模块（better-sqlite3 / node-pty）需 `pnpm run rebuild:native`（接 electron-rebuild）。

## 启动

```bash
cd ~/aiproj/chaya-next && ./restart-client.sh      # Electron 开发态（Vite :5177 + Electron）
# 知识库/记忆能力按需：SmartNote Cloud（~/aiproj/smartnote），凭证在 App 设置里填
```

## 前端约定

- 所有凭证/配置读写走 `configStore`（`getConfig/setConfig` + `getSecret/setSecret`），**不写 localStorage**。
- 文案走 i18n（`src/i18n/dictionaries.ts`，zh + en 双字典）；默认英文。
- 主进程改了（electron/*.cjs）要重启 Electron 才生效。

## 技术选型

| 组件 | 选型 |
|------|------|
| 桌面 | Electron |
| 前端 | React + Vite + TypeScript + TailwindCSS |
| 本地存储 | SQLite（better-sqlite3） |
| 终端 pty | node-pty |
| 本地 agent | 各家 CLI 子进程（claude-agent-sdk / codex / ACP …） |
| 云知识/记忆 | SmartNote Cloud（按需） |
