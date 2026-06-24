/**
 * sessionBridge —— 「session 问 session」的内核（特色功能）。
 *
 * 让一个 CLI 会话（A）向另一个会话（B）提问，B 可以是：
 *   - existing：已打开的某个 session 真身（按其 dir+lane+sessionId 续接，复用 B 的上下文）；
 *   - spawn：临时拉起的一次性会话（专用 lane `xask-<id>`，答完即关，不污染项目）。
 * B 与 A 不必同 provider —— 发送层（localAgent.send）本就 provider 无关，分流全在主进程。
 *
 * 机制照搬 fbotDispatch：
 *   askSession() → localAgent.send({cwd,lane,sessionId,prompt}) 投递到 B
 *     └─ 监听该 runKey 的流（`<dir>#@#<lane>` 天然隔离）：
 *          stream_event 增量 → live 缓冲；assistant 整段 → committed（历史保留）
 *          result/error → finish：定稿 answer，临时会话顺手 sessionClose
 *   UI（围观面板）订阅 onAsksChange 实时渲染；答完用户决定是否把 answer 折回 A 的上下文。
 *
 * 事件是多播的：existing 目标的流同时被 useLocalAgent 收到并渲进 B 自己的标签页，
 * 所以「A 问 B」会真实成为 B 会话的一部分（诚实模型），用户在 B 标签也看得到。
 */
import { localAgent, type ProviderId, type PermMode, type PermissionRequest, type QuestionRequest, type PermissionDecision } from './localAgent';
import { api } from '../../utils/apiClient';

export type AskPhase = 'pending' | 'running' | 'answered' | 'error' | 'cancelled';

/** 目标会话描述。kind=existing 续接 B 真身；kind=spawn 临时拉起。 */
export interface AskTarget {
  kind: 'existing' | 'spawn';
  provider: ProviderId;
  dir: string;               // 真实工作目录（realDir，不带 lane 后缀）
  lane?: string;             // existing：B 的车道（主车道为空）；spawn：内部分配 xask-<id>
  sessionId?: string | null; // existing：续接 B 的 sessionId；spawn：null
  title: string;             // 目标显示名（项目名 / 会话标题）
  model?: string;
  mcp?: string[];
  apiKey?: string | null;    // cursor headless 必需
}

export interface SessionAsk {
  id: string;
  phase: AskPhase;
  ts: number;
  fromCwd: string;           // 发起方 A 的 paneKey（折回上下文时用）
  fromDir: string;           // 发起方 A 的真实工作目录（持久化/按目录归档的键）
  fromTitle: string;
  target: AskTarget;
  runKey: string;            // B 的事件路由键
  question: string;
  origin: 'user' | 'agent' | 'agent-summon'; // user=用户 # 发起；agent=对方 agent 通过 ask_session 工具发起；agent-summon=用户 @ 召唤本地 Agent
  agentId?: string;          // agent-summon：被召唤的 LocalAgent.id
  agentName?: string;        // agent-summon：展示用 @-handle
  anchorKey?: string;        // agent-summon：创建时发起会话最后一条消息的 key —— 卡片据此插进时间线对应位置
  live: string;              // 当前全量答复文本（committed + 当前增量）
  activity?: string;         // 当前工具/子任务进度
  answer?: string;           // 定稿全量
  error?: string;
  injected?: boolean;        // answer 已折回 A 的上下文
  perm?: PermissionRequest | null;        // 被召唤会话抛来的权限请求 → 在主会话内联处理（不进它自己的后台会话）
  askQuestion?: QuestionRequest | null;   // 被召唤会话抛来的 AskUserQuestion → 主会话内联处理
}

interface Capture {
  askId: string;
  committed: string;
  liveBuf: string;
  activity?: string;
  lastUuid?: string;
  ephemeral: boolean;
  dir: string;
  lane?: string;
}

const PANE_SEP = '#@#';
function runKeyOf(dir: string, lane?: string): string { return lane ? `${dir}${PANE_SEP}${lane}` : dir; }
/** paneKey/runKey → 真实工作目录（剥掉 lane 后缀），作为按目录归档的键。 */
function realDirOf(paneKey: string): string { const i = paneKey.indexOf(PANE_SEP); return i >= 0 ? paneKey.slice(0, i) : paneKey; }

const asks = new Map<string, SessionAsk>();
const byRunKey = new Map<string, Capture>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

// 缓存快照：useSyncExternalStore 要求 getSnapshot 返回稳定引用，只在 emit 时重建。
let snapshot: SessionAsk[] = [];
function rebuild() { snapshot = [...asks.values()].sort((a, b) => b.ts - a.ts); }

