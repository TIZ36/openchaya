/* ------------------------------------------------------------------ *
 * Local Agent —— 「本地 Agent」注册表（把一个会话升格成有身份的常驻角色）。纯本地存 localStorage。
 *
 * 与 sessionBridge 的「会话互问」是同一套召唤内核（askSession），但语义升级：
 *   - 旧：现场 fuzzy 猜一个目标会话来问（无身份、易选错、价值薄）；
 *   - 新：agent = 一个被升格的会话 + 系统提示词 + 能力描述 + 两层记忆。
 *         召唤目标永远来自 agent 绑定（消除选错风险），天然跨 provider。
 *
 * 记忆两层：
 *   1) 续接绑定会话（基线）—— 召唤时 resume agent.sessionId，带其原生 transcript 上下文作答；
 *   2) smartnote-cloud 外置 RAG（可选）—— 配了 memory 就先检索 workspace，把命中片段随问题注入。
 *
 * agent 只能从「现有会话」升格（promotion-only），保证它真有上下文/记忆。
 * 绑定期间底层 session 不可删（守卫在 useLocalAgent.deleteSession）。
 * ------------------------------------------------------------------ */
import type { ProviderId } from './localAgent';

/** agent 的可选外置记忆（smartnote-cloud RAG）。 */
export interface AgentMemory {
  provider: 'smartnote-cloud';
  apiKey?: string;        // 绑定 workspace 的 key（不填则用全局已连的）
  workspaceTag?: string;  // 检索范围
  topK?: number;          // 注入片段数，默认 5
  autoDistill?: boolean;  // 每次回答完把问答存为记忆（默认开）
  autoCalibrate?: boolean; // 闲时基于工作目录自动蒸馏/校准（默认关，待接 LLM 后端）
}

/** 记忆台账（本地，不进配置对象）：上次写入/校准时间 + 计数，给 UI 展示。 */
export interface AgentMemoryLedger {
  lastWriteAt?: number;
  writeCount?: number;
  lastCalibrateAt?: number;
}

export interface LocalAgent {
  id: string;
  name: string;            // @-handle，如 "backend-expert"（头像走名字字母章，不用 emoji）
  description: string;     // 能力摘要 —— 驱动 @ 下拉与联想索引
  tags?: string[];         // 关键词（参与联想匹配）
  systemPrompt?: string;   // 强化提示词，召唤时前置到只读 prompt 头部
  // 绑定（升格而来，promotion-only）
  provider: ProviderId;
  dir: string;             // realDir(绑定会话)，不带 lane 后缀
  sessionId: string;       // 绑定会话 = 记忆来源
  model?: string;
  mcp?: string[];
  memory?: AgentMemory;    // 可选外置记忆
  ledger?: AgentMemoryLedger;  // 记忆写入/校准台账
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

const AGENTS_KEY = 'chaya.localAgent.agents';
export const AGENTS_CHANGED_EVENT = 'chaya:localAgentsChanged';

/* ------------------------------------------------------------------ *
 * Agent 模式开关（全局）：关掉后输入框不再自动分配 agent、不显示联想 chip、@ 也不列 agent，
 *   纯主会话对话。给「agent 模式不稳定时想纯聊」用。默认开；存「off」标记，便于默认即开。
 * ------------------------------------------------------------------ */
const AGENT_MODE_OFF_KEY = 'chaya.localAgent.agentModeOff';
export const AGENT_MODE_EVENT = 'chaya:agentModeChanged';
export function isAgentModeOn(): boolean {
  try { return localStorage.getItem(AGENT_MODE_OFF_KEY) !== '1'; } catch { return true; }
}
export function setAgentModeOn(on: boolean): void {
  try { if (on) localStorage.removeItem(AGENT_MODE_OFF_KEY); else localStorage.setItem(AGENT_MODE_OFF_KEY, '1'); } catch { /* */ }
  try { window.dispatchEvent(new CustomEvent(AGENT_MODE_EVENT)); } catch { /* */ }
}
export function subscribeAgentMode(cb: () => void): () => void {
  const h = () => cb();
  try { window.addEventListener(AGENT_MODE_EVENT, h); window.addEventListener('storage', h); } catch { /* */ }
  return () => { try { window.removeEventListener(AGENT_MODE_EVENT, h); window.removeEventListener('storage', h); } catch { /* */ } };
}

/** 归一 agent 名（@-handle）：去 @/空白，小写，非法字符换连字符。 */
export function normalizeAgentName(raw: string): string {
  return String(raw || '').trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function loadAgents(): LocalAgent[] {
  try {
    const raw = localStorage.getItem(AGENTS_KEY);
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
  } catch { /* ignore */ }
  return [];
}

function persist(list: LocalAgent[]): void {
  try { localStorage.setItem(AGENTS_KEY, JSON.stringify(list)); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT)); } catch { /* non-browser */ }
}

