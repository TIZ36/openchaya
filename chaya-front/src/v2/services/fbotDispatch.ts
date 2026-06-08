/**
 * fbotDispatch —— 把「飞书提交」派发到本地 CLI 会话，并以 **Feishu AI 流式卡（打字机）** 把
 * 全过程答复回原会话（#4 闭环）。
 *
 *   提交 → fbot.cjs 落库(replyTo) + emit('submission')
 *     └─（renderer）route.kind='agent' → localAgent.send({cwd,prompt,lane})
 *          └─ 监听该 lane 流（cwd=`<dir>#@#<lane>` 天然隔离）：
 *               首段文本 → fbot.streamStart 起流式卡 → 拿 cardId
 *               过程中 → 节流 fbot.streamPush(cardId, 全量文本, seq++)  ← 打字机 + 历史全保留
 *               回合结束 → fbot.streamSettle 定稿关流式
 *
 * 历史保留：committed(已完成的每轮 assistant 文本) + live(当前增量) + activity(子任务/工具进度)
 * 累积成「全量文本」，每次覆盖式推给飞书（飞书自动 diff 出打字机），所以前文不会被后文冲掉。
 * intent='answer' 锁 plan 只读权限 + 回答类提示词。
 */
import { localAgent, type ProviderId, type PermMode } from './localAgent';
import { fbot } from './fbot';
import { api } from '../../utils/apiClient';
import type { SpecForm, SpecRoute, Submission } from './fbot';

export type DispatchPhase = 'pending' | 'running' | 'answered' | 'error';
export interface DispatchState {
  phase: DispatchPhase;
  ts: number;
  cwd: string;
  lane: string;
  provider: ProviderId;
  transcript?: string;     // 当前全量文本（Chaya 详情看，与飞书卡同源）
  activity?: string;       // 当前进度（工具/子任务）
  answer?: string;         // 最终全量
  replied?: boolean;       // 飞书流式卡已定稿
  streaming?: boolean;     // 已起飞书流式卡
  error?: string;
}

interface Capture {
  subId: string;
  replyTo?: string | null;
  title: string;
  cardId?: string;
  seq: number;
  starting?: boolean;
  noCard?: boolean;
  lastSent?: string;
  interval?: ReturnType<typeof setInterval>;
  committed: string;       // 已完成的每轮 assistant 文本（拼接，历史）
  live: string;            // 当前轮的增量缓冲
  activity?: string;       // 当前工具/子任务进度
  lastUuid?: string;       // 防重复提交同一条 assistant
}

const PUSH_THROTTLE_MS = 700;   // 流式卡推送节流（cardkit 支持较高频）

const states = new Map<string, DispatchState>();
const byRunKey = new Map<string, Capture>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

export function getDispatch(id: string): DispatchState | undefined { return states.get(id); }
export function onDispatchChange(cb: () => void): () => void { listeners.add(cb); return () => listeners.delete(cb); }
function emit() { listeners.forEach((f) => f()); }
function patch(subId: string, p: Partial<DispatchState>) {
  const cur = states.get(subId); if (!cur) return;
  states.set(subId, { ...cur, ...p }); emit();
}

export function shouldAutoDispatch(sub: Submission, form?: SpecForm): boolean {
  const r = form?.route;
  return !!r && r.kind === 'agent' && !!r.cwd && r.trigger === 'auto' && !states.has(sub.id);
}
export function canManualDispatch(form?: SpecForm): boolean {
  const r = form?.route;
  return !!r && r.kind === 'agent' && !!r.cwd;
}

export function renderPrompt(route: SpecRoute, form: SpecForm | undefined, values: Record<string, string>): string {
  const tpl = route.promptTemplate?.trim();
  if (tpl) {
    // 占位匹配「任意非花括号内容」—— 支持中文字段名（旧的 \w+ 不匹配中文，导致 {提问} 原样漏出）。
    // 解析顺序：按字段 name → 按字段 label（用户常按可见标签写占位）→ 查不到原样保留。
    return tpl.replace(/\{([^{}]+)\}/g, (_m, raw: string) => {
      const k = raw.trim();
      if (values[k] != null && values[k] !== '') return values[k];
      const byLabel = form?.fields.find((f) => f.label === k);
      if (byLabel && values[byLabel.name] != null) return values[byLabel.name];
      return `{${k}}`;
    });
  }
  const lines = Object.entries(values)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => { const f = form?.fields.find((x) => x.name === k); return `- ${f?.label || k}：${v}`; });
  const head = form?.title ? `飞书提单 · ${form.title}` : '飞书提单';
  if (route.intent === 'answer') {
    return `${head}\n${lines.join('\n')}\n\n请**只读地**调研当前工作目录的代码并回答上述问题，**不要修改任何文件**。用简体中文清晰作答，必要时给出关键文件/代码位置作为依据。`;
  }
  return `${head}\n${lines.join('\n')}\n\n请据此在当前工作目录完成对应改动；完成后用简体中文简述结论、改了哪些文件/为什么。`;
}