export function getAsks(): SessionAsk[] { return snapshot; }
export function getAsk(id: string): SessionAsk | undefined { return asks.get(id); }
export function onAsksChange(cb: () => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }
function emit() { rebuild(); schedulePersist(); listeners.forEach((f) => f()); }

/* ---- 持久化：按工作目录归档互问记录快照（重启可见 + 支持重新提问）---------- */
const LS_KEY = 'chaya:sessionBridge:history:v1';
const MAX_PER_DIR = 30;          // 每个工作目录最多留存多少条（旧的淘汰）
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  // 流式期 patch 高频 → 防抖合并，避免每个 token 都写盘。
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 800);
}
function persist() {
  if (typeof localStorage === 'undefined') return;
  try {
    const byDir: Record<string, SessionAsk[]> = {};
    for (const a of asks.values()) (byDir[a.fromDir] ||= []).push(a);
    for (const d of Object.keys(byDir)) byDir[d] = byDir[d].sort((x, y) => y.ts - x.ts).slice(0, MAX_PER_DIR);
    localStorage.setItem(LS_KEY, JSON.stringify(byDir));
  } catch { /* 配额/隐私模式 → 忽略 */ }
}
function restore() {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(LS_KEY); if (!raw) return;
    const byDir = JSON.parse(raw) as Record<string, SessionAsk[]>;
    for (const list of Object.values(byDir)) {
      for (const a of list) {
        if (!a?.id) continue;
        // 重启后流已断，进行中的无法续接 → 落为「已取消」，保留已有文本作为快照。
        const phase: AskPhase = (a.phase === 'pending' || a.phase === 'running') ? 'cancelled' : a.phase;
        asks.set(a.id, { ...a, phase, activity: undefined, fromDir: a.fromDir || realDirOf(a.fromCwd) });
      }
    }
    rebuild();
  } catch { /* 损坏的快照 → 忽略 */ }
}
function patch(id: string, p: Partial<SessionAsk>) {
  const cur = asks.get(id); if (!cur) return;
  asks.set(id, { ...cur, ...p }); emit();
}

/** 把一次提问从面板移除（不影响 B 已发生的会话）。 */
export function dismissAsk(id: string): void { if (asks.delete(id)) emit(); }
/** 标记 answer 已折回 A 的上下文（面板把按钮置灰）。 */
export function markInjected(id: string): void { patch(id, { injected: true }); }

/** 主会话内联回应被召唤会话的权限请求（按 permId 直达，无需 tab）。 */
export function respondAskPermission(id: string, decision: PermissionDecision): void {
  const a = asks.get(id);
  if (!a?.perm) return;
  void localAgent.permissionRespond(a.perm.permId, decision);
  patch(id, { perm: null });
}
/** 主会话内联回应被召唤会话的 AskUserQuestion（选择经 deny-message 回传，agent 据此继续）。 */
export function answerAskQuestion(id: string, text: string): void {
  const a = asks.get(id);
  if (!a?.askQuestion) return;
  void localAgent.permissionRespond(a.askQuestion.permId, { behavior: 'deny', message: text });
  patch(id, { askQuestion: null });
}

/** 中断进行中的提问（interrupt B 的那一回合）。 */
export function cancelAsk(id: string): void {
  const a = asks.get(id); if (!a) return;
  if (a.phase === 'running' || a.phase === 'pending') {
    void localAgent.interrupt(a.target.dir, a.target.lane);
    const cap = byRunKey.get(a.runKey);
    finish(a.runKey, false, '', true);
    void cap; // finish 内已清理
  }
  patch(id, { phase: 'cancelled' });
}

/* ---- 事件解析（与 fbotDispatch 同款）---------------------------------- */
type Block = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
function blocks(message: unknown): Block[] { const c = (message as { content?: unknown })?.content; return Array.isArray(c) ? (c as Block[]) : []; }
function textOf(message: unknown): string {
  const c = (message as { content?: unknown })?.content;
  if (typeof c === 'string') return c.trim();
  return blocks(message).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
}
function toolActivity(name?: string, input?: Record<string, unknown>): string {
  const n = name || '';
  const file = (p?: unknown) => String(p || '').split('/').pop() || '';
  if (n === 'Task') return '启动子任务…';
  if (n === 'Grep') return `搜索：${String(input?.pattern || '').slice(0, 32)}`;
  if (n === 'Glob') return `匹配：${String(input?.pattern || '').slice(0, 32)}`;
  if (n === 'Read') return `读取 ${file(input?.file_path)}`;
  if (n === 'Bash') return '执行命令…';
  if (/Edit|Write|MultiEdit/.test(n)) return `编辑 ${file(input?.file_path)}`;
  if (/WebFetch|WebSearch/.test(n)) return '检索资料…';
  return `执行 ${n}…`;
}
function bodyOf(cap: Capture): string {
  const parts: string[] = [];
  if (cap.committed) parts.push(cap.committed);
  if (cap.liveBuf) parts.push(cap.liveBuf);
  return parts.join('\n\n');
}
function syncLive(cap: Capture) {
  const body = bodyOf(cap);
  patch(cap.askId, { phase: 'running', live: body, activity: cap.activity });
}