export function listAgents(): LocalAgent[] { return loadAgents(); }
export function getAgent(id: string): LocalAgent | undefined { return loadAgents().find((a) => a.id === id); }

/** 某 sessionId 是否已被某个 agent 绑定（删除守卫用）。返回该 agent 或 undefined。 */
export function agentBySession(sessionId: string | null | undefined): LocalAgent | undefined {
  if (!sessionId) return undefined;
  return loadAgents().find((a) => a.sessionId === sessionId);
}

/** 名字是否已被占用（升格表单去重；可排除自身 id）。 */
export function agentNameTaken(name: string, exceptId?: string): boolean {
  const n = normalizeAgentName(name);
  return loadAgents().some((a) => a.name === n && a.id !== exceptId);
}

/** 新建或更新（按 id；无 id 视为新建）。返回最新列表。 */
export function upsertAgent(a: Partial<LocalAgent> & { name: string; provider: ProviderId; dir: string; sessionId: string }): LocalAgent[] {
  const list = loadAgents();
  const now = Date.now();
  const name = normalizeAgentName(a.name);
  if (a.id) {
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0) {
      list[i] = {
        ...list[i],
        name,
        description: a.description ?? list[i].description,
        tags: a.tags ?? list[i].tags,
        systemPrompt: a.systemPrompt ?? list[i].systemPrompt,
        provider: a.provider, dir: a.dir, sessionId: a.sessionId,
        model: a.model ?? list[i].model,
        mcp: a.mcp ?? list[i].mcp,
        memory: a.memory !== undefined ? a.memory : list[i].memory,
        updatedAt: now,
      };
      persist(list); return list;
    }
  }
  list.unshift({
    id: `agt-${now}-${Math.random().toString(36).slice(2, 6)}`,
    name, description: a.description || '', tags: a.tags,
    systemPrompt: a.systemPrompt, provider: a.provider, dir: a.dir, sessionId: a.sessionId,
    model: a.model, mcp: a.mcp, memory: a.memory,
    createdAt: now, updatedAt: now,
  });
  persist(list);
  return list;
}

/** 换绑会话：把 agent 绑到另一个会话（agent 本身不消失，名/人设/记忆全留）。
 *  约束：一个会话只能被一个 agent 绑定——目标 sessionId 已被别的 agent 绑则拒绝。
 *  sessionId 传空 = 进入「待绑新会话」态（见 setPendingBind），等新会话首轮 init 拿到真实 id 再回填。 */
export function rebindAgent(id: string, bind: { provider: ProviderId; dir: string; sessionId: string }): { ok: boolean; error?: string } {
  const list = loadAgents();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, error: '找不到该 Agent' };
  if (bind.sessionId) {
    const other = list.find((a) => a.id !== id && a.sessionId === bind.sessionId);
    if (other) return { ok: false, error: `该会话已被 @${other.name} 绑定，一个会话只能属于一个 Agent` };
  }
  list[i] = { ...list[i], provider: bind.provider, dir: bind.dir, sessionId: bind.sessionId, updatedAt: Date.now() };
  persist(list);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 待绑（绑定新会话）：agent 选「绑定新会话」时记一个标记 {agentId,dir,provider}，
 *   随后在该目录起一个新会话；其首轮 init 拿到真实 sessionId 时由 useLocalAgent 回填绑定。
 * ------------------------------------------------------------------ */
const PENDING_BIND_KEY = 'chaya.localAgent.pendingBind';
export function setPendingBind(agentId: string, dir: string, provider: ProviderId): void {
  try { localStorage.setItem(PENDING_BIND_KEY, JSON.stringify({ agentId, dir, provider, at: Date.now() })); } catch { /* */ }
}
/** 取走匹配 (dir, provider) 的待绑 agentId（取走即清除）。无匹配返回 null。
 *  dir 比对去掉尾部斜杠，容忍 realDir 归一与 pickFolder 原始路径的差异。 */
export function takePendingBind(dir: string, provider: ProviderId): string | null {
  const norm = (s: string) => String(s || '').replace(/\/+$/, '');
  try {
    const raw = localStorage.getItem(PENDING_BIND_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && norm(p.dir) === norm(dir) && p.provider === provider && p.agentId) {
      localStorage.removeItem(PENDING_BIND_KEY);
      return p.agentId as string;
    }
  } catch { /* */ }
  return null;
}
export function clearPendingBind(): void { try { localStorage.removeItem(PENDING_BIND_KEY); } catch { /* */ } }

/** 解绑/删除 agent（不动底层会话）。 */
export function deleteAgent(id: string): LocalAgent[] {
  const list = loadAgents().filter((a) => a.id !== id);
  persist(list);
  return list;
}

