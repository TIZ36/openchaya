/**
 * 本地 Agent 客户端 —— renderer 侧对 Electron 桥的类型化封装。
 *
 * 纯本地功能：驱动用户机器上已装的 CLI Agent（Claude Code 已打通，
 * codex / gemini 探测到但暂不可对话）。非 Electron 环境下整组 API 不可用，
 * UI 据 `isLocalAgentAvailable()` 隐藏入口。
 */

export type ProviderId = 'claude' | 'cursor' | 'codex' | 'gemini';

/** 权限模式：claude 用 default/plan/acceptEdits/bypassPermissions（CLI --permission-mode）；
 *  cursor 用 plan/ask/force（cursor-agent 没有逐工具暂停，只有档位）。 */
export type PermMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'ask' | 'force';
export const PERM_META: Record<PermMode, { label: string; tone: string; hint: string }> = {
  default: { label: 'default', tone: 'default', hint: '默认：需要时询问权限' },
  plan: { label: 'plan', tone: 'plan', hint: '计划：只读规划，不改文件不执行' },
  acceptEdits: { label: 'accept edits', tone: 'edit', hint: 'accept edits：自动接受文件改动' },
  bypassPermissions: { label: 'bypass', tone: 'bypass', hint: '跳过权限：全自动执行（原 YOLO）' },
  ask: { label: 'ask', tone: 'plan', hint: '询问：只读问答，不改文件' },
  force: { label: 'force', tone: 'bypass', hint: '强制：自动放行全部工具（含写/执行）' },
};
/** 每个 provider 可循环切换的权限档（Tab 键）。 */
const PERM_MODES_BY_PROVIDER: Partial<Record<ProviderId, PermMode[]>> = {
  claude: ['default', 'plan', 'acceptEdits', 'bypassPermissions'],
  cursor: ['plan', 'ask', 'force'],
  // gemini approval-mode: default / auto_edit(→acceptEdits) / yolo(→bypassPermissions)
  gemini: ['default', 'acceptEdits', 'bypassPermissions'],
};
export function permModesFor(provider: ProviderId): PermMode[] {
  return PERM_MODES_BY_PROVIDER[provider] || PERM_MODES_BY_PROVIDER.claude!;
}
/** provider 的默认权限档（新会话用）。cursor 默认 force（无逐工具暂停，与 claude bypass 体感一致）。 */
export function defaultPermMode(provider: ProviderId): PermMode {
  return provider === 'cursor' ? 'force' : 'default';
}

/** CC 斜杠命令（权威名单来自 system/init.slash_commands，描述从 .claude/commands 补）。 */
export interface SlashCommand {
  name: string;            // 形如 /commit、/git:push、/compact
  description: string;
  scope: 'project' | 'user' | 'builtin';
}

/** agent 请求权限/批准时弹给用户（来自 SDK canUseTool）。 */
export interface PermissionRequest {
  permId: string;
  toolName: string;
  input: any;
  title: string | null;
  displayName: string | null;
  description: string | null;
  suggestions: any[] | null;   // “始终允许”用：作为 updatedPermissions 回填
}
/** 用户对权限请求的决定（= SDK PermissionResult）。 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: any; updatedPermissions?: any[] }
  | { behavior: 'deny'; message: string };

/** agent 用 AskUserQuestion 抛给用户的选择题。 */
export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }
export interface QuestionRequest { permId: string; questions: Question[] }

export interface DetectedProvider {
  id: ProviderId;
  label: string;
  installed: boolean;
  bin: string | null;
  live: boolean;        // 是否支持实时对话
  version: string | null;
}

export interface SessionSummary {
  sessionId: string;
  title: string | null;
  preview: string | null;
  turns: number;
  updatedAt: number;    // epoch ms
}

export type MsgPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input?: any; id?: string }
  | { kind: 'tool_result'; text: string; isError?: boolean; toolUseId?: string };

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  parts: MsgPart[];
  ts: string | null;
  uuid: string | null;
  parentId?: string | null;   // 子 agent(Task) 消息：= 派生它的 Task 的 tool_use id
}

/** SDK 消息 + chaya 合成事件。按 cwd（标签）路由。 */
export interface LocalAgentEvent {
  cwd: string;
  ev: any;
}