function finish(runKey: string, errored: boolean, fallback: string, cancelled = false): void {
  const cap = byRunKey.get(runKey); if (!cap) return;
  byRunKey.delete(runKey);
  const tm = timers.get(runKey); if (tm) { clearTimeout(tm); timers.delete(runKey); }
  const full = (bodyOf(cap) || fallback || '').trim();
  if (!cancelled) {
    // 只有「真的没产出任何答复」才算出错；有完整答复时即使 subtype 非 success（plan 退出/max_turns 等）
    // 也按已答处理——否则用户拿不回这条答复（之前「会话异常结束」却带着整段答案就是这个坑）。
    const realError = errored && !full;
    patch(cap.askId, {
      phase: realError ? 'error' : 'answered',
      live: full, answer: full || undefined, activity: undefined,
      error: realError ? '会话异常结束' : undefined,
      perm: null, askQuestion: null,
    });
  }
  // 临时会话答完即关，释放常驻进程，不在项目根留痕。
  if (cap.ephemeral) void localAgent.sessionClose(cap.dir, cap.lane);
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return; subscribed = true;
  localAgent.onEvent(({ cwd, ev }: { cwd: string; ev: any }) => {
    const cap = byRunKey.get(cwd); if (!cap) return;
    const t = ev?.type;
    const isSub = !!ev?.parent_tool_use_id;
    if (t === 'stream_event') {
      if (isSub) return;
      const d = ev.event;
      if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta.text) {
        cap.liveBuf += d.delta.text; cap.activity = undefined; syncLive(cap);
      }
      return;
    }
    if (t === 'assistant') {
      const tool = blocks(ev.message).find((b) => b.type === 'tool_use');
      if (tool) cap.activity = toolActivity(tool.name, tool.input);
      if (!isSub) {
        const txt = textOf(ev.message);
        if (txt && ev.uuid !== cap.lastUuid) {
          cap.committed = cap.committed ? `${cap.committed}\n\n${txt}` : txt;
          cap.liveBuf = ''; cap.lastUuid = ev.uuid;
        }
      }
      syncLive(cap);
      return;
    }
    // 权限 / AskUserQuestion：不路由到被召唤会话自己的 UI（用户在主会话里，不该跳过去），
    // 而是挂到 ask 上，由主会话内联的召唤卡渲染、用户在原地答；响应按 permId 直达，无需 tab。
    if (t === 'permission_request') {
      patch(cap.askId, { perm: { permId: ev.permId, toolName: ev.toolName, input: ev.input, title: ev.title, displayName: ev.displayName, description: ev.description, suggestions: ev.suggestions, agentId: ev.agentId || null } });
      return;
    }
    if (t === 'question_request') {
      patch(cap.askId, { askQuestion: { permId: ev.permId, questions: (ev.input && ev.input.questions) || [], agentId: ev.agentId || null } });
      return;
    }
    if (t === 'result') {
      if (isSub) { cap.activity = '子任务完成…'; syncLive(cap); return; }
      const fallback = typeof ev.result === 'string' ? ev.result : '';
      finish(cwd, !!ev.subtype && ev.subtype !== 'success', fallback);
      return;
    }
    if (t === 'error') finish(cwd, true, ev.error || '');
  });
}

/** 提问提示词。
 *  - 默认（# 互问）：包一层「来自另一个会话」+ 只读说明。
 *  - bare（agent 召唤）：就像直接在该 session 里发一条消息——只发问题本身（带可选记忆片段），
 *    不加角色设定/跨会话包装；只读由 permMode（plan/ask）兜底。这样它自然落进该 session 的历史。 */
function askPrompt(fromTitle: string, question: string, opts?: { systemPrompt?: string; memoryContext?: string; bare?: boolean }): string {
  const sys = opts?.systemPrompt?.trim() ? `${opts.systemPrompt.trim()}\n\n` : '';
  const mem = opts?.memoryContext?.trim() ? `【相关记忆】\n${opts.memoryContext.trim()}\n\n` : '';
  if (opts?.bare) return `${sys}${mem}${question}`;
  return `${sys}${mem}（来自另一个会话「${fromTitle}」的提问）\n\n${question}\n\n请基于你当前会话的上下文与所在工作目录，**只读地**调研并用简体中文清晰作答，不要修改任何文件。`;
}

