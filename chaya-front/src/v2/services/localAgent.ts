/**
 * 本地 Agent 客户端 —— renderer 侧对 Electron 桥的类型化封装。
 *
 * 纯本地功能：驱动用户机器上已装的 CLI Agent（Claude Code / Cursor /
 * Codex / Gemini）。非 Electron 环境下整组 API 不可用，
 * UI 据 `isLocalAgentAvailable()` 隐藏入口。
 */

export type ProviderId = 'claude' | 'cursor' | 'codex' | 'gemini' | 'copilot';

/** 权限模式：claude/codex/gemini 用 default/plan/acceptEdits/bypassPermissions；
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
  // Codex exec has no Claude-style canUseTool callback. Keep the user-facing
  // modes to the behaviors Chaya can actually enforce.
  codex: ['default', 'plan', 'bypassPermissions'],
  cursor: ['plan', 'ask', 'force'],
  // gemini approval-mode: default / auto_edit(→acceptEdits) / yolo(→bypassPermissions)
  gemini: ['default', 'acceptEdits', 'bypassPermissions'],
  // copilot 走 ACP 逐工具权限请求（同 gemini）：default 弹问 / acceptEdits / bypass 全自动
  copilot: ['default', 'acceptEdits', 'bypassPermissions'],
};
export function permModesFor(provider: ProviderId): PermMode[] {
  return PERM_MODES_BY_PROVIDER[provider] || PERM_MODES_BY_PROVIDER.claude!;
}
/** provider 的默认权限档（新会话用）。cursor 默认 force（无逐工具暂停，与 claude bypass 体感一致）。 */
export function defaultPermMode(provider: ProviderId): PermMode {
  return provider === 'cursor' ? 'force' : 'default';
}
/** 各 provider 用自己的权限档叫法（贴近官方术语），而不是一套通用说词。
 *  claude/cursor 的 PERM_META 默认 label 已是它们自己的术语，无需覆盖。 */
const PERM_LABEL_BY_PROVIDER: Partial<Record<ProviderId, Partial<Record<PermMode, { label: string; hint: string }>>>> = {
  gemini: {
    default: { label: 'default', hint: 'default：需要时询问权限' },
    acceptEdits: { label: 'auto-edit', hint: 'auto-edit：自动接受文件改动' },
    bypassPermissions: { label: 'YOLO', hint: 'YOLO：全自动执行（含写/命令）' },
  },
  copilot: {
    default: { label: 'ask', hint: 'ask：每个工具都询问' },
    acceptEdits: { label: 'allow edits', hint: 'allow edits：自动放行文件改动' },
    bypassPermissions: { label: 'allow all', hint: 'allow all：放行全部工具（含执行）' },
  },
  codex: {
    default: { label: 'suggest', hint: 'suggest：改动前需确认' },
    acceptEdits: { label: 'auto-edit', hint: 'auto-edit：自动改文件' },
    bypassPermissions: { label: 'full-auto', hint: 'full-auto：全自动（含执行）' },
  },
};
export function permLabel(provider: ProviderId, mode: PermMode): string {
  return PERM_LABEL_BY_PROVIDER[provider]?.[mode]?.label ?? PERM_META[mode].label;
}
export function permHint(provider: ProviderId, mode: PermMode): string {
  return PERM_LABEL_BY_PROVIDER[provider]?.[mode]?.hint ?? PERM_META[mode].hint;
}

/** CC 斜杠命令（权威名单来自 system/init.slash_commands，描述从 .claude/commands 补）。 */
/** claude 订阅额度（/usage 文本解析）：百分比 0..100。 */
export interface UsageInfo {
  session?: number;       // 当前会话窗口（5h）已用百分比
  sessionReset?: string;  // 会话窗口重置时间（人类可读，原样透传）
  week?: number;          // 当前周（全模型）已用百分比
  weekReset?: string;     // 周窗口重置时间
  weekSonnet?: number;    // 当前周（仅 Sonnet）已用百分比
  breakdown?: string;     // 「What's contributing」往后的分解文本（原样）
}