export function laneFor(route: SpecRoute, sub: Submission): string {
  return route.sessionMode === 'fresh' ? `fbot-${sub.id}` : 'fbot';
}
function runKey(cwd: string, lane: string): string { return lane ? `${cwd}#@#${lane}` : cwd; }

let _cursorKey: string | null = null;
async function cursorKey(): Promise<string | null> {
  if (_cursorKey) return _cursorKey;
  try { const r = await api.get<{ api_key?: string }>('/api/local-agent/credentials/cursor/api-key'); _cursorKey = r?.api_key || null; }
  catch { _cursorKey = null; }
  return _cursorKey;
}

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
  if (n === 'Task') return '启动子任务并行调研…';
  if (n === 'Grep') return `搜索：${String(input?.pattern || '').slice(0, 36)}`;
  if (n === 'Glob') return `匹配文件：${String(input?.pattern || '').slice(0, 36)}`;
  if (n === 'Read') return `读取 ${file(input?.file_path)}`;
  if (n === 'Bash') return '执行命令…';
  if (/Edit|Write|MultiEdit/.test(n)) return `编辑 ${file(input?.file_path)}`;
  if (/WebFetch|WebSearch/.test(n)) return '检索资料…';
  return `执行 ${n}…`;
}

// 全量展示文本：历史(committed) + 当前轮增量(live) + 进度(activity)。
function bodyOf(cap: Capture, withActivity: boolean): string {
  const parts: string[] = [];
  if (cap.committed) parts.push(cap.committed);
  if (cap.live) parts.push(cap.live);
  let body = parts.join('\n\n');
  if (withActivity && cap.activity) body = (body ? body + '\n\n' : '') + `*› ${cap.activity}*`;
  return body || '正在调研…';
}
function syncTranscript(cap: Capture) { patch(cap.subId, { phase: 'running', transcript: bodyOf(cap, true), activity: cap.activity }); }

// 起一张飞书流式卡（首段内容时一次）。
async function ensureStream(cap: Capture) {
  if (cap.cardId || cap.starting || cap.noCard || !cap.replyTo) return;
  cap.starting = true;
  const r = await fbot.streamStart(cap.replyTo, cap.title, 'blue');
  cap.starting = false;
  if (r?.ok && r.cardId) {
    cap.cardId = r.cardId;
    patch(cap.subId, { streaming: true });
    cap.interval = setInterval(() => flush(cap), PUSH_THROTTLE_MS);
  } else { cap.noCard = true; }
}
// 节流推全量（文本变了才推；sequence 递增）。
function flush(cap: Capture) {
  if (!cap.cardId) return;
  const body = bodyOf(cap, true);
  if (body && body !== cap.lastSent) { cap.lastSent = body; void fbot.streamPush(cap.cardId, body, ++cap.seq); }
}