let seq = 0;
function newAskId(): string { seq += 1; return `ask-${Date.now().toString(36)}-${seq}`; }

let _cursorKey: string | null = null;
async function cursorKey(): Promise<string | null> {
  if (_cursorKey) return _cursorKey;
  try { const r = await api.get<{ api_key?: string }>('/api/local-agent/credentials/cursor/api-key'); _cursorKey = r?.api_key || null; }
  catch { _cursorKey = null; }
  return _cursorKey;
}

export interface AskInput {
  from: { cwd: string; title: string; dir?: string };
  target: AskTarget;
  question: string;
  origin?: 'user' | 'agent' | 'agent-summon';
  // agent-summon 专用：可选角色设定（一般不填）+ 检索记忆 + 身份标注 + bare（直接发消息式，不加跨会话包装）
  systemPrompt?: string;        // 非 claude provider：作为消息前缀（旧法）
  appendSystemPrompt?: string;  // claude：作为真·系统提示注入绑定会话（与直接对话一致），不前置进消息
  memoryContext?: string;
  bare?: boolean;
  agentId?: string;
  agentName?: string;
  anchorKey?: string;
}

/** 发起一次 session→session 提问，返回初始状态；进度走 onAsksChange。 */
export function askSession(input: AskInput): SessionAsk {
  ensureSubscribed();
  const id = newAskId();
  const ephemeral = input.target.kind === 'spawn';
  const lane = ephemeral ? `xask-${id}` : input.target.lane;
  const target: AskTarget = { ...input.target, lane };
  const runKey = runKeyOf(target.dir, lane);
  const ask: SessionAsk = {
    id, phase: 'pending', ts: Date.now(),
    fromCwd: input.from.cwd, fromDir: input.from.dir || realDirOf(input.from.cwd), fromTitle: input.from.title,
    target, runKey, question: input.question, origin: input.origin || 'user',
    agentId: input.agentId, agentName: input.agentName, anchorKey: input.anchorKey, live: '',
  };
  asks.set(id, ask); emit();

  const cap: Capture = { askId: id, committed: '', liveBuf: '', ephemeral, dir: target.dir, lane };
  byRunKey.set(runKey, cap);
  timers.set(runKey, setTimeout(() => finish(runKey, true, ''), 10 * 60_000));

  const permMode: PermMode = target.provider === 'cursor' ? 'ask' : 'plan';
  // claude：人设走引擎级真·系统提示（与直接对话一致），不再前置进消息文本；
  // 其它 provider：仍用旧的消息前缀法（systemPrompt）。
  const useEngineSys = target.provider === 'claude' && !!input.appendSystemPrompt?.trim();
  const prompt = askPrompt(input.from.title, input.question, { systemPrompt: useEngineSys ? undefined : input.systemPrompt, memoryContext: input.memoryContext, bare: input.bare });
  void (async () => {
    try {
      // cursor headless 必需 API Key —— 没显式给就现拉（与 fbotDispatch 同源）。
      const apiKey = target.provider === 'cursor' ? (target.apiKey ?? await cursorKey()) : (target.apiKey ?? undefined);
      const r = await localAgent.send({
        provider: target.provider, cwd: target.dir, lane,
        sessionId: target.sessionId ?? null, prompt, permMode,
        model: target.model, mcp: target.mcp, apiKey,
        appendSystemPrompt: useEngineSys ? input.appendSystemPrompt : undefined,
      });
      if (!r?.ok) {
        byRunKey.delete(runKey);
        const tm = timers.get(runKey); if (tm) { clearTimeout(tm); timers.delete(runKey); }
        patch(id, { phase: 'error', error: '发送失败' });
      } else {
        patch(id, { phase: 'running' });
      }
    } catch (e) {
      byRunKey.delete(runKey);
      const tm = timers.get(runKey); if (tm) { clearTimeout(tm); timers.delete(runKey); }
      patch(id, { phase: 'error', error: String((e as Error)?.message || e) });
    }
  })();

  return ask;
}

/** 用同一目标 + 同一问题再问一次（卡片「重新提问」快捷按钮）。spawn 目标会重起临时会话；
 *  existing 目标按原 lane/sessionId 续接 B 的上下文。返回新发起的提问。 */
export function reAsk(id: string): SessionAsk | undefined {
  const a = asks.get(id); if (!a) return undefined;
  return askSession({
    from: { cwd: a.fromCwd, title: a.fromTitle, dir: a.fromDir },
    target: a.target,
    question: a.question,
    origin: a.origin === 'agent-summon' ? 'agent-summon' : 'user',
    agentId: a.agentId, agentName: a.agentName,
  });
}

// 模块加载即恢复上次的互问记录快照（在 React 首次读取 getAsks 之前完成）。
restore();