export interface SlashCommand {
  name: string;            // 形如 /commit、/git:push、/compact
  description: string;
  scope: 'project' | 'user' | 'builtin' | 'chaya';   // chaya = Chaya 自定义技能（provider 无关）
  origin?: string;         // scope=chaya 且来自 CLI 自动导入时 = claude/codex/cursor/gemini
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
  agentId?: string | null;     // 非空 = 该请求来自子 agent(Task worker)；UI 据此标注「来自子 agent」
}
/** 用户对权限请求的决定（= SDK PermissionResult）。 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: any; updatedPermissions?: any[] }
  | { behavior: 'deny'; message: string };

/** agent 用 AskUserQuestion 抛给用户的选择题。 */
export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }
export interface QuestionRequest { permId: string; questions: Question[]; agentId?: string | null }

/** MCP 服务端 elicitation/create 请求用户输入（表单 / URL 授权）。 */
export interface ElicitRequest {
  elicitId: string;
  serverName: string | null;
  message: string;
  mode: 'form' | 'url';
  url: string | null;
  schema: Record<string, any> | null;   // JSON Schema（form 模式），渲染字段用
  title: string | null;
  displayName: string | null;
  description: string | null;
}
/** 用户对 elicitation 的回应（= MCP ElicitResult）。 */
export type ElicitResult =
  | { action: 'accept'; content?: Record<string, any> }
  | { action: 'decline' }
  | { action: 'cancel' };

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

export interface CodexSessionSummary extends SessionSummary {
  provider: 'codex';
  cwd: string;
}

export type MsgPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'skill'; name: string }   // Chaya 技能标记：发送前展开，气泡里渲染成 pill
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

/** 可选模型（来自 SDK supportedModels() / CLI catalog）：value 用于 API 调用，displayName 给 UI。 */
export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels?: Array<{ effort: string; description?: string }>;
}

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
  reasoning?: string;
  mcp?: string[];
  apiKey?: string | null;   // cursor headless 必需（从后端凭据拉到、由 useLocalAgent 注入）
  attachments?: Attachment[];
  lane?: string;            // 并行车道（如 'derive'）：同一 cwd 起独立常驻会话，事件按 cwd+lane 路由
  steer?: boolean;          // 运行中插话（claude steering）：主进程只推消息，不动会话配置（防 effort 重建杀回合）
}
type WarmPayload = Omit<SendPayload, 'prompt'>;

/** git status 单个改动文件（路径相对 repo root；abs = 绝对路径）。 */
export interface GitFile {
  path: string;        // 相对 repo root
  abs: string;         // 绝对路径
  x: string;           // index 状态位
  y: string;           // worktree 状态位
  untracked: boolean;  // ?? 未跟踪
  adds: number;
  dels: number;
  binary: boolean;
  renamedFrom?: string;
}
export interface GitStatusResult { ok: boolean; repo?: boolean; gitMissing?: boolean; root?: string; files?: GitFile[]; branch?: string; ahead?: number; behind?: number; hasUpstream?: boolean; error?: string }
export interface GitDiffResult { ok: boolean; diff?: string; untracked?: boolean; content?: string; error?: string }

/** 主进程扫到的一条 CLI 安装技能（claude skill / 各家自定义命令），body 已归一 {{input}} 占位。 */
export interface CliSkillEntry {
  name: string;
  description: string;
  body: string;
  origin: 'claude' | 'codex' | 'cursor' | 'gemini';
  path: string;
  mtime: number;
}