/** 可选模型（来自 SDK supportedModels()）：value 用于 API 调用，displayName 给 UI。 */
export interface ModelInfo { value: string; displayName: string; description?: string }

/** 可用的 MCP server（来自 ~/.claude.json，不含密钥）。 */
export interface McpAvailable { name: string; scope: 'global' | 'project'; type: string }
/** MCP 连接状态（来自 SDK mcpServerStatus / system.init.mcp_servers）。 */
export interface McpStatus { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' }

/** 一个参考附件：拖入/选取的文件（带 path），或粘贴板图片（带 dataUrl）。
 *  图片走视觉（image block），其它文件按 @路径 让 agent 读取分析。 */
export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mime?: string | null;
  path?: string;       // 来自磁盘的文件（拖入 / 附件按钮）
  dataUrl?: string;    // 图片 base64（粘贴板，或选取的图片回填）—— 兼作缩略图
  size?: number;
}

interface SendPayload {
  provider: ProviderId;
  cwd: string;
  sessionId?: string | null;
  prompt: string;
  permMode?: PermMode;
  model?: string;
  mcp?: string[];
  apiKey?: string | null;   // cursor headless 必需（从后端凭据拉到、由 useLocalAgent 注入）
  attachments?: Attachment[];
  lane?: string;            // 并行车道（如 'derive'）：同一 cwd 起独立常驻会话，事件按 cwd+lane 路由
}
type WarmPayload = Omit<SendPayload, 'prompt'>;