async function finish(runKeyStr: string, errored: boolean, fallbackText?: string) {
  const cap = byRunKey.get(runKeyStr); if (!cap) return;
  byRunKey.delete(runKeyStr);
  const tm = timers.get(runKeyStr); if (tm) { clearTimeout(tm); timers.delete(runKeyStr); }
  if (cap.interval) clearInterval(cap.interval);
  cap.activity = undefined;
  const full = (bodyOf(cap, false) || fallbackText || '').trim() || (errored ? '执行未产出文本结果。' : '（无文本结果）');
  patch(cap.subId, { phase: errored ? 'error' : 'answered', answer: full, transcript: full, activity: undefined, error: errored ? '会话异常结束' : undefined });
  const finalTitle = `${cap.title} · ${errored ? '未完成' : '答复'}`;
  const template = errored ? 'red' : 'green';
  try {
    let ok = false;
    if (cap.cardId) { const r = await fbot.streamSettle(cap.cardId, full, ++cap.seq, finalTitle, template); ok = !!r?.ok; }
    else if (cap.replyTo) { const r = await fbot.reply(cap.replyTo, full, finalTitle); ok = !!r?.ok; }   // 没起流式卡 → 一次性回复兜底
    patch(cap.subId, { replied: ok });
  } catch (e) { patch(cap.subId, { error: `回贴异常：${String((e as Error)?.message || e)}` }); }
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return; subscribed = true;
  localAgent.onEvent(({ cwd, ev }: { cwd: string; ev: { type?: string; uuid?: string; message?: unknown; result?: unknown; subtype?: string; error?: string; parent_tool_use_id?: string; event?: { type?: string; delta?: { type?: string; text?: string } } } }) => {
    const cap = byRunKey.get(cwd); if (!cap) return;
    const t = ev?.type;
    const isSub = !!ev?.parent_tool_use_id;

    if (t === 'stream_event') {
      if (isSub) return;   // 子 agent 增量不混入主答复
      const d = ev.event;
      if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta' && d.delta.text) { cap.live += d.delta.text; cap.activity = undefined; syncTranscript(cap); void ensureStream(cap); }
      return;
    }
    if (t === 'assistant') {
      // 工具进度（主/子都看）→ activity，避免子任务执行时卡片「冻住」。
      const tool = blocks(ev.message).find((b) => b.type === 'tool_use');
      if (tool) { cap.activity = toolActivity(tool.name, tool.input); }
      // 主 agent 的整段文本 → 落入 committed（历史保留）。子 agent 文本不进答复。
      if (!isSub) {
        const txt = textOf(ev.message);
        if (txt && ev.uuid !== cap.lastUuid) { cap.committed = cap.committed ? `${cap.committed}\n\n${txt}` : txt; cap.live = ''; cap.lastUuid = ev.uuid; }
      }
      syncTranscript(cap); void ensureStream(cap);
      return;
    }
    if (t === 'result') {
      if (isSub) { cap.activity = '子任务完成，整理结论…'; syncTranscript(cap); return; }   // 子 agent 收尾不结束主回合
      const fallback = typeof ev.result === 'string' ? ev.result : '';
      void finish(cwd, !!ev.subtype && ev.subtype !== 'success', fallback);
      return;
    }
    if (t === 'error') { void finish(cwd, true, ev.error || ''); }
  });
}

/** 把一次提交派发到本地 CLI 会话；监听其流，以流式卡答复回飞书。 */
export async function dispatchSubmission(sub: Submission, form?: SpecForm): Promise<DispatchState> {
  ensureSubscribed();
  const route = form?.route;
  const provider = (route?.provider || 'claude') as ProviderId;
  const cwd = route?.cwd || '';
  const lane = route ? laneFor(route, sub) : 'fbot';
  const key = runKey(cwd, lane);
  const permMode: PermMode | undefined = route?.intent === 'answer' ? 'plan' : route?.permMode;
  const base: DispatchState = { phase: 'pending', ts: Date.now(), cwd, lane, provider };
  states.set(sub.id, base); emit();
  if (!route || route.kind !== 'agent' || !cwd) {
    patch(sub.id, { phase: 'error', error: '未配置工作目录' });
    return states.get(sub.id)!;
  }
  const cap: Capture = { subId: sub.id, replyTo: sub.replyTo, title: form?.title || sub.formTitle, seq: 0, committed: '', live: '' };
  byRunKey.set(key, cap);
  timers.set(key, setTimeout(() => { void finish(key, true); }, 10 * 60_000));
  try {
    const prompt = renderPrompt(route, form, sub.values);
    const apiKey = provider === 'cursor' ? await cursorKey() : undefined;
    const r = await localAgent.send({ provider, cwd, prompt, permMode, lane, apiKey });
    if (!r?.ok) { if (cap.interval) clearInterval(cap.interval); byRunKey.delete(key); const tm = timers.get(key); if (tm) { clearTimeout(tm); timers.delete(key); } patch(sub.id, { phase: 'error', error: '发送失败' }); }
    else patch(sub.id, { phase: 'running' });
  } catch (e: unknown) {
    if (cap.interval) clearInterval(cap.interval); byRunKey.delete(key); const tm = timers.get(key); if (tm) { clearTimeout(tm); timers.delete(key); }
    patch(sub.id, { phase: 'error', error: String((e as Error)?.message || e) });
  }
  return states.get(sub.id)!;
}