interface LocalAgentBridge {
  detect(only?: ProviderId): Promise<DetectedProvider[]>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<Array<{ kind: 'image' | 'file'; name: string; path: string; mime: string | null; size: number; dataUrl?: string }>>;
  listModels(provider: ProviderId, apiKey?: string | null): Promise<ModelInfo[]>;
  listSessions(provider: ProviderId, cwd: string): Promise<SessionSummary[]>;
  scanCodexSessions(): Promise<CodexSessionSummary[]>;
  readSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ messages: TranscriptMessage[] }>;
  deleteSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ ok: boolean; trashed?: boolean; error?: string }>;
  listCommands(provider: ProviderId, cwd: string): Promise<SlashCommand[]>;
  scanCliSkills(): Promise<CliSkillEntry[]>;
  usage(cwd?: string): Promise<UsageInfo | null>;
  busyKeys(): Promise<string[]>;
  send(payload: SendPayload): Promise<{ ok: boolean }>;
  warm(payload: WarmPayload): Promise<{ ok: boolean }>;
  permissionRespond(permId: string, decision: PermissionDecision): Promise<{ ok: boolean }>;
  elicitationRespond(elicitId: string, result: ElicitResult): Promise<{ ok: boolean }>;
  interrupt(cwd: string, lane?: string): Promise<{ ok: boolean }>;
  sessionClose(cwd: string, lane?: string): Promise<{ ok: boolean }>;
  setPermMode(cwd: string, permMode: PermMode, lane?: string): Promise<{ ok: boolean }>;
  setModel(cwd: string, model: string, lane?: string): Promise<{ ok: boolean }>;
  setReasoning(cwd: string, reasoning: string, lane?: string): Promise<{ ok: boolean }>;
  listMcp(cwd: string): Promise<McpAvailable[]>;
  setMcp(cwd: string, mcp: string[], lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  mcpStatus(cwd: string, lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  reconnectMcp(cwd: string, name: string, lane?: string): Promise<{ ok: boolean; servers?: McpStatus[]; error?: string }>;
  detectEditors(): Promise<{ vscode: boolean; cursor: boolean }>;
  openInEditor(editor: 'vscode' | 'cursor', dir: string): Promise<{ ok: boolean; error?: string }>;
  gitStatus(dir: string): Promise<GitStatusResult>;
  gitDiffFile(dir: string, file: string, untracked: boolean): Promise<GitDiffResult>;
  gitRevertFile(dir: string, file: string, untracked: boolean): Promise<{ ok: boolean; error?: string }>;
  gitRevertAll(dir: string): Promise<{ ok: boolean; trashed?: number; error?: string }>;
  gitCommit(dir: string, message: string): Promise<{ ok: boolean; error?: string }>;
  gitPush(dir: string): Promise<{ ok: boolean; error?: string }>;
  loginStart(provider: ProviderId, cols?: number, rows?: number): Promise<{ ok: boolean; id?: string; error?: string }>;
  loginInput(id: string, data: string): Promise<{ ok: boolean }>;
  loginResize(id: string, cols: number, rows: number): Promise<{ ok: boolean }>;
  loginKill(id: string): Promise<{ ok: boolean }>;
  loginStatus(provider: ProviderId): Promise<{ loggedIn: boolean | null; email?: string | null }>;
  onLogin(cb: (data: LoginEvent) => void): () => void;
  onEvent(cb: (data: LocalAgentEvent) => void): () => void;
  onAgentAsk(cb: (req: AgentAskRequest) => void): () => void;
  agentAskResult(requestId: string, text: string): Promise<{ ok: boolean }>;
}

/** agent 通过 ask_session 工具发起的「问另一个会话」请求（主进程 → 渲染层）。 */
export interface AgentAskRequest {
  requestId: string;
  fromRunKey: string;        // 发起会话的 runKey（paneKey）
  fromProvider: ProviderId;
  to: string;                // 目标会话关键字（模糊匹配）
  question: string;
  ephemeral?: boolean;
}

/** 登录 pty 的输出/退出事件（按 id 路由）。 */
export interface LoginEvent { id: string; type: 'data' | 'exit'; data?: string; code?: number; error?: string }
/** 支持触发 CLI 登录的 provider（其余靠 API Key/无需登录）。 */
export const LOGIN_PROVIDERS: ProviderId[] = ['claude', 'copilot', 'gemini'];

function bridge(): LocalAgentBridge | null {
  const w = window as any;
  return w?.chateeElectron?.localAgent ?? null;
}

export function isLocalAgentAvailable(): boolean {
  return !!bridge();
}

export const localAgent = {
  available: isLocalAgentAvailable,
  detect: (only?: ProviderId) => bridge()?.detect(only) ?? Promise.resolve([] as DetectedProvider[]),
  pickFolder: () => bridge()?.pickFolder() ?? Promise.resolve(null),
  pickFiles: () => bridge()?.pickFiles() ?? Promise.resolve([]),
  listModels: (provider: ProviderId, apiKey?: string | null) =>
    bridge()?.listModels(provider, apiKey) ?? Promise.resolve([] as ModelInfo[]),
  listSessions: (provider: ProviderId, cwd: string) =>
    bridge()?.listSessions(provider, cwd) ?? Promise.resolve([] as SessionSummary[]),
  scanCodexSessions: () =>
    bridge()?.scanCodexSessions() ?? Promise.resolve([] as CodexSessionSummary[]),
  readSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.readSession(provider, cwd, sessionId) ?? Promise.resolve({ messages: [] as TranscriptMessage[] }),
  deleteSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.deleteSession(provider, cwd, sessionId) ?? Promise.resolve({ ok: false }),
  listCommands: (provider: ProviderId, cwd: string) =>
    bridge()?.listCommands(provider, cwd) ?? Promise.resolve([] as SlashCommand[]),
  usage: (cwd?: string) => bridge()?.usage(cwd) ?? Promise.resolve(null),
  scanCliSkills: () => bridge()?.scanCliSkills() ?? Promise.resolve([] as CliSkillEntry[]),
  busyKeys: () => bridge()?.busyKeys() ?? Promise.resolve([] as string[]),
  send: (payload: SendPayload) => bridge()?.send(payload) ?? Promise.resolve({ ok: false }),
  warm: (payload: WarmPayload) => bridge()?.warm(payload) ?? Promise.resolve({ ok: false }),
  permissionRespond: (permId: string, decision: PermissionDecision) =>
    bridge()?.permissionRespond(permId, decision) ?? Promise.resolve({ ok: false }),
  elicitationRespond: (elicitId: string, result: ElicitResult) =>
    bridge()?.elicitationRespond(elicitId, result) ?? Promise.resolve({ ok: false }),
  interrupt: (cwd: string, lane?: string) => bridge()?.interrupt(cwd, lane) ?? Promise.resolve({ ok: false }),
  sessionClose: (cwd: string, lane?: string) => bridge()?.sessionClose(cwd, lane) ?? Promise.resolve({ ok: false }),
  setPermMode: (cwd: string, permMode: PermMode, lane?: string) => bridge()?.setPermMode(cwd, permMode, lane) ?? Promise.resolve({ ok: false }),
  setModel: (cwd: string, model: string, lane?: string) => bridge()?.setModel(cwd, model, lane) ?? Promise.resolve({ ok: false }),
  setReasoning: (cwd: string, reasoning: string, lane?: string) => bridge()?.setReasoning(cwd, reasoning, lane) ?? Promise.resolve({ ok: false }),
  listMcp: (cwd: string) => bridge()?.listMcp(cwd) ?? Promise.resolve([] as McpAvailable[]),
  setMcp: (cwd: string, mcp: string[], lane?: string) => bridge()?.setMcp(cwd, mcp, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  mcpStatus: (cwd: string, lane?: string) => bridge()?.mcpStatus(cwd, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  reconnectMcp: (cwd: string, name: string, lane?: string) => bridge()?.reconnectMcp(cwd, name, lane) ?? Promise.resolve({ ok: false } as { ok: boolean; servers?: McpStatus[]; error?: string }),
  detectEditors: () => bridge()?.detectEditors() ?? Promise.resolve({ vscode: false, cursor: false }),
  openInEditor: (editor: 'vscode' | 'cursor', dir: string) => bridge()?.openInEditor(editor, dir) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  gitStatus: (dir: string) => bridge()?.gitStatus(dir) ?? Promise.resolve({ ok: false, repo: false, files: [] } as GitStatusResult),
  gitDiffFile: (dir: string, file: string, untracked: boolean) => bridge()?.gitDiffFile(dir, file, untracked) ?? Promise.resolve({ ok: false } as GitDiffResult),
  gitRevertFile: (dir: string, file: string, untracked: boolean) => bridge()?.gitRevertFile(dir, file, untracked) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  gitRevertAll: (dir: string) => bridge()?.gitRevertAll(dir) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  gitCommit: (dir: string, message: string) => bridge()?.gitCommit(dir, message) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  gitPush: (dir: string) => bridge()?.gitPush(dir) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  loginStart: (provider: ProviderId, cols?: number, rows?: number) => bridge()?.loginStart(provider, cols, rows) ?? Promise.resolve({ ok: false, error: 'no bridge' }),
  loginInput: (id: string, data: string) => bridge()?.loginInput(id, data) ?? Promise.resolve({ ok: false }),
  loginResize: (id: string, cols: number, rows: number) => bridge()?.loginResize(id, cols, rows) ?? Promise.resolve({ ok: false }),
  loginKill: (id: string) => bridge()?.loginKill(id) ?? Promise.resolve({ ok: false }),
  loginStatus: (provider: ProviderId) => bridge()?.loginStatus(provider) ?? Promise.resolve({ loggedIn: null }),
  onLogin: (cb: (data: LoginEvent) => void) => bridge()?.onLogin(cb) ?? (() => {}),
  onEvent: (cb: (data: LocalAgentEvent) => void) => bridge()?.onEvent(cb) ?? (() => {}),
  onAgentAsk: (cb: (req: AgentAskRequest) => void) => bridge()?.onAgentAsk(cb) ?? (() => {}),
  agentAskResult: (requestId: string, text: string) => bridge()?.agentAskResult(requestId, text) ?? Promise.resolve({ ok: false }),
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
  try { window.dispatchEvent(new CustomEvent('chaya:localAgentProjectsChanged')); } catch { /* non-browser */ }
}

export function addProject(path: string): LocalProject[] {
  const list = loadProjects();
  if (list.some((p) => p.path === path)) return list;   // 去重
  list.unshift({ id: `p-${Date.now()}`, path, name: basename(path), addedAt: Date.now() });
  saveProjects(list);
  return list;
}

const CODEX_IMPORTS_KEY = 'chaya.localAgent.codexImportedSessions';
export type CodexImportsByCwd = Record<string, string[]>;

export function loadCodexImportedSessions(): CodexImportsByCwd {
  try {
    const raw = localStorage.getItem(CODEX_IMPORTS_KEY);
    const o = raw ? JSON.parse(raw) : null;
    return (o && typeof o === 'object') ? o : {};
  } catch {
    return {};
  }
}

export function addCodexImportedSessions(cwd: string, sessionIds: string[]): CodexImportsByCwd {
  const map = loadCodexImportedSessions();
  const cur = new Set(map[cwd] || []);
  sessionIds.forEach((id) => { if (id) cur.add(id); });
  if (cur.size) map[cwd] = [...cur];
  try { localStorage.setItem(CODEX_IMPORTS_KEY, JSON.stringify(map)); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent('chaya:localAgentCodexImportsChanged')); } catch { /* non-browser */ }
  return map;
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
export interface PersistedTab { cwd: string; sessionId: string | null; title: string; groupId?: string | null; permMode?: PermMode; provider?: ProviderId; }
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

/* 每个会话「Codex 思考强度」记忆（按 sessionId）。空 = 跟随 Codex 默认。 */
const REASONING_BY_SESSION_KEY = 'chaya.localAgent.reasoningBySession';
export function loadReasoningBySession(): Record<string, string> {
  try { const raw = localStorage.getItem(REASONING_BY_SESSION_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
export function saveReasoningBySession(map: Record<string, string>): void {
  try { localStorage.setItem(REASONING_BY_SESSION_KEY, JSON.stringify(map)); } catch { /* quota */ }
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