interface LocalAgentBridge {
  detect(): Promise<DetectedProvider[]>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<Array<{ kind: 'image' | 'file'; name: string; path: string; mime: string | null; size: number; dataUrl?: string }>>;
  listSessions(provider: ProviderId, cwd: string): Promise<SessionSummary[]>;
  readSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ messages: TranscriptMessage[] }>;
  deleteSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ ok: boolean; trashed?: boolean; error?: string }>;
  listCommands(provider: ProviderId, cwd: string): Promise<SlashCommand[]>;
  send(payload: SendPayload): Promise<{ ok: boolean }>;
  warm(payload: WarmPayload): Promise<{ ok: boolean }>;
  permissionRespond(permId: string, decision: PermissionDecision): Promise<{ ok: boolean }>;
  interrupt(cwd: string, lane?: string): Promise<{ ok: boolean }>;
  sessionClose(cwd: string, lane?: string): Promise<{ ok: boolean }>;
  setPermMode(cwd: string, permMode: PermMode, lane?: string): Promise<{ ok: boolean }>;
  setModel(cwd: string, model: string, lane?: string): Promise<{ ok: boolean }>;
  listMcp(cwd: string): Promise<McpAvailable[]>;
  setMcp(cwd: string, mcp: string[], lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  mcpStatus(cwd: string, lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  reconnectMcp(cwd: string, name: string, lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  onEvent(cb: (data: LocalAgentEvent) => void): () => void;
}

function bridge(): LocalAgentBridge | null {
  const w = window as any;
  return w?.chateeElectron?.localAgent ?? null;
}

export function isLocalAgentAvailable(): boolean {
  return !!bridge();
}

export const localAgent = {
  available: isLocalAgentAvailable,
  detect: () => bridge()?.detect() ?? Promise.resolve([] as DetectedProvider[]),
  pickFolder: () => bridge()?.pickFolder() ?? Promise.resolve(null),
  pickFiles: () => bridge()?.pickFiles() ?? Promise.resolve([]),
  listSessions: (provider: ProviderId, cwd: string) =>
    bridge()?.listSessions(provider, cwd) ?? Promise.resolve([] as SessionSummary[]),
  readSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.readSession(provider, cwd, sessionId) ?? Promise.resolve({ messages: [] as TranscriptMessage[] }),
  deleteSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.deleteSession(provider, cwd, sessionId) ?? Promise.resolve({ ok: false }),
  listCommands: (provider: ProviderId, cwd: string) =>
    bridge()?.listCommands(provider, cwd) ?? Promise.resolve([] as SlashCommand[]),
  send: (payload: SendPayload) => bridge()?.send(payload) ?? Promise.resolve({ ok: false }),
  warm: (payload: WarmPayload) => bridge()?.warm(payload) ?? Promise.resolve({ ok: false }),
  permissionRespond: (permId: string, decision: PermissionDecision) =>
    bridge()?.permissionRespond(permId, decision) ?? Promise.resolve({ ok: false }),
  interrupt: (cwd: string, lane?: string) => bridge()?.interrupt(cwd, lane) ?? Promise.resolve({ ok: false }),
  sessionClose: (cwd: string, lane?: string) => bridge()?.sessionClose(cwd, lane) ?? Promise.resolve({ ok: false }),
  setPermMode: (cwd: string, permMode: PermMode, lane?: string) => bridge()?.setPermMode(cwd, permMode, lane) ?? Promise.resolve({ ok: false }),
  setModel: (cwd: string, model: string, lane?: string) => bridge()?.setModel(cwd, model, lane) ?? Promise.resolve({ ok: false }),
  listMcp: (cwd: string) => bridge()?.listMcp(cwd) ?? Promise.resolve([] as McpAvailable[]),
  setMcp: (cwd: string, mcp: string[], lane?: string) => bridge()?.setMcp(cwd, mcp, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  mcpStatus: (cwd: string, lane?: string) => bridge()?.mcpStatus(cwd, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  reconnectMcp: (cwd: string, name: string, lane?: string) => bridge()?.reconnectMcp(cwd, name, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  onEvent: (cb: (data: LocalAgentEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
};

/** 生成一次回合的 runId。 */
export function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ *
 * 项目（保存的工作目录）—— 纯本地持久化，存 localStorage，不走后端。
 * 让用户像 Codex/Claude 那样在侧栏管理项目，不必每次重选目录。
 * ------------------------------------------------------------------ */
export interface LocalProject {
  id: string;
  path: string;
  name: string;       // 默认取目录 basename，可重命名
  addedAt: number;
}

const PROJECTS_KEY = 'chaya.localAgent.projects';

export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function loadProjects(): LocalProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveProjects(list: LocalProject[]): void {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export function addProject(path: string): LocalProject[] {
  const list = loadProjects();
  if (list.some((p) => p.path === path)) return list;   // 去重
  list.unshift({ id: `p-${Date.now()}`, path, name: basename(path), addedAt: Date.now() });
  saveProjects(list);
  return list;
}

export function removeProject(id: string): LocalProject[] {
  const list = loadProjects().filter((p) => p.id !== id);
  saveProjects(list);
  return list;
}

export function renameProject(id: string, name: string): LocalProject[] {
  const list = loadProjects().map((p) => (p.id === id ? { ...p, name } : p));
  saveProjects(list);
  return list;
}

/* ------------------------------------------------------------------ *
 * 标签分组（类 Chrome 标签组）—— 把顶部多个标签合并成一个带色分组管理。
 * ------------------------------------------------------------------ */
export interface TabGroup {
  id: string;
  name: string;
  color: string;      // 分组显示色（chip / 成员描边）
  collapsed: boolean; // 折叠：只显示分组 chip，隐藏成员标签（不改变主区显示内容）
}

/* ------------------------------------------------------------------ *
 * 打开的标签 —— 持久化（localStorage），下次启动自动续传这些会话。
 * 只存身份（cwd / sessionId / title / groupId），不存对话内容（重开时按 sessionId 读盘续传）。
 * ------------------------------------------------------------------ */
export interface PersistedTab { cwd: string; sessionId: string | null; title: string; groupId?: string | null; permMode?: PermMode; }
const TABS_KEY = 'chaya.localAgent.openTabs';

export function loadTabsState(): { tabs: PersistedTab[]; activeCwd: string | null; groups: TabGroup[]; layout: unknown } {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return { tabs: [], activeCwd: null, groups: [], layout: null };
    const o = JSON.parse(raw);
    return {
      tabs: Array.isArray(o?.tabs) ? o.tabs : [],
      activeCwd: o?.activeCwd ?? null,
      groups: Array.isArray(o?.groups) ? o.groups : [],
      layout: o?.layout ?? null,
    };
  } catch {
    return { tabs: [], activeCwd: null, groups: [], layout: null };
  }
}

export function saveTabsState(tabs: PersistedTab[], activeCwd: string | null, groups: TabGroup[], layout: unknown): void {
  try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeCwd, groups, layout })); } catch { /* quota */ }
}

/* 每个会话「最后一次发送时的权限级别」记忆（按 sessionId）。重开历史会话时默认切回该级别。 */
const PERM_BY_SESSION_KEY = 'chaya.localAgent.permBySession';
export function loadPermBySession(): Record<string, PermMode> {
  try { const raw = localStorage.getItem(PERM_BY_SESSION_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function savePermBySession(map: Record<string, PermMode>): void {
  try { localStorage.setItem(PERM_BY_SESSION_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/* CLI 项目树「展开了哪些目录」的记忆（按 project id）。下次启动自动恢复，无需重新点开。 */
const EXPANDED_KEY = 'chaya.localAgent.expandedProjects';
export function loadExpandedProjects(): string[] {
  try { const raw = localStorage.getItem(EXPANDED_KEY); const a = raw ? JSON.parse(raw) : null; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function saveExpandedProjects(ids: string[]): void {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids)); } catch { /* quota */ }
}

/* 每个会话「选用的模型」记忆（按 sessionId）。重开历史会话时默认切回。 */
const MODEL_BY_SESSION_KEY = 'chaya.localAgent.modelBySession';
export function loadModelBySession(): Record<string, string> {
  try { const raw = localStorage.getItem(MODEL_BY_SESSION_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function saveModelBySession(map: Record<string, string>): void {
  try { localStorage.setItem(MODEL_BY_SESSION_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/* 每个会话「启用的 MCP server 名字」记忆（按 sessionId）。 */
const MCP_BY_SESSION_KEY = 'chaya.localAgent.mcpBySession';
export function loadMcpBySession(): Record<string, string[]> {
  try { const raw = localStorage.getItem(MCP_BY_SESSION_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function saveMcpBySession(map: Record<string, string[]>): void {
  try { localStorage.setItem(MCP_BY_SESSION_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/* 目录唯一笔记（按 cwd）。一条 = 用户在问答过程中随手存下的短语/AI 回答片段。
   现走 localStorage（与上面同模式）；未来可加 Electron IPC 落盘到 cwd 的 .chaya/notes.md。 */
export type NoteKind = 'doc' | 'ai' | 'manual';
export interface NoteItem { id: string; text: string; kind: NoteKind; at: number; }
const NOTES_BY_CWD_KEY = 'chaya.localAgent.notesByCwd';
export function loadNotesByCwd(): Record<string, NoteItem[]> {
  try { const raw = localStorage.getItem(NOTES_BY_CWD_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function saveNotesByCwd(map: Record<string, NoteItem[]>): void {
  try { localStorage.setItem(NOTES_BY_CWD_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

/* 衍生(derive)会话的 sessionId 登记（按 cwd）。衍生在 ~/.claude 留下真实 transcript，会被
   listSessions 扫到；登记后侧栏会话列表把它们过滤掉——衍生只活在卡片里，不污染项目根。 */
const DERIVE_SIDS_KEY = 'chaya.localAgent.deriveSids';
export function loadDeriveSids(): Record<string, string[]> {
  try { const raw = localStorage.getItem(DERIVE_SIDS_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function addDeriveSid(cwd: string, sid: string): void {
  if (!cwd || !sid) return;
  try {
    const map = loadDeriveSids();
    const arr = map[cwd] || [];
    if (!arr.includes(sid)) { map[cwd] = [...arr, sid]; localStorage.setItem(DERIVE_SIDS_KEY, JSON.stringify(map)); }
  } catch { /* quota */ }
}

/* 衍生卡片状态持久化（按 cwd）：刷新后能恢复挂在触发 session 下的衍生。
   只存元数据；会话正文按需用 readSession(sessionId) 拉。parentSid = 触发时的主会话 id。 */
export interface DerivMeta { id: string; n: number; sessionId: string | null; quote: string; title: string; parentSid: string | null; }
const DERIVATIONS_KEY = 'chaya.localAgent.derivations';
export function loadDerivations(): Record<string, DerivMeta[]> {
  try { const raw = localStorage.getItem(DERIVATIONS_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function saveDerivations(cwd: string, metas: DerivMeta[]): void {
  try { const map = loadDerivations(); if (metas.length) map[cwd] = metas; else delete map[cwd]; localStorage.setItem(DERIVATIONS_KEY, JSON.stringify(map)); }
  catch { /* quota */ }
}
