/**
 * 本地 Agent 客户端 —— renderer 侧对 Electron 桥的类型化封装。
 *
 * 纯本地功能：驱动用户机器上已装的 CLI Agent（Claude Code 已打通，
 * codex / gemini 探测到但暂不可对话）。非 Electron 环境下整组 API 不可用，
 * UI 据 `isLocalAgentAvailable()` 隐藏入口。
 */

export type ProviderId = 'claude' | 'codex' | 'gemini';

/** Claude Code 权限模式（对应 CLI --permission-mode）。 */
export type PermMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
export const PERM_MODES: PermMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
export const PERM_META: Record<PermMode, { label: string; tone: string; hint: string }> = {
  default: { label: 'Default', tone: 'default', hint: '默认：需要时询问权限' },
  plan: { label: 'Plan', tone: 'plan', hint: '计划：只读规划，不改文件不执行' },
  acceptEdits: { label: 'Accept Edits', tone: 'edit', hint: '接受编辑：自动接受文件改动' },
  bypassPermissions: { label: 'Bypass', tone: 'bypass', hint: '跳过权限：全自动执行（原 YOLO）' },
};

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

interface SendPayload {
  provider: ProviderId;
  cwd: string;
  sessionId?: string | null;
  prompt: string;
  permMode?: PermMode;
}

interface LocalAgentBridge {
  detect(): Promise<DetectedProvider[]>;
  pickFolder(): Promise<string | null>;
  listSessions(provider: ProviderId, cwd: string): Promise<SessionSummary[]>;
  readSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ messages: TranscriptMessage[] }>;
  deleteSession(provider: ProviderId, cwd: string, sessionId: string): Promise<{ ok: boolean; trashed?: boolean; error?: string }>;
  listCommands(provider: ProviderId, cwd: string): Promise<SlashCommand[]>;
  send(payload: SendPayload): Promise<{ ok: boolean }>;
  permissionRespond(permId: string, decision: PermissionDecision): Promise<{ ok: boolean }>;
  interrupt(cwd: string): Promise<{ ok: boolean }>;
  sessionClose(cwd: string): Promise<{ ok: boolean }>;
  setPermMode(cwd: string, permMode: PermMode): Promise<{ ok: boolean }>;
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
  listSessions: (provider: ProviderId, cwd: string) =>
    bridge()?.listSessions(provider, cwd) ?? Promise.resolve([] as SessionSummary[]),
  readSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.readSession(provider, cwd, sessionId) ?? Promise.resolve({ messages: [] as TranscriptMessage[] }),
  deleteSession: (provider: ProviderId, cwd: string, sessionId: string) =>
    bridge()?.deleteSession(provider, cwd, sessionId) ?? Promise.resolve({ ok: false }),
  listCommands: (provider: ProviderId, cwd: string) =>
    bridge()?.listCommands(provider, cwd) ?? Promise.resolve([] as SlashCommand[]),
  send: (payload: SendPayload) => bridge()?.send(payload) ?? Promise.resolve({ ok: false }),
  permissionRespond: (permId: string, decision: PermissionDecision) =>
    bridge()?.permissionRespond(permId, decision) ?? Promise.resolve({ ok: false }),
  interrupt: (cwd: string) => bridge()?.interrupt(cwd) ?? Promise.resolve({ ok: false }),
  sessionClose: (cwd: string) => bridge()?.sessionClose(cwd) ?? Promise.resolve({ ok: false }),
  setPermMode: (cwd: string, permMode: PermMode) => bridge()?.setPermMode(cwd, permMode) ?? Promise.resolve({ ok: false }),
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
export interface PersistedTab { cwd: string; sessionId: string | null; title: string; groupId?: string | null; }
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