/** 标记最近召唤时间（列表排序用，不强制）。 */
export function touchAgent(id: string): void {
  const list = loadAgents();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], lastUsedAt: Date.now() };
  persist(list);
}

/** 记一次记忆写入（更新台账 ts + 计数）。 */
export function markMemoryWritten(id: string, at = Date.now()): void {
  const list = loadAgents();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return;
  const led = list[i].ledger || {};
  list[i] = { ...list[i], ledger: { ...led, lastWriteAt: at, writeCount: (led.writeCount || 0) + 1 } };
  persist(list);
}

/** 记一次闲时校准（更新台账 ts）。 */
export function markMemoryCalibrated(id: string, at = Date.now()): void {
  const list = loadAgents();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return;
  const led = list[i].ledger || {};
  list[i] = { ...list[i], ledger: { ...led, lastCalibrateAt: at } };
  persist(list);
}

/* ------------------------------------------------------------------ *
 * 召唤前的外置记忆检索（smartnote-cloud RAG）。
 *   memories（smartnoteRetrieve）+ doc chunks（smartnoteChunks.search）并检，
 *   按 workspaceTag 限定范围（tags / dimension `wiki:<tag>`），拼成可注入的片段块。
 * 注：Phase 1 走全局已连的 smartnote 连接 + tag 限定；agent.memory.apiKey
 *     （独立 workspace key）留作后续按需启用。失败/无配置 → 返回 ''（静默降级）。
 * ------------------------------------------------------------------ */
export async function retrieveAgentMemory(agent: LocalAgent, query: string): Promise<string> {
  if (!agent.memory || agent.memory.provider !== 'smartnote-cloud') return '';
  const q = (query || '').trim();
  if (!q) return '';
  const topK = agent.memory.topK ?? 5;
  const tag = agent.memory.workspaceTag?.trim() || undefined;
  try {
    const { smartnoteRetrieve, smartnoteChunks } = await import('../../services/smartnoteApi');
    const [mem, chunks] = await Promise.all([
      smartnoteRetrieve({ query: q, topk: topK, tags: tag ? [tag] : undefined }).catch(() => null),
      smartnoteChunks.search(q, { topk: topK, dimension: tag ? `wiki:${tag}` : undefined }).catch(() => null),
    ]);
    const parts: string[] = [];
    for (const m of (mem?.results || []).slice(0, topK)) {
      if (m.content) parts.push(`- ${String(m.content).slice(0, 500)}`);
    }
    for (const c of (chunks?.results || []).slice(0, topK)) {
      if (c.text) parts.push(`- [${c.document_name}] ${String(c.text).slice(0, 500)}`);
    }
    return parts.slice(0, topK * 2).join('\n');
  } catch { return ''; }
}

/* ------------------------------------------------------------------ *
 * 答完写入记忆（混合策略的「便宜半」）：把一次问答原样存为一条 episode 记忆，
 *   带 workspaceTag + source_refs；created_at 由服务端记 ts（即「记忆 ts」）。
 *   不跑 LLM、不额外花 token。闲时的 LLM 蒸馏/去重/校准（supersedes 替旧）是「贵半」，待接。
 * 返回是否写成功（用于更新本地台账）。无配置 / autoDistill 关 / 答复太短 → 跳过。
 * ------------------------------------------------------------------ */
export async function recordMemoryOnAnswer(agent: LocalAgent, question: string, answer: string): Promise<boolean> {
  if (!agent.memory || agent.memory.provider !== 'smartnote-cloud') return false;
  if (agent.memory.autoDistill === false) return false;
  const q = (question || '').trim();
  const a = (answer || '').trim();
  if (a.length < 24) return false;   // 太短（寒暄/报错）不值得存
  const tag = agent.memory.workspaceTag?.trim();
  try {
    const { smartnoteMemories } = await import('../../services/smartnoteApi');
    await smartnoteMemories.create({
      kind: 'episode',
      content: `【问】${q}\n【答】${a.slice(0, 4000)}`,
      tags: tag ? [tag] : undefined,
      source_refs: [{ kind: 'agent-summon', agent: agent.name, session: agent.sessionId, dir: agent.dir }],
      confidence: 0.5,
    });
    return true;
  } catch { return false; }
}

/** 订阅 agent 列表变化（跨标签/组件同步）。 */
export function subscribeAgents(cb: () => void): () => void {
  const handler = () => cb();
  try { window.addEventListener(AGENTS_CHANGED_EVENT, handler); } catch { /* non-browser */ }
  try { window.addEventListener('storage', handler); } catch { /* non-browser */ }
  return () => {
    try { window.removeEventListener(AGENTS_CHANGED_EVENT, handler); } catch { /* ignore */ }
    try { window.removeEventListener('storage', handler); } catch { /* ignore */ }
  };
}
