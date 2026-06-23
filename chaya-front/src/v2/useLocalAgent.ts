/**
 * 本地 Agent 状态钩子 —— 纯本地，与 Chaya 后端无关。
 *
 * 多标签模型（类浏览器）：每个项目目录(cwd)最多一个打开的会话标签 → 标签以 cwd 为键，
 * 当前激活标签即 activeCwd。每个标签独立保留自己的对话状态（消息/流式/草稿/运行中），
 * 切换标签互不打断，后台流式照常推进（事件按 runId→cwd 路由）。
 *
 * provider 由设置决定；探测惰性触发（进入才 detect）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  localAgent, loadProjects, addProject as addProjectStore, removeProject as removeProjectStore,
  loadTabsState, saveTabsState, loadPermBySession, savePermBySession, loadModelBySession, saveModelBySession,
  loadReasoningBySession, saveReasoningBySession,
  loadMcpBySession, saveMcpBySession, permModesFor, defaultPermMode,
  loadExpandedProjects, saveExpandedProjects, loadCodexImportedSessions,
  type DetectedProvider, type ProviderId, type SessionSummary, type TranscriptMessage, type LocalProject,
  type PermMode, type SlashCommand, type PermissionRequest, type PermissionDecision, type QuestionRequest, type ElicitRequest, type ElicitResult,
  type TabGroup, type ModelInfo, type McpStatus, type Attachment, type UsageInfo,
} from './services/localAgent';
import { loadSkills, expandSkill, syncCliSkills, SKILLS_CHANGED_EVENT, type LocalSkill } from './services/skills';
import { agentBySession } from './services/agents';
import { api } from '../utils/apiClient';
import { TYPEWRITER_PRESETS, DEFAULT_TYPEWRITER, FINISH_DRAIN_SEC, type TypewriterConfig } from './typewriter';
import { useI18n } from '../i18n';

export type SessionsState = Record<string, SessionSummary[] | 'loading'>;

const SESSION_PINS_KEY = 'chaya.localAgent.pinnedSessions';
const SESSION_TITLES_KEY = 'chaya.localAgent.sessionTitles';

/* ------------------------------------------------------------------ *
 * livePreview 外部 store —— 打字机每帧更新的 live 文本【不进 React 全局 state】。
 * 之前它挂在 Tab 上：pump 每帧 patchTab → setTabs 换引用 → 挂在 ClientShell 根部的
 * 整棵外壳树（顶栏/侧栏/评审/检视列…）以 60fps 重渲，多会话并行流式时整个 app 卡。
 * 现在 pump 只写这张 Map 并精准通知订阅了该 cwd 的组件（PaneTimeline），
 * 其余 React 树对打字机出字零感知。
 * ------------------------------------------------------------------ */
const lpText = new Map<string, string>();
const lpListeners = new Map<string, Set<() => void>>();
function lpSet(cwd: string, text: string): void {
  if ((lpText.get(cwd) ?? '') === text) return;
  if (text) lpText.set(cwd, text); else lpText.delete(cwd);
  const ls = lpListeners.get(cwd);
  if (ls) for (const cb of ls) cb();
}
/** 订阅某个 pane 的 live 流式文本（每帧变化只重渲订阅者自己）。 */
export function useLivePreview(cwd: string): string {
  const subscribe = useCallback((cb: () => void) => {
    let s = lpListeners.get(cwd);
    if (!s) { s = new Set(); lpListeners.set(cwd, s); }
    s.add(cb);
    return () => { s!.delete(cb); if (s!.size === 0) lpListeners.delete(cwd); };
  }, [cwd]);
  return useSyncExternalStore(subscribe, () => lpText.get(cwd) ?? '');
}

/* ------------------------------------------------------------------ *
 * composer 草稿外部 store —— 与 livePreview 同款套路：每个键入【不进 tabs】。
 * 之前 draft 挂在 Tab 上：每敲一个字 patchTab → setTabs 换引用 → la 换引用 →
 * 侧栏树（全部项目×会话）+ 顶栏 tab 条 + provider 书签栏 + 各窗格 memo 比较
 * 全部跟着跑一遍 —— 会话/标签一多输入框就卡。现在键入只写这张 Map 并精准
 * 通知订阅了该 cwd 的 composer（即所在窗格），其余 React 树对打字零感知。
 * ------------------------------------------------------------------ */
const draftText = new Map<string, string>();
const draftListeners = new Map<string, Set<() => void>>();
/** 读某窗格当前草稿（非 hook，事件处理器里用，永不 stale）。 */
export function getDraft(cwd: string): string { return draftText.get(cwd) ?? ''; }
function draftSet(cwd: string, v: string): void {
  if ((draftText.get(cwd) ?? '') === v) return;
  if (v) draftText.set(cwd, v); else draftText.delete(cwd);
  const ls = draftListeners.get(cwd);
  if (ls) for (const cb of ls) cb();
}
/** 订阅某窗格的草稿（键入只重渲订阅者自己 —— 即该窗格）。 */
export function useDraft(cwd: string): string {
  const subscribe = useCallback((cb: () => void) => {
    let s = draftListeners.get(cwd);
    if (!s) { s = new Set(); draftListeners.set(cwd, s); }
    s.add(cb);
    return () => { s!.delete(cb); if (s!.size === 0) draftListeners.delete(cwd); };
  }, [cwd]);
  return useSyncExternalStore(subscribe, () => draftText.get(cwd) ?? '');
}

/** 一个打开的标签（= 一个项目的当前会话），自带完整对话状态。 */
export interface Tab {
  cwd: string;
  sessionId: string | null;     // null = 尚未落盘的新会话
  title: string;
  messages: TranscriptMessage[];
  liveMsgs: TranscriptMessage[];
  status: string;
  running: boolean;
  loading: boolean;
  pendingLoad?: boolean;   // 从持久化恢复、尚未读盘载入的标签
  perm?: PermissionRequest | null;   // agent 正在等用户授权/选择
  question?: QuestionRequest | null; // agent 用 AskUserQuestion 抛来的选择题
  elicit?: ElicitRequest | null;     // MCP 服务端 elicitation/create 等用户填表/授权
  color: string;           // 偏好色（自动分配）：用于窗格头部/头像/边框
  groupId?: string | null; // 所属标签分组（类 Chrome 标签组），null = 未分组
  permMode: PermMode;      // 每个会话独立的权限模式（切一个不影响其他）
  provider: ProviderId;    // 每个会话自带的执行器（不同 provider 可并行跑、各自计数）
  model?: string;          // 每个会话选用的模型（空 = provider 默认）
  reasoning?: string;      // Codex 思考强度（空 = Codex 默认）
  skill?: string;          // 选中的 Chaya 技能名（composer pill；发送时用它包裹 draft 后展开）
  histMore?: number;       // 历史窗口化：还有多少条更早的消息没进时间线（藏在 histRef，上滑懒加载）
  mcp?: string[];          // 该会话启用的 MCP server 名字（空 = 不启用）
  mcpStatus?: McpStatus[]; // MCP 连接状态（来自 init / setMcp 回执）
  attachments?: Attachment[]; // 待发送的参考附件（拖入/选取的文件 + 粘贴图片），发送后清空
  queue?: QueuedMsg[];        // AI 处理中时用户继续发的指令：本轮结束后自动打包成一轮发出
  plan?: PlanUsage;           // 订阅额度占用（claude /usage 解析）：当前会话/周用了百分之多少
}

/** 订阅计划额度占用（对应 claude `/usage`）：百分比 0..100。 */
export type PlanUsage = UsageInfo;

/** 队列里的一条待发指令（在 AI 处理中入队，本轮收尾后与同队其它条目打包成一轮）。 */
export interface QueuedMsg {
  id: string;
  text: string;
  attachments: Attachment[];
}

// 自动分配的窗格 / 分组色板（沉静、互相可辨；非强饱和，贴合 letterpress 调性）。
export const TAB_COLORS = ['#c2562f', '#4f46e5', '#3a8a6e', '#b05a7a', '#b8862f', '#5e8bd0', '#8a6fc0', '#3f8e8a'];
let _colorSeq = 0;
function nextColor(): string { return TAB_COLORS[_colorSeq++ % TAB_COLORS.length]; }

function emptyTab(cwd: string, sessionId: string | null, title: string, color?: string, permMode: PermMode = 'default', provider: ProviderId = 'claude'): Tab {
  return { cwd, sessionId, title, color: color || nextColor(), messages: [], liveMsgs: [], status: '', running: false, loading: false, permMode, provider };
}

function normalizePermissionShortcut(text: string): 'allow' | 'deny' | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (['可以', '允许', '同意', '批准', '确认', '好', 'ok', 'okay', 'yes', 'y', 'allow', 'approve'].includes(s)) return 'allow';
  if (['不可以', '拒绝', '取消', '否', '不要', 'no', 'n', 'deny', 'reject', 'cancel'].includes(s)) return 'deny';
  return null;
}

/* ------------------------------------------------------------------ *
 * 分屏布局树（类 Wave）：叶子 = 一个会话窗格(cwd)；split = 把空间一分为二。
 *   dir='row' → 左右分（竖直分隔线）；dir='col' → 上下分（水平分隔线）。
 *   ratio = 第一格(a)占的比例。拖标签到某窗格即把该叶子替换为 split。
 * ------------------------------------------------------------------ */
export type SplitDir = 'row' | 'col';
export type DropSide = 'left' | 'right' | 'top' | 'bottom';
export type LayoutNode =
  | { kind: 'leaf'; cwd: string }
  | { kind: 'split'; id: string; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

let _splitSeq = 0;
function mkSplit(dir: SplitDir, a: LayoutNode, b: LayoutNode): LayoutNode {
  return { kind: 'split', id: `sp-${Date.now()}-${++_splitSeq}`, dir, ratio: 0.5, a, b };
}
/** 恢复时裁掉布局树里已不存在的叶子（cwd 不在打开标签中）；空了返回 null。 */
// 异类叶子（非 CLI cwd）：约定用前缀编码 id —— `wiki` / `chat:<sessionId>`。它们由
// ClientShell 通过 ForeignPaneContext 渲染，对 CLI 的 tabs/warm/readSession 等逻辑「透明」
// （不进 tabs、不触发本地进程），从而把不同类型页装进同一分屏而不拖垮性能。
export const isForeignLeaf = (id: string): boolean => id === 'wiki' || id.startsWith('chat:');

function pruneLayout(n: LayoutNode, valid: Set<string>): LayoutNode | null {
  if (n.kind === 'leaf') return (valid.has(n.cwd) || isForeignLeaf(n.cwd)) ? n : null;
  const a = pruneLayout(n.a, valid);
  const b = pruneLayout(n.b, valid);
  if (!a) return b;
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}
function leavesOf(n: LayoutNode | null): string[] {
  if (!n) return [];
  return n.kind === 'leaf' ? [n.cwd] : [...leavesOf(n.a), ...leavesOf(n.b)];
}
function hasLeaf(n: LayoutNode | null, cwd: string): boolean {
  return leavesOf(n).includes(cwd);
}
function removeLeaf(n: LayoutNode, cwd: string): LayoutNode | null {
  if (n.kind === 'leaf') return n.cwd === cwd ? null : n;
  const a = removeLeaf(n.a, cwd);
  const b = removeLeaf(n.b, cwd);
  if (!a) return b;            // 一侧空了 → 另一侧顶替（塌缩）
  if (!b) return a;
  return a === n.a && b === n.b ? n : { ...n, a, b };
}
/** 把 targetCwd 叶子替换为 split：新窗格按 before 落在前半(a)或后半(b)。 */
function splitLeafSide(n: LayoutNode, targetCwd: string, newCwd: string, dir: SplitDir, before: boolean): LayoutNode {
  if (n.kind === 'leaf') {
    if (n.cwd !== targetCwd) return n;
    const fresh: LayoutNode = { kind: 'leaf', cwd: newCwd };
    return before ? mkSplit(dir, fresh, n) : mkSplit(dir, n, fresh);
  }
  return { ...n, a: splitLeafSide(n.a, targetCwd, newCwd, dir, before), b: splitLeafSide(n.b, targetCwd, newCwd, dir, before) };
}
function setRatioById(n: LayoutNode, id: string, ratio: number): LayoutNode {
  if (n.kind === 'leaf') return n;
  if (n.id === id) return { ...n, ratio };
  return { ...n, a: setRatioById(n.a, id, ratio), b: setRatioById(n.b, id, ratio) };
}

/** 把同组标签聚拢成连续区段（类 Chrome：组员相邻），锚定在该组首个成员的位置。 */
function clusterTabs(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  const out: Tab[] = [];
  for (const t of tabs) {
    if (seen.has(t.cwd)) continue;
    if (t.groupId) {
      for (const m of tabs) if (m.groupId === t.groupId && !seen.has(m.cwd)) { out.push(m); seen.add(m.cwd); }
    } else { out.push(t); seen.add(t.cwd); }
  }
  return out;
}

/** 单个标签的流式平滑状态（打字机进度）。 */
interface Smooth {
  raw: string;                    // 真实累积文本（token 突发到达写这里）
  shown: number;                  // 已写进 livePreview 的字符数（整数）
  disp: number;                   // 浮点显示进度，支持亚字符匀速累积
  rate: number;                   // 当前速率（字符/秒），保持匀速
  evalAt: number;                 // 上次速率评估时刻（performance.now）
  finalize: (() => void) | null;  // 排空后执行的收尾（合并最终消息块）
}

// 首屏只渲染尾部 N 条历史，余量后台补齐（见 setHistory）。
const HISTORY_TAIL = 20;
// 进 DOM 的消息条数硬上限。每条完成的回合都 append 进 tab.messages，长会话（跑一两小时、
// 几百回合）若不重新窗口化，消息只增不减——而 DOM 节点活在 Blink 的 cppgc/Oilpan 堆里，
// 最终单次大分配「Ran out of reservation」崩渲染进程（且 JS 堆很小，正是这种崩法）。
// 超过这个数就把最旧的折进 histRef（上滑「加载更早」仍可取回），DOM 始终有界。
const RENDER_TAIL_MAX = 60;

/* ------------------------------------------------------------------ *
 * paneKey：一个窗格(标签)的唯一身份。主会话 paneKey = 项目目录(cwd) 本身；
 * 同一目录的额外会话(分屏/衍生) paneKey = `${dir}${PANE_SEP}${laneId}`。
 * PANE_SEP 用 '#@#'（真实路径几乎不可能含它），与主进程 runKey 分隔一致 → 事件路由零解析。
 *   realDir(paneKey) = 真实工作目录（传 SDK / 列会话 / 关联项目用）
 *   paneLane(paneKey) = 车道 id（undefined = 主会话）
 * 全 app 仍按 paneKey(cwd) 寻址 tab/布局/拖拽；只在调用 localAgent 时翻译成 (dir, lane)。
 * ------------------------------------------------------------------ */
const PANE_SEP = '#@#';
export const realDir = (paneKey: string): string => { const i = paneKey.indexOf(PANE_SEP); return i < 0 ? paneKey : paneKey.slice(0, i); };
export const paneLane = (paneKey: string): string | undefined => { const i = paneKey.indexOf(PANE_SEP); return i < 0 ? undefined : paneKey.slice(i + PANE_SEP.length); };
export const makePaneKey = (dir: string, lane: string): string => `${dir}${PANE_SEP}${lane}`;
let _paneSeq = 0;
const nextLaneId = (): string => `p${Date.now().toString(36)}${(_paneSeq++).toString(36)}`;

// 合并探测结果（按 id 覆盖），保持稳定顺序 —— 当前 provider 先到、其余空闲补齐时不闪。
const PROVIDER_ORDER: ProviderId[] = ['claude', 'cursor', 'codex', 'gemini', 'copilot'];
function mergeProviders(prev: DetectedProvider[], next: DetectedProvider[]): DetectedProvider[] {
  const map = new Map<string, DetectedProvider>(prev.map((p) => [p.id, p]));
  for (const p of next) map.set(p.id, p);
  return PROVIDER_ORDER.map((id) => map.get(id)).filter(Boolean) as DetectedProvider[];
}

export function useLocalAgent(active: boolean, provider: ProviderId, typewriter: TypewriterConfig = DEFAULT_TYPEWRITER) {
  const { t: tr } = useI18n();
  // Live typewriter config (toggle + speed) read by the rAF pump without re-binding it.
  const twRef = useRef<TypewriterConfig>(typewriter);
  twRef.current = typewriter;

  const [providers, setProviders] = useState<DetectedProvider[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelInfo[]>([]);   // 可选模型（SDK supportedModels）
  const [modelsLoading, setModelsLoading] = useState(false);           // 正在动态探测可选模型（探测较慢，给按钮 loading 态）

  const [projects, setProjects] = useState<LocalProject[]>(() => loadProjects());
  useEffect(() => {
    const onProjectsChanged = () => setProjects(loadProjects());
    window.addEventListener('chaya:localAgentProjectsChanged', onProjectsChanged);
    return () => window.removeEventListener('chaya:localAgentProjectsChanged', onProjectsChanged);
  }, []);
  // Chaya 技能（provider 无关）：发送前展开 /命令；斜杠菜单也并入。变化即重载。
  const [skills, setSkills] = useState<LocalSkill[]>(() => loadSkills());
  const skillsRef = useRef<LocalSkill[]>(skills);
  skillsRef.current = skills;
  useEffect(() => {
    const onSkillsChanged = () => setSkills(loadSkills());
    window.addEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
    return () => window.removeEventListener(SKILLS_CHANGED_EVENT, onSkillsChanged);
  }, []);
  // Unified Skill Hub：自动把各家 CLI 装的技能导入进来（挂载 + 重新聚焦，30s 节流）。
  useEffect(() => {
    let last = 0;
    const sync = () => {
      const now = Date.now();
      if (now - last < 30_000) return;
      last = now;
      void syncCliSkills();
    };
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);
  const [codexImportsTick, setCodexImportsTick] = useState(0);
  useEffect(() => {
    const onImportsChanged = () => setCodexImportsTick((n) => n + 1);
    window.addEventListener('chaya:localAgentCodexImportsChanged', onImportsChanged);
    return () => window.removeEventListener('chaya:localAgentCodexImportsChanged', onImportsChanged);
  }, []);
  // 展开的项目目录：从持久化恢复（下次启动不用重新点开）；变化即回存。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadExpandedProjects()));
  useEffect(() => { saveExpandedProjects([...expanded]); }, [expanded]);
  const [sessionsByPath, setSessionsByPath] = useState<SessionsState>({});
  // 同步 ref：回调里读「某目录是否已加载」而不进 deps（避免回环）。
  const sessionsByPathRef = useRef(sessionsByPath);
  sessionsByPathRef.current = sessionsByPath;
  // 稳定排序：记住每个目录的会话显示顺序(sessionId[])，重新拉取时保持原序、新会话置顶 —— 用某会话
  // 不会让它跳位（修「点击/使用后重排序」）。
  const sessionOrderRef = useRef<Record<string, string[]>>({});
  // 乐观会话：新会话首轮 init 拿到真实 id 即插进左栏（不等 CLI 把 .jsonl 落盘）。dir → (sessionId → 占位标题)。
  // 读盘后若该 id 已出现就退役；否则继续随每次 loadSessionsFor 合并显示，杜绝「回答中却不在左栏」。
  const optimisticRef = useRef<Map<string, Map<string, string>>>(new Map());
  // 会话 pin：sessionId → pinnedAt(ms)。pin 的排在工作目录顶部，后 pin 的更靠上。纯本地持久化。
  const [pinnedSessions, setPinnedSessions] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(SESSION_PINS_KEY) || '{}') || {}; } catch { return {}; }
  });
  const toggleSessionPin = useCallback((sid: string) => {
    setPinnedSessions((prev) => {
      const next = { ...prev };
      if (next[sid]) delete next[sid]; else next[sid] = Date.now();
      try { localStorage.setItem(SESSION_PINS_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);
  // 会话自定义显示名（覆盖后端自动标题）：sessionId → title。空 = 清除覆盖、回到自动标题。纯本地持久化。
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(SESSION_TITLES_KEY) || '{}') || {}; } catch { return {}; }
  });
  const renameSession = useCallback((sid: string, title: string) => {
    if (!sid) return;
    setSessionTitles((prev) => {
      const next = { ...prev };
      const t = (title || '').trim();
      if (t) next[sid] = t; else delete next[sid];
      try { localStorage.setItem(SESSION_TITLES_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);

  // 启动即从持久化恢复 —— 放进 useState 初始值，首帧就正确。
  // 不再用 effect 恢复：那会与 reconciliation 副作用（prune/auto-group/layout-cleanup）
  // 及 StrictMode 的双跑竞态，把分组/分屏在恢复后又冲掉。
  const [boot] = useState(() => {
    const { tabs: s, activeCwd: a, groups: g, layout: l } = loadTabsState();
    const gidSet = new Set(g.map((x) => x.id));
    const modelMem = loadModelBySession();
    const reasoningMem = loadReasoningBySession();
    const mcpMem = loadMcpBySession();
    // 恢复的标签各自带 provider（老数据无 provider 字段 → 回退到当前默认 provider）：
    // 把不属于该 tab provider 档位集的权限模式归一到其默认（如 cursor 不认 default/acceptEdits
    // → 落到 force；避免显示/行为串档）。
    const t: Tab[] = s.map((x) => {
      const rp = (x.provider as ProviderId) || provider;
      const okPerm = permModesFor(rp);
      return { ...emptyTab(x.cwd, x.sessionId, x.title, undefined, defaultPermMode(rp), rp), groupId: (x.groupId && gidSet.has(x.groupId)) ? x.groupId : null, permMode: (x.permMode && okPerm.includes(x.permMode)) ? x.permMode : defaultPermMode(rp), provider: rp, model: (x.sessionId && modelMem[x.sessionId]) || undefined, reasoning: (x.sessionId && reasoningMem[x.sessionId]) || undefined, mcp: (x.sessionId && mcpMem[x.sessionId]) || undefined, pendingLoad: !!x.sessionId };
    });
    const valid = new Set(t.map((x) => x.cwd));
    let lay: LayoutNode | null = null;
    if (l) { const pruned = pruneLayout(l as LayoutNode, valid); if (pruned && pruned.kind === 'split') lay = pruned; }
    const active = a && t.some((x) => x.cwd === a) ? a : (t.length ? t[t.length - 1].cwd : null);
    return { tabs: clusterTabs(t), activeCwd: active, groups: g, layout: lay };
  });

  // 多标签：每个 cwd 一个标签；activeCwd 是当前激活标签。
  const [tabs, setTabs] = useState<Tab[]>(boot.tabs);
  // 永不 stale 的 tabs 快照：供事件处理器 / paneKey 分配等「在渲染之外」读取当前标签集。
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeCwd, setActiveCwd] = useState<string | null>(boot.activeCwd);
  // 「发送」信号：用户真正发出一条消息时 bump（tick + cwd）。点击 tab 不再置左 —— 只有发起提问
  // 才把该会话提到 tab 栏最左（见 send 里的 promoteTab + ClientShell 监听 lastSend 提 topTab）。
  const [sendTick, setSendTick] = useState(0);
  const lastSentCwdRef = useRef<string | null>(null);
  const [groups, setGroups] = useState<TabGroup[]>(boot.groups);   // 标签分组（类 Chrome）
  const [layout, setLayout] = useState<LayoutNode | null>(boot.layout);   // 分屏树（null = 单窗）

  // cwd → 本回合的 session_id（init/result 捕获，回合结束写回标签）。常驻会话按 cwd 路由事件。
  const pendingByCwd = useRef<Map<string, string>>(new Map());
  const detectedRef = useRef(false);
  const permMemRef = useRef<Record<string, PermMode>>(loadPermBySession());   // sessionId → 上次发送时的权限级别
  const modelMemRef = useRef<Record<string, string>>(loadModelBySession());   // sessionId → 选用的模型
  const reasoningMemRef = useRef<Record<string, string>>(loadReasoningBySession()); // sessionId → Codex 思考强度
  const mcpMemRef = useRef<Record<string, string[]>>(loadMcpBySession());      // sessionId → 启用的 MCP
  // 事件处理函数放 ref，订阅一次也总调用最新闭包（避免 provider/projects 变了仍用旧的）。
  const handleEventRef = useRef<(cwd: string, ev: any) => void>(() => {});

  // cursor headless 必需的 API Key（从后端凭据拉到、随 send/warm 注入主进程）。按需缓存。
  const cursorKeyRef = useRef<string | null>(null);
  const fetchCursorKey = useCallback(async (): Promise<string | null> => {
    if (cursorKeyRef.current) return cursorKeyRef.current;
    try {
      const r = await api.get<{ api_key?: string }>('/api/local-agent/credentials/cursor/api-key');
      cursorKeyRef.current = r?.api_key || null;
    } catch { cursorKeyRef.current = null; }
    return cursorKeyRef.current;
  }, []);

  const activeTab = tabs.find((t) => t.cwd === activeCwd) || null;
  // 上下文 provider：跟随当前激活标签自带的执行器（无标签时回退到设置默认）。
  // 全局 UI（模型/斜杠/会话树/就绪态）都看 activeProvider；per-tab 操作各看 tab.provider。
  const activeProvider: ProviderId = activeTab?.provider ?? provider;
  const current = providers.find((p) => p.id === activeProvider);
  const activeProject = projects.find((p) => p.path === realDir(activeCwd || '')) || null;
  // 每个 provider 当前有几条会话在跑（rail 各自计数；架构上多 provider 可并行）。
  const runningByProvider = useMemo(() => {
    const m: Partial<Record<ProviderId, number>> = {};
    for (const t of tabs) if (t.running) m[t.provider] = (m[t.provider] || 0) + 1;
    return m;
  }, [tabs]);
  // 每个 provider 有几条会话在等用户介入（权限审批 / AskUserQuestion）→ rail 跳跃提示。
  const attnByProvider = useMemo(() => {
    const m: Partial<Record<ProviderId, number>> = {};
    for (const t of tabs) if (t.perm || t.question || t.elicit) m[t.provider] = (m[t.provider] || 0) + 1;
    return m;
  }, [tabs]);
  // 「完成」标：某 provider 的运行数从 >0 落到 0 且当前不在该 provider → 书签显打勾，访问即清。
  const [doneByProvider, setDoneByProvider] = useState<Partial<Record<ProviderId, boolean>>>({});
  const prevRunRef = useRef<Partial<Record<ProviderId, number>>>({});
  useEffect(() => {
    const prev = prevRunRef.current;
    const keys = new Set<string>([...Object.keys(prev), ...Object.keys(runningByProvider)]);
    setDoneByProvider((d) => {
      let next = d;
      for (const k of keys) {
        const p = k as ProviderId;
        const was = prev[p] ?? 0;
        const now = runningByProvider[p] ?? 0;
        if (was > 0 && now === 0 && p !== activeProvider && !next[p]) next = { ...next, [p]: true };
        else if (now > 0 && next[p]) next = { ...next, [p]: false };   // 又开始跑 → 清完成标
      }
      return next;
    });
    prevRunRef.current = { ...runningByProvider };
  }, [runningByProvider, activeProvider]);
  // 访问某 provider（成为 activeProvider）即清它的「完成」标。
  useEffect(() => {
    setDoneByProvider((d) => (d[activeProvider] ? { ...d, [activeProvider]: false } : d));
  }, [activeProvider]);

  /** 按 cwd 局部更新某标签。 */
  const patchTab = useCallback((cwd: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)) => {
    setTabs((ts) => ts.map((t) => (t.cwd === cwd ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));
  }, []);

  /* ---- 流式平滑（打字机）：原始 token 突发到达，这里以「自适应但保持几秒匀速」的
     速率把每个标签的 livePreview 逐字逼近真实文本，做到非常丝滑。
     - 速率每 HOLD_MS 评估一次（= 当前积压 / DRAIN_SEC），其间固定匀速，不逐帧抖动；
       生成稳定时显示速率会收敛到生成速率（看起来就是匀速跟着生成走）。
     - 收尾（assistant 事件）延迟到吐完再合并最终块，避免“突然蹦出整段”的跳变。 ---- */
  const smoothRef = useRef<Map<string, Smooth>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  const pump = useCallback(() => {
    const now = performance.now();
    if (lastFrameRef.current === 0) lastFrameRef.current = now;
    const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000); // 切后台/卡顿后别一次跳太多
    lastFrameRef.current = now;

    const tw = twRef.current;
    const P = TYPEWRITER_PRESETS[tw.speed] || TYPEWRITER_PRESETS.normal;
    const map = smoothRef.current;
    for (const [cwd, sm] of map) {
      if (!tw.enabled) sm.disp = sm.raw.length; // 关闭 → 到达即显示（旧行为）
      const target = sm.raw.length;
      const finalizing = sm.finalize != null;
      const backlog = target - sm.disp;
      // 速率评估：保持匀速 holdMs；收尾时每帧重算以快速平滑吐完。
      if (sm.rate === 0 || finalizing || now - sm.evalAt >= P.holdMs) {
        const drain = finalizing ? FINISH_DRAIN_SEC : P.drainSec;
        let r = backlog > 0 ? backlog / drain : 0;
        if (r > 0) r = Math.max(P.minRate, Math.min(P.maxRate, r));
        sm.rate = r;
        sm.evalAt = now;
      }
      if (backlog > 0 && sm.rate > 0) sm.disp = Math.min(target, sm.disp + sm.rate * dt);

      const nextShown = Math.floor(sm.disp);
      if (nextShown !== sm.shown) {
        sm.shown = nextShown;
        lpSet(cwd, sm.raw.slice(0, nextShown));   // 外部 store：只重渲订阅了该 cwd 的时间线
      }
      if (sm.disp >= target && sm.finalize) {
        const fn = sm.finalize;
        map.delete(cwd);
        fn(); // 吐完才把最终消息块合并进来 —— 文字一致，无跳变
      }
    }

    let alive = false;
    for (const sm of map.values()) { if (sm.disp < sm.raw.length || sm.finalize) { alive = true; break; } }
    if (alive) rafRef.current = requestAnimationFrame(pump);
    else { rafRef.current = null; lastFrameRef.current = 0; }
  }, []);

  const ensurePump = useCallback(() => {
    if (rafRef.current == null) { lastFrameRef.current = 0; rafRef.current = requestAnimationFrame(pump); }
  }, [pump]);

  /* ---- 重连对账：进入 / 渲染进程重载后，向主进程查「仍在跑回合的会话(busyKeys)」，
   *      把对应标签的 running 点亮回来。渲染重载会丢内存里的 running，但后端进程还活着，
   *      busyKeys 是权威。只点亮、不强制熄灭（熄灭交给 result/session_closed 事件）。 ---- */
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void localAgent.busyKeys().then((keys) => {
      if (!alive || !Array.isArray(keys) || !keys.length) return;
      const busy = new Set(keys);
      setTabs((ts) => {
        if (!ts.some((t) => busy.has(t.cwd) && !t.running)) return ts;
        return ts.map((t) => (busy.has(t.cwd) && !t.running ? { ...t, running: true, status: t.status || tr('local.status.processing') } : t));
      });
    });
    return () => { alive = false; };
  }, [active, tr]);

  const feedSmooth = useCallback((cwd: string, delta: string) => {
    let sm = smoothRef.current.get(cwd);
    if (!sm) { sm = { raw: '', shown: 0, disp: 0, rate: 0, evalAt: 0, finalize: null }; smoothRef.current.set(cwd, sm); }
    sm.raw += delta;
    if (!twRef.current.enabled) {
      // 关闭平滑 → 到达即显示，不经 rAF 限速（等同旧的逐 chunk 渲染）。
      sm.disp = sm.raw.length; sm.shown = sm.raw.length;
      lpSet(cwd, sm.raw);
      return;
    }
    ensurePump();
  }, [ensurePump]);

  const dropSmooth = useCallback((cwd: string) => { smoothRef.current.delete(cwd); lpSet(cwd, ''); }, []);

  // 卸载时停掉 rAF。
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  /* ---- 惰性探测：先只探当前 provider（冷启快），其余空闲时补齐 ---- */
  useEffect(() => {
    if (!active || detectedRef.current) return;
    detectedRef.current = true;
    setDetecting(true);
    localAgent.detect(activeProvider).then((cur) => {
      setProviders((prev) => mergeProviders(prev, cur));
      setDetecting(false);
      const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
      const idle = w.requestIdleCallback ? (cb: () => void) => w.requestIdleCallback!(cb, { timeout: 1500 }) : (cb: () => void) => setTimeout(cb, 400);
      idle(() => { localAgent.detect().then((all) => setProviders((prev) => mergeProviders(prev, all))); });
    }).catch(() => setDetecting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* ---- 斜杠命令：进入即加载（无项目用 home），随激活项目/ provider 重取 ---- */
  useEffect(() => {
    if (!active) return;
    let alive = true;
    localAgent.listCommands(activeProvider, realDir(activeCwd || '')).then((c) => { if (alive) setCommands(c); });
    return () => { alive = false; };
  }, [active, activeCwd, activeProvider]);

  /* ---- cursor：进入即预拉 API Key（让随后的 warm/send 同步拿到，少一跳） ---- */
  useEffect(() => {
    if (active && activeProvider === 'cursor') void fetchCursorKey();
  }, [active, activeProvider, fetchCursorKey]);

  /* ---- 模型列表：进入 / 切 provider 即主动探测（不必先发消息）。探测较慢（claude 起一次性
   *      SDK query；copilot/gemini 起 ACP 连接），期间给按钮 loading 态。会话启动后的
   *      ev.models 事件仍会覆盖刷新成该会话真实模型。登录完成后也可手动 refreshModels()。 ---- */
  const modelsReqRef = useRef(0);
  const refreshModels = useCallback(() => {
    if (!current?.live) return Promise.resolve();
    const tok = ++modelsReqRef.current;
    setModelsLoading(true);
    const apiKey = activeProvider === 'cursor' ? cursorKeyRef.current : undefined;
    return localAgent.listModels(activeProvider, apiKey)
      .then((ms) => { if (tok === modelsReqRef.current && Array.isArray(ms) && ms.length) setModelOptions(ms); })
      .finally(() => { if (tok === modelsReqRef.current) setModelsLoading(false); });
  }, [activeProvider, current?.live]);
  useEffect(() => {
    if (!active || !current?.live) return;
    setModelOptions([]);
    void refreshModels();
  }, [active, refreshModels]);

  /* ---- 上下文 provider 切换（切到不同执行器的标签 / 改默认）：仅刷新「会话浏览树」
   *      使其显示新 provider 的可续接会话；绝不关已开标签的常驻进程、不清空标签 —— 不同
   *      provider 的会话各自并行跑、各自计数（多 provider 并发的关键）。 ---- */
  const prevProviderRef = useRef(activeProvider);
  useEffect(() => {
    if (prevProviderRef.current === activeProvider) return;
    prevProviderRef.current = activeProvider;
    cursorKeyRef.current = null;   // 换 provider → 失效缓存的 cursor key（再进 cursor 重拉）
    // 预热的「待衍生」会话是按旧 provider 起的，关掉它们（不影响已开的真实标签）。
    for (const [d, l] of specLaneRef.current) void localAgent.sessionClose(d, l);
    specLaneRef.current.clear();
    // 清空会话浏览树 → 下方 active-load 副作用按新 activeProvider 重新懒加载当前项目目录。
    // 项目目录 + 展开记忆跨 provider 保留；已开标签 / 分屏布局保留不动。
    setSessionsByPath({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider]);

  // 每个会话独立切档：只改这个标签的 permMode，不动其他会话。按 provider 的档位集循环
  // （claude: default/plan/acceptEdits/bypass；cursor: plan/ask/force）。
  const cyclePermMode = useCallback((cwd: string) => {
    setTabs((ts) => ts.map((t) => {
      if (t.cwd !== cwd) return t;
      const list = permModesFor(t.provider);   // 按该标签自带 provider 的档位集循环
      const i = list.indexOf(t.permMode);
      const next = i < 0 ? defaultPermMode(t.provider) : list[(i + 1) % list.length];   // 当前档不属于该 provider → 回默认档
      void localAgent.setPermMode(realDir(cwd), next, paneLane(cwd));   // 进行中的常驻会话即时切档
      return { ...t, permMode: next };
    }));
  }, []);

  // 选模型（/model 等价）：实时切——常驻会话即刻 setModel 生效；它注入的「Set model to …」
  // 回显被渲染层过滤掉，不进对话。空 = provider 默认。按会话记忆。
  const setModel = useCallback((cwd: string, model: string) => {
    void localAgent.setModel(realDir(cwd), model, paneLane(cwd));
    patchTab(cwd, { model: model || undefined });
    const sid = pendingByCwd.current.get(cwd) || tabs.find((t) => t.cwd === cwd)?.sessionId;
    if (sid) { if (model) modelMemRef.current[sid] = model; else delete modelMemRef.current[sid]; saveModelBySession(modelMemRef.current); }
  }, [tabs, patchTab]);

  const setReasoning = useCallback((cwd: string, reasoning: string) => {
    void localAgent.setReasoning(realDir(cwd), reasoning, paneLane(cwd));
    patchTab(cwd, { reasoning: reasoning || undefined });
    const sid = pendingByCwd.current.get(cwd) || tabs.find((t) => t.cwd === cwd)?.sessionId;
    if (sid) { if (reasoning) reasoningMemRef.current[sid] = reasoning; else delete reasoningMemRef.current[sid]; saveReasoningBySession(reasoningMemRef.current); }
  }, [tabs, patchTab]);

  // 启用/停用某 cwd 的 MCP server（/mcp 等价）：实时 setMcpServers + 记忆 + 回执状态。
  const setMcp = useCallback((cwd: string, names: string[]) => {
    patchTab(cwd, { mcp: names });
    const sid = pendingByCwd.current.get(cwd) || tabs.find((t) => t.cwd === cwd)?.sessionId;
    if (sid) { if (names.length) mcpMemRef.current[sid] = names; else delete mcpMemRef.current[sid]; saveMcpBySession(mcpMemRef.current); }
    void localAgent.setMcp(realDir(cwd), names, paneLane(cwd)).then((r) => { if (r && Array.isArray(r.servers)) patchTab(cwd, { mcpStatus: r.servers }); });
  }, [tabs, patchTab]);
  const listMcp = useCallback((cwd: string) => localAgent.listMcp(cwd), []);
  // 探测 MCP 状态；重连不通的 server。
  const refreshMcp = useCallback((cwd: string) => {
    void localAgent.mcpStatus(realDir(cwd), paneLane(cwd)).then((r) => { if (r && Array.isArray(r.servers)) patchTab(cwd, { mcpStatus: r.servers }); });
  }, [patchTab]);
  const reconnectMcp = useCallback((cwd: string, name: string) => {
    void localAgent.reconnectMcp(realDir(cwd), name, paneLane(cwd)).then((r) => { if (r && Array.isArray(r.servers)) patchTab(cwd, { mcpStatus: r.servers }); });
  }, [patchTab]);

  /* ---- 实时事件订阅（常驻会话按 cwd 路由到对应标签） ---- */
  useEffect(() => {
    const off = localAgent.onEvent(({ cwd, ev }) => handleEventRef.current(cwd, ev));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSessionsFor = useCallback(async (path: string) => {
    const dir = realDir(path);
    // 仅「首次加载」（还没有任何列表）才显示 loading 呼吸点；已有列表时静默重拉、就地替换，
    // 工程目录从不闪烁（修「刷新一下就闪 loading」）。
    if (!Array.isArray(sessionsByPathRef.current[dir])) setSessionsByPath((m) => ({ ...m, [dir]: 'loading' }));
    let ss = await localAgent.listSessions(activeProvider, dir);
    if (activeProvider === 'codex') {
      const imported = loadCodexImportedSessions()[dir];
      if (imported && imported.length) {
        const allow = new Set(imported);
        ss = ss.filter((s) => allow.has(s.sessionId));
      }
    }
    // 合并仍未落盘的「乐观会话」（新会话拿到 id 即插，避免读盘延迟导致左栏缺失）；
    // 读盘已含的同 id 占位即退役。
    const opt = optimisticRef.current.get(dir);
    if (opt && opt.size) {
      const have = new Set(ss.map((s) => s.sessionId));
      for (const id of [...opt.keys()]) if (have.has(id)) opt.delete(id);
      for (const [id, title] of opt) ss = [{ sessionId: id, title, preview: null, turns: 0, updatedAt: Date.now() }, ...ss];
      if (opt.size === 0) optimisticRef.current.delete(dir);
    }
    // 稳定排序：保留上次显示顺序，仅把「新出现」的会话置顶（其余不动）。后端按 updatedAt 倒序返回，
    // 直接用会让「刚用过的会话跳到顶」—— 这里固定下来，避免点击/使用导致重排序。
    const ids = ss.map((s) => s.sessionId);
    const prev = sessionOrderRef.current[dir] || [];
    const prevSet = new Set(prev);
    const idSet = new Set(ids);
    const fresh = ids.filter((id) => !prevSet.has(id));        // 新会话 → 顶部
    const kept = prev.filter((id) => idSet.has(id));           // 旧会话 → 保持原序
    const order = [...fresh, ...kept];
    sessionOrderRef.current[dir] = order;
    const pos = new Map(order.map((id, idx) => [id, idx]));
    ss = [...ss].sort((a, b) => (pos.get(a.sessionId) ?? 0) - (pos.get(b.sessionId) ?? 0));
    setSessionsByPath((m) => ({ ...m, [dir]: ss }));
  }, [activeProvider, codexImportsTick]);

  // 把一个刚拿到真实 id 的新会话立刻插进左栏（不等 CLI 落盘 + 读盘）。记进 optimisticRef，
  // 之后每次 loadSessionsFor 都会合并它，直到读盘真正含该会话才退役。dir 还没加载过 → 先全量
  // 读盘（loadSessionsFor 内会合并它），避免只剩这一条而漏掉同目录其他历史会话。
  const optimisticSession = useCallback((path: string, sessionId: string, title: string) => {
    const dir = realDir(path);
    let opt = optimisticRef.current.get(dir);
    if (!opt) { opt = new Map(); optimisticRef.current.set(dir, opt); }
    opt.set(sessionId, title);
    if (!Array.isArray(sessionsByPathRef.current[dir])) { void loadSessionsFor(dir); return; }
    setSessionsByPath((m) => {
      const cur = m[dir];
      const arr = Array.isArray(cur) ? cur : [];
      if (arr.some((s) => s.sessionId === sessionId)) return m;
      const order = sessionOrderRef.current[dir] || [];
      if (!order.includes(sessionId)) sessionOrderRef.current[dir] = [sessionId, ...order];
      const entry: SessionSummary = { sessionId, title, preview: null, turns: 0, updatedAt: Date.now() };
      return { ...m, [dir]: [entry, ...arr] };
    });
  }, [loadSessionsFor]);

  const toggleProject = useCallback((p: LocalProject) => {
    const dir = realDir(p.path);
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(p.id)) {
        // 已展开但还没加载（恢复的展开态）→ 加载并保持展开；已加载 → 收起。
        if (sessionsByPathRef.current[dir] === undefined) { void loadSessionsFor(p.path); return next; }
        next.delete(p.id);
      } else { next.add(p.id); void loadSessionsFor(p.path); }
      return next;
    });
  }, [loadSessionsFor]);

  // 冷启 / 切 provider：一次性把「所有项目目录」的会话列表全拉出来并显示（去掉「点开才加载」
  // 的懒加载占位）。历史都是本地读盘、数据量小，并行拉即可；已在加载/已加载的目录自动跳过。
  // 依赖 sessionsByPath：provider 切换会先把它清空，本副作用随即重跑、按新 provider 重拉全部。
  useEffect(() => {
    if (!active) return;
    for (const p of projects) {
      const dir = realDir(p.path);
      if (sessionsByPath[dir] === undefined) void loadSessionsFor(p.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeProvider, projects, sessionsByPath, codexImportsTick, loadSessionsFor]);

  const expandProject = useCallback((cwd: string) => {
    const p = projects.find((x) => x.path === realDir(cwd));
    if (p) setExpanded((cur) => (cur.has(p.id) ? cur : new Set(cur).add(p.id)));
  }, [projects]);

  const addProject = useCallback(async () => {
    const dir = await localAgent.pickFolder();
    if (!dir) return;
    const list = addProjectStore(dir);
    setProjects(list);
    const p = list.find((x) => x.path === dir);
    if (p) { setExpanded((cur) => new Set(cur).add(p.id)); void loadSessionsFor(dir); }
  }, [loadSessionsFor]);

  const removeProject = useCallback((id: string, path: string) => {
    const dir = realDir(path);
    setProjects(removeProjectStore(id));
    // 关掉该项目的所有会话窗格（裸 dir + 各 lane），一并回收常驻进程。
    for (const t of tabs) {
      if (realDir(t.cwd) !== dir) continue;
      dropSmooth(t.cwd);
      void localAgent.sessionClose(dir, paneLane(t.cwd));
      pendingByCwd.current.delete(t.cwd);
      // 与 closeTab 对齐：回收该窗格的内存（整段历史 + steering 去重记录），否则关项目后泄漏。
      histRef.current.delete(t.cwd);
      steeredRef.current.delete(t.cwd);
      draftSet(t.cwd, '');
    }
    setTabs((ts) => ts.filter((t) => realDir(t.cwd) !== dir));
    setActiveCwd((c) => (c && realDir(c) === dir ? null : c));
  }, [dropSmooth, tabs]);

  /* ---- 标签操作：每个 session 一个独立窗格(pane)；同项目多个 session 并存同时跑 ----
   * 给项目分配 paneKey：项目还没开过 → 裸 dir；已开过 → 新 lane(dir#@#lane)。 */
  // 该目录已有任意窗格（裸 dir 或任意 lane）→ 一律分新 lane，绝不复用已占用的 paneKey
  // （修「同项目第二个会话顶掉第一个」——之前只比裸 dir，首会话若是衍生(lane)就会让新会话抢裸 dir）。
  const paneKeyForDir = useCallback((dir: string): string =>
    tabsRef.current.some((t) => realDir(t.cwd) === dir) ? makePaneKey(dir, nextLaneId()) : dir
  , []);

  /* 新增一个会话窗格：紧挨触发它的标签插入、继承其分组；不 sessionClose 旧会话
   * （这是同项目多会话并行的关键——旧实现是替换+关进程，只能一个）。
   * paneKey 已存在（裸 dir 首会话复用）→ 替换该标签并保留偏好色。 */
  const addPaneTab = useCallback((paneKey: string, sessionId: string | null, title: string, sourceCwd?: string, prov: ProviderId = provider, focus = true): void => {
    const defPerm = defaultPermMode(prov);
    dropSmooth(paneKey);
    draftSet(paneKey, '');   // 复用 paneKey 开新会话 → 不继承旧 composer 草稿（与旧 emptyTab 行为一致）
    pendingByCwd.current.delete(paneKey);
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.cwd === paneKey);
      if (i >= 0) {
        const next = [...ts];
        next[i] = emptyTab(paneKey, sessionId, title, ts[i].color, defPerm, prov);
        return next;
      }
      const src = sourceCwd ?? activeCwd ?? undefined;
      const srcIdx = src ? ts.findIndex((t) => t.cwd === src) : -1;
      const srcTab = srcIdx >= 0 ? ts[srcIdx] : undefined;
      const fresh: Tab = { ...emptyTab(paneKey, sessionId, title, undefined, defPerm, prov), groupId: srcTab?.groupId ?? null };
      // 打开/新建会话 → 标签置最左（未分组）；分组成员仍紧挨源标签插入以正确并入分组。
      const arr = fresh.groupId
        ? (srcIdx >= 0 ? [...ts.slice(0, srcIdx + 1), fresh, ...ts.slice(srcIdx + 1)] : [...ts, fresh])
        : [fresh, ...ts];
      return clusterTabs(arr);
    });
    if (focus) setActiveCwd(paneKey);   // 后台开（召唤 agent 会话）时不抢焦点
  }, [provider, dropSmooth, activeCwd]);

  // 落历史：窗口化加载。大会话只把尾部 N 条放进 tab.messages（进 React 树的只有这些），
  // 整段原始消息留在 histRef（纯数据，不参与渲染）；histMore = 还藏着多少条更早的。
  // 用户上滑/点击「加载更早」→ loadOlder 按批前插。
  // ——之前是「先尾部 20 条、setTimeout(0) 全量回填」：切长对话第一帧快，下一帧
  // 就 buildBlocks/groupTurns/挂载几百条消息，正是「切长对话卡」的根因。
  const histRef = useRef<Map<string, TranscriptMessage[]>>(new Map());
  const setHistory = useCallback((cwd: string, _sid: string, msgs: TranscriptMessage[]) => {
    if (msgs.length > HISTORY_TAIL + 10) {
      histRef.current.set(cwd, msgs);
      patchTab(cwd, { messages: msgs.slice(-HISTORY_TAIL), histMore: msgs.length - HISTORY_TAIL, loading: false });
    } else {
      histRef.current.delete(cwd);
      patchTab(cwd, { messages: msgs, histMore: 0, loading: false });
    }
  }, [patchTab]);

  /** 把新消息追加进某 tab 的时间线，并把「进 DOM 的条数」窗口化在 RENDER_TAIL_MAX 内。
   *  histRef 始终持有该会话的全量数组（窗口化时存在）；溢出的旧消息折进它、histMore 前移，
   *  上滑 loadOlder 可逐批取回。在 patchTab 的 updater 里调用（prev = 当前 tab）。 */
  const appendWindowed = (cwd: string, prev: Tab, added: TranscriptMessage[]): Partial<Tab> => {
    const hist = histRef.current.get(cwd);
    const prevMore = hist ? (prev.histMore ?? 0) : 0;
    const fullPrev = hist ?? prev.messages;
    // StrictMode 幂等护栏：本函数在 patchTab 的 updater 里跑、并写 histRef（外部可变 store）——
    // React 会用相同 prev 双跑该 updater，第二次读到的是第一次刚写进 histRef 的数组，于是把
    // added 又拼一遍 → 消息翻倍（「发一条出现两条」，histRef 一旦被填充即触发：开 >20 条历史的
    // 会话就会填充）。这里按【引用相等】判断 histRef 尾部是否已是这批 added：是则不再重复拼接。
    const already = hist && added.length > 0 && hist.length >= added.length
      && added.every((m, i) => hist[hist.length - added.length + i] === m);
    const full = (added.length && !already) ? [...fullPrev, ...added] : fullPrev;
    const visibleLen = full.length - prevMore;
    if (visibleLen <= RENDER_TAIL_MAX) {
      if (hist) { histRef.current.set(cwd, full); return { messages: full.slice(prevMore), histMore: prevMore }; }
      return { messages: full, histMore: 0 };
    }
    const newMore = full.length - RENDER_TAIL_MAX;
    histRef.current.set(cwd, full);
    return { messages: full.slice(newMore), histMore: newMore };
  };

  /** 取下一批更早的历史消息前插进时间线（histMore 是已展示窗口在全量数组里的起点）。 */
  const loadOlder = useCallback((cwd: string) => {
    const all = histRef.current.get(cwd);
    if (!all) return;
    patchTab(cwd, (t) => {
      const more = t.histMore ?? 0;
      if (more <= 0) return {};
      const start = Math.max(0, more - HISTORY_TAIL);
      return { messages: [...all.slice(start, more), ...t.messages], histMore: start };
    });
  }, [patchTab]);

  // 打开历史会话：每次都开成**独立新窗格**（同项目可并存多个）。若该会话已开 → 聚焦它，
  // 不重复开。sourceCwd = 触发它的标签（新标签紧挨其后插入）。
  const openSession = useCallback(async (projPath: string, sid: string, title: string, sourceCwd?: string) => {
    const dir = realDir(projPath);
    // 也认 pendingByCwd：新会话首轮 init 把真实 id 先放这儿，标签写回前的窗口期内点左栏
    // 同样应聚焦运行中的标签，而不是再开一个空白窗。
    const existing = tabs.find((t) => realDir(t.cwd) === dir && (t.sessionId === sid || pendingByCwd.current.get(t.cwd) === sid));
    if (existing) {
      // 已开 → 仅聚焦它，不重排（点击=浏览，不置左；置左只在发起提问时发生）。
      setActiveCwd(existing.cwd);
      return;
    }
    // 从浏览树打开的会话属于「当前浏览的 provider」（activeProvider）。
    const prov = activeProvider;
    const det = providers.find((p) => p.id === prov);
    const paneKey = paneKeyForDir(dir);
    addPaneTab(paneKey, sid, title, sourceCwd, prov);
    const remembered = permMemRef.current[sid];
    const pm = (remembered && permModesFor(prov).includes(remembered)) ? remembered : defaultPermMode(prov);
    const md = modelMemRef.current[sid] || undefined;
    const rs = reasoningMemRef.current[sid] || undefined;
    const mc = mcpMemRef.current[sid] || undefined;
    // 回显：默认切到该会话上次记住的权限级别 + 模型 + MCP。
    patchTab(paneKey, { loading: true, permMode: pm, model: md, reasoning: rs, mcp: mc });
    // 预热：立刻起常驻进程（含 resume 读盘）；冷启在「载入会话…」期间付掉，发送时已暖。
    // cursor 无常驻进程，warm 只登记状态 + 拉模型；apiKey 注入（已预拉则同步可得）。
    if (det?.live) void localAgent.warm({ provider: prov, cwd: dir, lane: paneLane(paneKey), sessionId: sid, permMode: pm, model: md, reasoning: rs, mcp: mc, apiKey: prov === 'cursor' ? cursorKeyRef.current : undefined });
    const { messages: msgs } = await localAgent.readSession(prov, dir, sid);
    setHistory(paneKey, sid, msgs);
  }, [activeProvider, providers, tabs, paneKeyForDir, addPaneTab, patchTab, setHistory]);

  /** 召唤用：确保 agent 绑定会话有一个（后台、不抢焦点）标签在跟它——这样召唤产生的权限/AskUser
   *  请求能被原生路由到该标签处理，输出也落进该会话、之后点开可见。已开则复用。同步返回其 paneKey，
   *  调用方据此把召唤发到同一 (dir, lane)，事件才会被该标签收到。历史读盘后台进行，不拖慢唤起。 */
  const ensureAgentSessionTab = useCallback((projPath: string, sid: string, title: string, prov: ProviderId, permMode: PermMode): string => {
    const dir = realDir(projPath);
    const existing = tabsRef.current.find((t) => realDir(t.cwd) === dir && (t.sessionId === sid || pendingByCwd.current.get(t.cwd) === sid));
    if (existing) return existing.cwd;
    const paneKey = paneKeyForDir(dir);
    addPaneTab(paneKey, sid, title, undefined, prov, false);   // 后台开，不 setActiveCwd
    const det = providers.find((p) => p.id === prov);
    patchTab(paneKey, { loading: true, permMode, model: modelMemRef.current[sid] || undefined, mcp: mcpMemRef.current[sid] || undefined });
    if (det?.live) void localAgent.warm({ provider: prov, cwd: dir, lane: paneLane(paneKey), sessionId: sid, permMode, model: modelMemRef.current[sid] || undefined, mcp: mcpMemRef.current[sid] || undefined, apiKey: prov === 'cursor' ? cursorKeyRef.current : undefined });
    void localAgent.readSession(prov, dir, sid).then(({ messages }) => setHistory(paneKey, sid, messages)).catch(() => { /* 读盘失败不阻断 */ });
    return paneKey;
  }, [providers, paneKeyForDir, addPaneTab, patchTab, setHistory]);

  // 新建会话：同样开成独立新窗格，紧挨触发它的标签。
  // providerOverride：从 composer 切 provider 时显式带入目标 provider —— 直接用它预热，
  // 不依赖「先 setState 改全局 provider → 等重渲染」的时序（那条链路易踩 stale 闭包）。
  const newSession = useCallback((projPath: string, sourceCwd?: string, providerOverride?: ProviderId) => {
    const prov = providerOverride || provider;
    const dir = realDir(projPath);
    const paneKey = paneKeyForDir(dir);
    addPaneTab(paneKey, null, tr('local.newSession'), sourceCwd, prov);
    // 预热新会话：先把进程起好，首条消息即暖。warm/send 本就按 call 传 provider，
    // 所以新 lane 可立刻用目标 provider 起，无需等全局 provider 落定。
    const det = providers.find((p) => p.id === prov);
    if (det?.live) void localAgent.warm({ provider: prov, cwd: dir, lane: paneLane(paneKey), sessionId: null, permMode: defaultPermMode(prov), apiKey: prov === 'cursor' ? cursorKeyRef.current : undefined });
  }, [provider, providers, paneKeyForDir, addPaneTab, tr]);

  // 记住每个 provider 上次活跃的 session(cwd)：切回该 provider 时自动恢复那个会话。
  const lastCwdByProvider = useRef<Partial<Record<ProviderId, string>>>({});
  useEffect(() => {
    if (!activeCwd) return;
    const t = tabs.find((x) => x.cwd === activeCwd);
    if (t) lastCwdByProvider.current[t.provider] = activeCwd;
  }, [activeCwd, tabs]);

  /* 书签栏切执行器：
   *  ① 目标 provider 已有打开的 session → 恢复它上次活跃的那个（Feature: 切回自动进入）。
   *  ② 该 provider 还没有 session：当前 pane 是空会话 → 原地换执行器（复用该标签，不留孤儿
   *     空标签）；否则在当前项目目录开一个新会话。
   *  tab 栏本就按 activeProvider 过滤，所以切 provider = 换一组标签 + 聚焦其上次会话，不再刷屏。 */
  const switchActiveProvider = useCallback((id: ProviderId) => {
    const cwd = activeCwd;
    const tab = cwd ? tabs.find((t) => t.cwd === cwd) : null;
    if (tab && tab.provider === id) return;
    // ① 恢复该 provider 上次活跃 session（记忆失效则退回该 provider 任意一个标签）。
    const remembered = lastCwdByProvider.current[id];
    const target = (remembered && tabs.some((t) => t.cwd === remembered && t.provider === id))
      ? remembered
      : tabs.find((t) => t.provider === id)?.cwd;
    if (target) { setActiveCwd(target); return; }
    if (!cwd || !tab) return;   // 无活动 pane 且该 provider 无 session → 仅设默认(在 ClientShell)
    // ② 该 provider 无 session：空 pane 原地换；否则新开。
    const empty = !tab.sessionId && tab.messages.length === 0 && tab.liveMsgs.length === 0 && !tab.running;
    if (empty) {
      void localAgent.sessionClose(realDir(cwd), paneLane(cwd));   // 收掉该 pane 旧 provider 的预热/常驻进程
      patchTab(cwd, { provider: id, permMode: defaultPermMode(id), model: undefined, reasoning: undefined, status: '' });
      lastCwdByProvider.current[id] = cwd;
      const det = providers.find((p) => p.id === id);
      if (det?.live) void localAgent.warm({ provider: id, cwd: realDir(cwd), lane: paneLane(cwd), sessionId: null, permMode: defaultPermMode(id), apiKey: id === 'cursor' ? cursorKeyRef.current : undefined });
      return;
    }
    newSession(cwd, undefined, id);
  }, [activeCwd, tabs, patchTab, providers, newSession]);

  const closeTab = useCallback((cwd: string) => {
    dropSmooth(cwd);
    draftSet(cwd, '');
    histRef.current.delete(cwd);
    steeredRef.current.delete(cwd);
    void localAgent.sessionClose(realDir(cwd), paneLane(cwd));   // 关标签 → 回收常驻进程（运行中=打断）
    pendingByCwd.current.delete(cwd);
    setTabs((ts) => {
      const closing = ts.find((t) => t.cwd === cwd);
      const next = ts.filter((t) => t.cwd !== cwd);
      setActiveCwd((c) => {
        if (c !== cwd) return c;
        // 优先落到「同 provider 的相邻标签」，避免关一个就跳到别的 provider，把整个视图切走。
        const same = next.filter((t) => t.provider === closing?.provider);
        return same.length ? same[same.length - 1].cwd : (next.length ? next[next.length - 1].cwd : null);
      });
      return next;
    });
  }, [dropSmooth]);

  /* 右键「关闭其他」：关掉同 provider 的其余标签（tab 栏本就按 provider 过滤，「其他」=可见的同组）。 */
  const closeOtherTabs = useCallback((keepCwd: string) => {
    const keep = tabs.find((t) => t.cwd === keepCwd);
    if (!keep) return;
    const victims = tabs.filter((t) => t.cwd !== keepCwd && t.provider === keep.provider);
    if (!victims.length) return;
    const victimSet = new Set(victims.map((v) => v.cwd));
    for (const v of victims) {
      dropSmooth(v.cwd); draftSet(v.cwd, ''); histRef.current.delete(v.cwd); steeredRef.current.delete(v.cwd);
      void localAgent.sessionClose(realDir(v.cwd), paneLane(v.cwd));
      pendingByCwd.current.delete(v.cwd);
    }
    setTabs((ts) => clusterTabs(ts.filter((t) => !victimSet.has(t.cwd))));
    setActiveCwd(keepCwd);
  }, [tabs, dropSmooth]);

  /* 激活的 session 标签挪到最左（仅未分组的——分组内保持分组顺序，不打乱）。 */
  const promoteTab = useCallback((cwd: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.cwd === cwd);
      if (i <= 0 || ts[i].groupId) return ts;
      const t = ts[i];
      return clusterTabs([t, ...ts.filter((x) => x.cwd !== cwd)]);
    });
  }, []);

  /* ---- 持久化：所有打开的标签 + 激活标签 + 分组 + 分屏树。
         恢复已挪到 useState 初始值（见上方 boot），这里只负责写。
         跳过首帧避免用初始值原样回写（无谓写入）。
         关键性能点：tabs 引用在流式期间每帧都变（livePreview/liveMsgs），但落盘的
         只有下面这几个低频字段——用结构指纹作依赖，避免打字机每帧同步写 localStorage。 ---- */
  const firstSaveRef = useRef(true);
  const tabsPersistFp = tabs.map((t) => `${t.cwd}|${t.sessionId ?? ''}|${t.title}|${t.groupId ?? ''}|${t.permMode ?? ''}|${t.provider}`).join('§');
  useEffect(() => {
    if (firstSaveRef.current) { firstSaveRef.current = false; return; }
    const ts = tabsRef.current;
    const liveGroupIds = new Set(ts.map((t) => t.groupId).filter(Boolean));
    saveTabsState(
      ts.map((t) => ({ cwd: t.cwd, sessionId: t.sessionId, title: t.title, groupId: t.groupId ?? null, permMode: t.permMode, provider: t.provider })),
      activeCwd,
      groups.filter((g) => liveGroupIds.has(g.id)),
      layout,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsPersistFp, activeCwd, groups, layout]);

  /* ---- 惰性续传：进入 Local Agents 后，激活的待载入标签读盘载入对话。 ---- */
  useEffect(() => {
    if (!active || !activeCwd) return;
    const tab = tabs.find((t) => t.cwd === activeCwd);
    if (!tab || !tab.pendingLoad || !tab.sessionId || tab.loading) return;
    patchTab(activeCwd, { loading: true, pendingLoad: false });
    const sid = tab.sessionId;
    localAgent.readSession(tab.provider, realDir(activeCwd), sid).then(({ messages: msgs }) => setHistory(activeCwd, sid, msgs));
  }, [active, activeCwd, tabs, patchTab, setHistory]);

  const setActiveTab = useCallback((cwd: string) => setActiveCwd(cwd), []);

  // 草稿/发送/中断都按 cwd 寻址（多窗格下每个窗独立）。
  // 键入只写外部 store（不进 tabs，零全局重渲）。
  const setDraft = useCallback((cwd: string, v: string) => { draftSet(cwd, v); }, []);
  /** 选/清 Chaya 技能（composer pill）。空字符串/undefined = 清除。 */
  const setSkill = useCallback((cwd: string, name: string | undefined) => { patchTab(cwd, { skill: name || undefined }); }, [patchTab]);
  /** 往某标签的输入框追加文本（评审「发送到对话」用）：稳定引用，不随 draft 变化。 */
  const appendDraft = useCallback((cwd: string, text: string) => {
    const cur = getDraft(cwd);
    draftSet(cwd, (cur ? `${cur}\n\n` : '') + text);
  }, []);

  /* ---- 参考附件（按 cwd / 窗格独立）：拖入文件、附件按钮选取、粘贴板图片。
         图片走视觉（image block），其它文件按 @路径 让 agent 读取分析。 ---- */
  const attSeqRef = useRef(0);
  const mkAttId = () => `att-${Date.now()}-${attSeqRef.current++}`;
  const addAttachments = useCallback((cwd: string, atts: Omit<Attachment, 'id'>[]) => {
    if (!atts.length) return;
    const withIds = atts.map((a) => ({ ...a, id: mkAttId() }));
    patchTab(cwd, (t) => ({ attachments: [...(t.attachments || []), ...withIds] }));
  }, [patchTab]);
  const removeAttachment = useCallback((cwd: string, id: string) => {
    patchTab(cwd, (t) => ({ attachments: (t.attachments || []).filter((a) => a.id !== id) }));
  }, [patchTab]);
  const pickAttachments = useCallback(async (cwd: string) => {
    const picked = await localAgent.pickFiles();
    if (Array.isArray(picked) && picked.length) {
      addAttachments(cwd, picked.map((p) => ({ kind: p.kind, name: p.name, path: p.path, mime: p.mime, size: p.size, dataUrl: p.dataUrl })));
    }
  }, [addAttachments]);

  /* ---- 标签分组（类 Chrome 标签组）：合并多个标签、设色、折叠/展开。 ---- */
  const groupSeqRef = useRef(0);
  const createGroupFromTab = useCallback((cwd: string) => {
    const id = `g-${Date.now()}-${groupSeqRef.current++}`;
    setGroups((gs) => {
      const used = new Set(gs.map((g) => g.color));
      const color = TAB_COLORS.find((c) => !used.has(c)) || TAB_COLORS[gs.length % TAB_COLORS.length];
      return [...gs, { id, name: tr('local.newGroupName'), color, collapsed: false }];
    });
    setTabs((ts) => clusterTabs(ts.map((t) => (t.cwd === cwd ? { ...t, groupId: id } : t))));
    return id;
  }, [tr]);
  const addTabToGroup = useCallback((cwd: string, groupId: string) => {
    setTabs((ts) => clusterTabs(ts.map((t) => (t.cwd === cwd ? { ...t, groupId } : t))));
  }, []);
  const removeTabFromGroup = useCallback((cwd: string) => {
    setTabs((ts) => clusterTabs(ts.map((t) => (t.cwd === cwd ? { ...t, groupId: null } : t))));
  }, []);
  const toggleGroup = useCallback((id: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, collapsed: !g.collapsed } : g)));
  }, []);
  const setGroupColor = useCallback((id: string, color: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, color } : g)));
  }, []);
  const renameGroup = useCallback((id: string, name: string) => {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, name } : g)));
  }, []);
  const ungroupGroup = useCallback((id: string) => {
    setTabs((ts) => clusterTabs(ts.map((t) => (t.groupId === id ? { ...t, groupId: null } : t))));
    setGroups((gs) => gs.filter((g) => g.id !== id));
  }, []);
  /** 拖动单个标签重排：移到 beforeCwd 之前（null = 末尾）；clusterTabs 保持分组连续。 */
  const moveTabBefore = useCallback((cwd: string, beforeCwd: string | null) => {
    if (cwd === beforeCwd) return;
    setTabs((ts) => {
      const moving = ts.find((t) => t.cwd === cwd);
      if (!moving) return ts;
      const rest = ts.filter((t) => t.cwd !== cwd);
      let idx = beforeCwd ? rest.findIndex((t) => t.cwd === beforeCwd) : rest.length;
      if (idx < 0) idx = rest.length;
      return clusterTabs([...rest.slice(0, idx), moving, ...rest.slice(idx)]);
    });
  }, []);
  /** 拖动分组重排：把整个分组块移到 beforeCwd 之前（null = 移到末尾）。 */
  const moveGroupBefore = useCallback((groupId: string, beforeCwd: string | null) => {
    setTabs((ts) => {
      if (beforeCwd) { const tt = ts.find((t) => t.cwd === beforeCwd); if (tt && tt.groupId === groupId) return ts; }
      const members = ts.filter((t) => t.groupId === groupId);
      if (members.length === 0) return ts;
      const rest = ts.filter((t) => t.groupId !== groupId);
      let idx = beforeCwd ? rest.findIndex((t) => t.cwd === beforeCwd) : rest.length;
      if (idx < 0) idx = rest.length;
      return clusterTabs([...rest.slice(0, idx), ...members, ...rest.slice(idx)]);
    });
  }, []);
  // 组员清空（标签关闭/移出）后自动删掉空分组。
  useEffect(() => {
    setGroups((gs) => {
      const used = new Set(tabs.map((t) => t.groupId).filter(Boolean));
      const next = gs.filter((g) => used.has(g.id));
      return next.length === gs.length ? gs : next;
    });
  }, [tabs]);

  /** 删除会话（移到回收站）。乐观从列表移除；若某标签正开着它则清空该标签会话。
   *  顺手清掉该 sessionId 在 perm/model/reasoning/mcp 记忆里的残留（否则 localStorage 会无界增长）。 */
  const deleteSession = useCallback(async (cwd: string, sid: string) => {
    // 不变量：被某个本地 Agent 绑定的会话不可删（它是该 Agent 的记忆来源）。先解绑再删。
    const boundAgent = agentBySession(sid);
    if (boundAgent) {
      try { window.dispatchEvent(new CustomEvent('chaya:toast', { detail: { text: `该会话已是 Agent「@${boundAgent.name}」的记忆来源，请先在 Agents 面板解绑再删除。` } })); } catch { /* non-browser */ }
      return { ok: false, blocked: true, agentName: boundAgent.name } as const;
    }
    const dir = realDir(cwd);
    // 关键：把该会话从「乐观会话」与「显示顺序」记忆里一并抹掉。否则乐观条目永不退役（读盘
    // 已无该会话 → 合并逻辑判定「还没落盘」继续插回），删完立刻又冒出一条占位（untitled）会话。
    const oc = optimisticRef.current.get(dir);
    if (oc) { oc.delete(sid); if (oc.size === 0) optimisticRef.current.delete(dir); }
    const ord = sessionOrderRef.current[dir];
    if (ord) sessionOrderRef.current[dir] = ord.filter((id) => id !== sid);
    pendingByCwd.current.forEach((v, k) => { if (realDir(k) === dir && v === sid) pendingByCwd.current.delete(k); });
    setSessionsByPath((m) => {
      const cur = m[cwd];
      if (!Array.isArray(cur)) return m;
      return { ...m, [cwd]: cur.filter((s) => s.sessionId !== sid) };
    });
    // 删会话 → 自动关掉 tab 栏里绑定它的会话 tab（仅当该 cwd 的 tab 当前确实绑着被删 session）。
    // 可能有多条并行车道(lane)开着同一 session：逐个关闭。
    const bound = tabsRef.current.filter((t) => realDir(t.cwd) === realDir(cwd) && t.sessionId === sid);
    for (const t of bound) closeTab(t.cwd);
    if (permMemRef.current[sid]) { delete permMemRef.current[sid]; savePermBySession(permMemRef.current); }
    if (modelMemRef.current[sid]) { delete modelMemRef.current[sid]; saveModelBySession(modelMemRef.current); }
    if (reasoningMemRef.current[sid]) { delete reasoningMemRef.current[sid]; saveReasoningBySession(reasoningMemRef.current); }
    if (mcpMemRef.current[sid]) { delete mcpMemRef.current[sid]; saveMcpBySession(mcpMemRef.current); }
    // 删的是浏览树里（activeProvider）的会话；若某开着的标签绑着它，按该标签自带 provider 删更准。
    const prov = bound[0]?.provider ?? activeProvider;
    const res = await localAgent.deleteSession(prov, realDir(cwd), sid);
    // 删除落定后再静默重拉一次「权威列表」：即便关 tab 触发的 session_closed→finalizeTurn 抢先
    // 重读盘把它捞回来，这一拉（此时磁盘已删）也会把它清掉，且乐观记忆已抹，不会再插回。
    void loadSessionsFor(cwd);
    return res;
  }, [activeProvider, loadSessionsFor, closeTab]);

  /** 侧路拉 claude 订阅额度（/usage）。账号级 → 刷到所有 claude 标签；主进程已带 45s 缓存。 */
  const refreshUsage = useCallback((cwd?: string) => {
    void localAgent.usage(cwd ? realDir(cwd) : undefined).then((u) => {
      if (!u) return;
      setTabs((ts) => {
        let changed = false;
        const next = ts.map((t) => {
          if (t.provider !== 'claude') return t;
          if (t.plan && t.plan.session === u.session && t.plan.week === u.week && t.plan.weekSonnet === u.weekSonnet) return t;
          changed = true; return { ...t, plan: u };
        });
        return changed ? next : ts;
      });
    }).catch(() => {});
  }, []);
  // 挂载即拉一次额度，让额度条在发首条消息前就有初值（账号级、主进程缓存）。
  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  function handleEvent(cwd: string, ev: any) {
    const t = ev?.type;
    const parentId: string | null = (ev && ev.parent_tool_use_id) || null;
    // 子 agent（Task）的生命周期/流式不驱动主回合、也不吐进主预览；但它的 assistant/user
    // 消息要保留（带 parentId），好在渲染时收进对应 Task 卡片里（见 buildBlocks 嵌套）。
    if (t === 'models') {   // 主进程拉到的可选模型 → 填模型选择器
      if (Array.isArray(ev.models) && ev.models.length) setModelOptions(ev.models);
      return;
    }
    if (t === 'usage') {    // 静默 /usage 探针解析出的订阅额度 → 刷到所有 claude 标签（账号级）
      const u = ev.data as UsageInfo | null;
      if (u) setTabs((ts) => {
        let changed = false;
        const next = ts.map((tab) => {
          if (tab.provider !== 'claude') return tab;
          if (tab.plan && tab.plan.session === u.session && tab.plan.week === u.week && tab.plan.weekSonnet === u.weekSonnet) return tab;
          changed = true; return { ...tab, plan: u };
        });
        return changed ? next : ts;
      });
      return;
    }
    if (t === 'system' && ev.subtype === 'init') {
      if (parentId) return;
      if (ev.session_id) {
        // 新会话拿到真实 id → 只记进 pendingByCwd（供标签写回 / 左栏点击匹配），
        // 但【不】立刻刷进工程目录：新会话在「一次 AI 回答完成」后才显示（见 finalizeTurn）。
        // 这样回答进行中工程目录保持安静、不闪、不提前冒出占位会话。
        pendingByCwd.current.set(cwd, ev.session_id);
      }
      // init 带 MCP 连接状态 → 存到该标签供 MCP 控件显示。
      const mcpStatus = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : undefined;
      // 预热（用户还没发送）时 init 也会来——此时 running=false，别显示「处理中」。
      // 关键：拿到真实 id 就立刻写回标签（不等回合结束）。否则新会话首轮里 tab.sessionId 仍是
      // null、只活在 pendingByCwd，而左栏已经刷出这条会话——点它时 openSession 匹配不到正在跑
      // 的标签，就又开一个空白窗（「幽灵会话/对不上」）。早写回让左栏点击直接聚焦到运行中的标签。
      patchTab(cwd, (tab) => ({
        ...(tab.running ? { status: tr('local.status.processing') } : {}),
        ...(mcpStatus ? { mcpStatus } : {}),
        // 只在「已发送、回合进行中」时写回——空闲预热的 pane 保持 sessionId=null，
        // 切 provider 才能就地复用空 pane（switchActiveProvider 的 empty 判定）。
        ...(ev.session_id && !tab.sessionId && tab.running ? { sessionId: ev.session_id } : {}),
      }));
      return;
    }
    if (t === 'stream_event') {
      if (parentId) return;   // 子 agent 的流式增量不进主打字机
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        feedSmooth(cwd, e.delta.text);  // → rAF 匀速吐进 livePreview
      }
      return;
    }
    if (t === 'assistant' || t === 'user') {
      const parts = normalizeParts(ev.message);
      // 过滤 CLI 注入的本地命令回显（如 setModel 的「<local-command-stdout>Set model to …</local-command-stdout>」），
      // 它不是对话内容，别当气泡显示。
      if (isLocalCommandNoise(parts)) return;
      // steering 回显去重：运行中插话已乐观渲染过气泡；SDK 把它作为 user 事件吐回来时跳过。
      if (t === 'user' && !parentId && parts.length > 0 && parts.every((p) => p.kind === 'text')) {
        const pend = steeredRef.current.get(cwd);
        if (pend?.length) {
          const txt = parts.map((p) => (p as { kind: 'text'; text: string }).text).join('\n').trim();
          const i = pend.indexOf(txt);
          if (i >= 0) { pend.splice(i, 1); return; }
        }
      }
      const merge = () => {
        if (!parentId) lpSet(cwd, '');   // 最终块顶上，live 尾巴退场
        patchTab(cwd, (tab) => ({
          liveMsgs: parts.length > 0 ? [...tab.liveMsgs, { role: t, parts, ts: null, uuid: ev.uuid || null, parentId }] : tab.liveMsgs,
        }));
      };
      // 子 agent 消息直接合并（不经主打字机，避免污染主预览）。
      const sm = smoothRef.current.get(cwd);
      if (!parentId && sm && sm.disp < sm.raw.length) {
        sm.finalize = merge;   // 主 agent 预览没吐完 → 排空后再合并最终块
        ensurePump();
      } else {
        if (!parentId && sm) smoothRef.current.delete(cwd);
        merge();
      }
      return;
    }
    if (t === 'question_request') {
      patchTab(cwd, { question: { permId: ev.permId, questions: (ev.input && ev.input.questions) || [], agentId: ev.agentId || null }, status: tr('local.status.awaitingChoice') });
      return;
    }
    if (t === 'permission_request') {
      patchTab(cwd, {
        perm: {
          permId: ev.permId, toolName: ev.toolName, input: ev.input,
          title: ev.title, displayName: ev.displayName, description: ev.description, suggestions: ev.suggestions,
          agentId: ev.agentId || null,
        },
        status: tr('local.status.awaitingPermission'),
      });
      return;
    }
    if (t === 'elicitation_request') {
      patchTab(cwd, {
        elicit: {
          elicitId: ev.elicitId, serverName: ev.serverName, message: ev.message,
          mode: ev.mode === 'url' ? 'url' : 'form', url: ev.url, schema: ev.schema,
          title: ev.title, displayName: ev.displayName, description: ev.description,
        },
        status: tr('local.status.awaitingPermission'),
      });
      return;
    }
    // result = 一个回合结束（常驻会话仍存活，等下一条）。子 agent 的 result 不收尾主回合。
    if (t === 'result') {
      if (parentId) return;
      if (ev.session_id) pendingByCwd.current.set(cwd, ev.session_id);
      finalizeTurn(cwd, (ev.subtype && ev.subtype !== 'success') ? `⚠ ${tr('local.status.turnAbnormal')}` : '');
      // 本回合占用了额度 → 侧路刷新 /usage（主进程带 45s 缓存，多窗格合一）。仅 claude 有。
      if ((tabsRef.current.find((x) => x.cwd === cwd)?.provider ?? 'claude') === 'claude') refreshUsage(cwd);
      return;
    }
    if (t === 'error') { finalizeTurn(cwd, `⚠ ${ev.error || tr('local.status.execError')}`); return; }
    // 进程真正退出（关标签/切会话/出错）：兜底收尾。
    if (t === 'session_closed') { finalizeTurn(cwd, ''); return; }
  }
  handleEventRef.current = handleEvent;

  /** 收尾一个回合：排空平滑、把 liveMsgs 合进历史、running=false、写回 sessionId、刷新左栏。 */
  function finalizeTurn(cwd: string, errStatus: string) {
    const sm = smoothRef.current.get(cwd);
    if (sm) { smoothRef.current.delete(cwd); if (sm.finalize) sm.finalize(); }
    lpSet(cwd, '');
    steeredRef.current.delete(cwd);   // 回合结束，未回显的 steering 标记作废
    const pending = pendingByCwd.current.get(cwd) || null;
    patchTab(cwd, (tab) => {
      if (!tab.running && tab.liveMsgs.length === 0) return {}; // 已收尾，避免重复
      const sid = pending || tab.sessionId;
      // 记住这个会话「最后一次发送时的权限级别」，重开历史会话时默认切回它。
      if (sid) { permMemRef.current[sid] = tab.permMode; savePermBySession(permMemRef.current); }
      return {
        ...appendWindowed(cwd, tab, tab.liveMsgs),
        liveMsgs: [], running: false, perm: null, question: null, elicit: null,
        sessionId: sid,
        status: errStatus || '',
      };
    });
    // 一次 AI 回答完成 → 此刻才把新会话显示到工程目录（回答中不显示）。读盘可能略有延迟，
    // 先乐观插一条占位（标题取首条用户提问），随后读盘补回真实标题/回合数；已显示的不重复插。
    if (pending) {
      const dir = realDir(cwd);
      const cur = sessionsByPathRef.current[dir];
      const shown = Array.isArray(cur) && cur.some((s) => s.sessionId === pending);
      if (!shown) {
        let firstText: string | null = null;
        const tb = tabsRef.current.find((x) => x.cwd === cwd);
        for (const m of (tb?.messages || [])) {
          if (m.role !== 'user') continue;
          const tp = m.parts.find((p) => p.kind === 'text') as { kind: 'text'; text: string } | undefined;
          if (tp && tp.text.trim()) { firstText = tp.text.trim().slice(0, 80); break; }
        }
        expandProject(cwd);
        optimisticSession(cwd, pending, firstText || tr('local.newSession'));
      }
    }
    void loadSessionsFor(cwd);   // 刷新左栏（已加载的目录静默就地替换，不闪）
    // 标题是后端在回合后异步生成的：补一刷快速拿到自动重命名，不必等下次手动 load。
    setTimeout(() => void loadSessionsFor(cwd), 1800);
  }

  /** 用户对权限请求作答 → 回传给 SDK 的 canUseTool，agent 继续。 */
  const respondPermission = useCallback((cwd: string, permId: string, decision: PermissionDecision) => {
    patchTab(cwd, { perm: null, status: decision.behavior === 'allow' ? tr('local.status.processing') : '' });
    void localAgent.permissionRespond(permId, decision);
  }, [patchTab, tr]);

  /** 用户答完 AskUserQuestion → 把选择作为答案经 deny-message 回传，agent 据此继续。 */
  const answerQuestion = useCallback((cwd: string, permId: string, answerText: string) => {
    patchTab(cwd, { question: null, status: tr('local.status.processing') });
    void localAgent.permissionRespond(permId, { behavior: 'deny', message: answerText });
  }, [patchTab, tr]);

  /** 用户对 MCP elicitation 作答（提交表单 / 取消）→ 回传给 SDK onElicitation，MCP 调用继续。 */
  const respondElicitation = useCallback((cwd: string, elicitId: string, result: ElicitResult) => {
    patchTab(cwd, { elicit: null, status: result.action === 'accept' ? tr('local.status.processing') : '' });
    void localAgent.elicitationRespond(elicitId, result);
  }, [patchTab, tr]);

  /** 真正把一轮发给后端：拼用户气泡、running=true、调 localAgent.send。
   *  text/attachments 显式传入（manual send 来自 draft，队列 flush 来自打包后的队列）。
   *  clearComposer：manual send 把 draft/附件清空；队列 flush 不动用户正在敲的 draft。 */
  const dispatchTurn = useCallback(async (cwd: string, sendText: string, displayText: string, attachments: Attachment[], clearComposer: boolean, skillName?: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!cwd || !tab) return;
    const prov = tab.provider;
    const det = providers.find((p) => p.id === prov);
    if (!det?.installed || !det?.live) { patchTab(cwd, { status: `⚠ ${tr('local.status.unavailable', { provider: det?.label || prov })}` }); return; }
    const sid = tab.sessionId;   // 仅首条用于 resume；常驻会话已存在时后端忽略
    // cursor headless 必需 API Key——优先用缓存，没有则现拉（拉不到则主进程会回 error 提示去设置录入）。
    const apiKey = prov === 'cursor' ? (cursorKeyRef.current || await fetchCursorKey()) : undefined;
    dropSmooth(cwd);
    // 气泡里把附件名缀在用户文本后，让发出去的这一轮一眼看出带了哪些参考。
    const attNote = attachments.length ? `${displayText ? '\n' : ''}📎 ${attachments.map((a) => a.name).join('、')}` : '';
    // 气泡显示「技能 pill + 用户原话」，CLI 收到的是展开后的 sendText（两者解耦）。
    const parts: MsgPart[] = skillName
      ? [{ kind: 'skill', name: skillName }, { kind: 'text', text: displayText + attNote }]
      : [{ kind: 'text', text: displayText + attNote }];
    if (clearComposer) draftSet(cwd, '');
    // 用户气泡对象提到 updater 外创建 → 引用稳定，配合 appendWindowed 的幂等护栏，StrictMode
    // 双跑 updater 时不会把这条用户消息拼两遍（修「发一条出现两条用户消息」）。
    const userMsg: TranscriptMessage = { role: 'user', parts, ts: null, uuid: null };
    patchTab(cwd, (t) => ({
      ...(clearComposer ? { attachments: [], skill: undefined } : {}),
      ...appendWindowed(cwd, t, [userMsg]),
      liveMsgs: [], running: true, status: tr('local.status.processingShort'), perm: null, question: null, elicit: null,
    }));
    const res = await localAgent.send({ provider: prov, cwd: realDir(cwd), lane: paneLane(cwd), sessionId: sid, prompt: sendText, permMode: tab.permMode, model: tab.model, reasoning: tab.reasoning, mcp: tab.mcp, apiKey, attachments });
    if (!res.ok) patchTab(cwd, (t) => ({ running: false, status: t.status.startsWith('⚠') ? t.status : `⚠ ${tr('local.status.startFailed')}` }));
  }, [tabs, providers, patchTab, dropSmooth, fetchCursorKey, tr]);

  /** 程序化把一段文本作为新一轮发给某个会话（不读/不动用户草稿）。
   *  召唤 agent 得到结论后，把结论交回发起会话、自动触发它继续（sendText=给 CLI 的全文，
   *  displayText=气泡显示的简短交接说明）。仅当该会话空闲时发，忙时跳过（避免打断正在跑的轮次）。 */
  const handoffToSession = useCallback((cwd: string, sendText: string, displayText: string): boolean => {
    const tab = tabsRef.current.find((t) => t.cwd === cwd);
    if (!tab || tab.running || !sendText.trim()) return false;
    void dispatchTurn(cwd, sendText, displayText, [], false);
    return true;
  }, [dispatchTurn]);

  /** claude steering：agent 处理中把新消息直接推进常驻会话的输入流（SDK 在下一个工具
   *  间隙读到并调整方向）。气泡乐观渲染进 liveMsgs（时间线顺序正确：已流出的内容在上、
   *  插话在下、后续流式接着吐）。SDK 可能把推入的消息回显成 user 事件——steeredRef 记
   *  下待回显文本，handleEvent 命中即跳过，避免气泡重复。 */
  const steeredRef = useRef<Map<string, string[]>>(new Map());
  const steerSend = useCallback(async (cwd: string, sendText: string, displayText: string, attachments: Attachment[], skillName?: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!tab) return;
    const attNote = attachments.length ? `${displayText ? '\n' : ''}📎 ${attachments.map((a) => a.name).join('、')}` : '';
    const parts: MsgPart[] = skillName
      ? [{ kind: 'skill', name: skillName }, { kind: 'text', text: displayText + attNote }]
      : [{ kind: 'text', text: displayText + attNote }];
    const pend = steeredRef.current.get(cwd) || [];
    pend.push(sendText.trim());
    steeredRef.current.set(cwd, pend);
    draftSet(cwd, '');
    patchTab(cwd, (t) => ({
      attachments: [], skill: undefined,
      liveMsgs: [...t.liveMsgs, { role: 'user', parts, ts: null, uuid: null }],
    }));
    // steer:true → 主进程只推消息，绝不动会话配置（effort 重建/切模型会杀掉跑着的回合）。
    const res = await localAgent.send({ provider: tab.provider, cwd: realDir(cwd), lane: paneLane(cwd), sessionId: tab.sessionId, prompt: sendText, permMode: tab.permMode, model: tab.model, reasoning: tab.reasoning, mcp: tab.mcp, attachments, steer: true });
    if (!res.ok) patchTab(cwd, (t) => ({ status: t.status.startsWith('⚠') ? t.status : `⚠ ${tr('local.status.startFailed')}` }));
  }, [tabs, patchTab, tr]);

  const queueSeqRef = useRef(0);
  const mkQueueId = () => `q-${Date.now()}-${queueSeqRef.current++}`;

  const send = useCallback(async (cwd: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!cwd || !tab) return;
    const raw = getDraft(cwd).trim();
    const attachments = tab.attachments || [];
    if (!raw && attachments.length === 0 && !tab.skill) return;
    if (tab.perm && attachments.length === 0) {
      const shortcut = normalizePermissionShortcut(raw);
      if (shortcut) {
        draftSet(cwd, '');
        patchTab(cwd, { attachments: [] });
        respondPermission(cwd, tab.perm.permId, shortcut === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: tr('local.perm.denyMessage') });
        return;
      }
    }
    // Chaya 技能展开（对所有 provider 生效，不依赖 CLI 原生命令）：
    //  · composer 选中的技能(tab.skill) → 用它包裹 draft（{{input}}=draft）；气泡显示 pill + 原话。
    //  · 否则识别文本里的 `/技能名 参数` → 展开；未命中则原样下发（claude /compact 等原生命令照常）。
    let sendText = raw;
    let displayText = raw;   // 气泡里显示的用户原话（技能态下只显示参数，不带 /name）
    let skillName: string | undefined;
    const picked = tab.skill ? skillsRef.current.find((s) => s.name === tab.skill) : null;
    if (picked) {
      sendText = picked.body.includes('{{input}}') ? picked.body.split('{{input}}').join(raw) : (raw ? `${picked.body}\n\n${raw}` : picked.body);
      skillName = picked.name;   // displayText 保持 raw（pill 选中态下输入框本就只有参数）
    } else {
      const ex = expandSkill(raw, skillsRef.current);
      if (ex != null) {
        sendText = ex;
        const mm = /^\s*\/([a-zA-Z0-9_-]+)[ \t]*([\s\S]*)$/.exec(raw);
        skillName = mm?.[1];
        displayText = (mm?.[2] || '').trim();   // 手打 /name 命中技能 → 气泡去掉 /name 前缀，只留参数
      }
    }
    // 发起提问才置左：把该会话提到 tab 栏最左（点击 tab 本身不再 promote），并发「发送」信号
    // 让 ClientShell 同步把对应顶栏 tab 也提左。steer / 入队 / 首发都算一次发送。
    promoteTab(cwd);
    lastSentCwdRef.current = cwd;
    setSendTick((x) => x + 1);
    // AI 处理中（含等权限/选择）：
    //  · claude（常驻 SDK 会话）→ 原生 steering：直接推进输入流，CLI 在下一个工具调用
    //    间隙读到并调整方向（与终端里运行中直接回车一致）。气泡乐观渲染进 liveMsgs。
    //  · 其余 provider（exec/headless/ACP 协议都不支持 mid-turn）→ 入队，轮末打包发出。
    if (tab.running) {
      if (tab.provider === 'claude' && providers.find((p) => p.id === 'claude')?.live) {
        await steerSend(cwd, sendText, displayText, attachments, skillName);
        return;
      }
      draftSet(cwd, '');
      patchTab(cwd, (t) => ({
        attachments: [], skill: undefined,
        queue: [...(t.queue || []), { id: mkQueueId(), text: sendText, attachments }],
      }));
      return;
    }
    await dispatchTurn(cwd, sendText, displayText, attachments, true, skillName);
  }, [tabs, providers, patchTab, respondPermission, dispatchTurn, steerSend, promoteTab, tr]);

  /** 衍生：在当前 cwd 新开一个全新 session，并立刻把 text 作为首条发出。
   *  与原 session 地位一致（普通会话、进项目树、可再次衍生）。必须先 sessionClose 关掉
   *  当前常驻进程——否则带 sessionId:null 的 send 会被复用到旧会话，而非新建。 */
  // 预热：选中 AI 文本时就为该目录后台冷启一条「待衍生」会话（每目录至多 1 条）；
  // 用户点「展开讲讲」时直接消费它 → 跳过大半冷启，首 token 快很多。dir → 预热 laneId。
  const specLaneRef = useRef<Map<string, string>>(new Map());

  /** 选中 AI 回答时调用：后台预热一条衍生会话（claude 才有常驻进程可预热）。 */
  const prewarmDerive = useCallback((cwd: string) => {
    const src = tabs.find((t) => t.cwd === cwd);
    const prov = src?.provider ?? provider;
    if (prov !== 'claude' || !providers.find((p) => p.id === prov)?.live) return;
    const dir = realDir(cwd);
    if (specLaneRef.current.has(dir)) return;        // 已有预热中 → 不重复
    const lane = nextLaneId();
    specLaneRef.current.set(dir, lane);
    void localAgent.warm({ provider: prov, cwd: dir, lane, sessionId: null, permMode: src?.permMode ?? defaultPermMode(prov), model: src?.model, reasoning: src?.reasoning, mcp: src?.mcp });
  }, [provider, providers, tabs]);

  /** 衍生：在当前 cwd 下新开一个**独立会话窗格**（新 lane = 同目录并行常驻会话），
   *  作为新标签紧挨源标签插入并立刻把 text 作为首条发出。与普通会话地位一致；想并排看
   *  自行把标签拖去分屏。性能：优先消费 prewarmDerive 预热好的会话；send（冷启）提前 kick off。 */
  const forkSendText = useCallback(async (cwd: string, rawText: string) => {
    const text = (rawText || '').trim();
    if (!cwd || !text) return;
    const src = tabs.find((t) => t.cwd === cwd);     // 继承当前窗格的 provider/model/mcp/perm + 分组
    const prov = src?.provider ?? provider;
    const det = providers.find((p) => p.id === prov);
    if (!det?.installed || !det?.live) { patchTab(cwd, { status: `⚠ ${tr('local.status.unavailable', { provider: det?.label || prov })}` }); return; }
    const dir = realDir(cwd);
    const spec = specLaneRef.current.get(dir);       // 已预热的会话 → 直接用，跳过大半冷启
    const lane = spec ?? nextLaneId();
    if (spec) specLaneRef.current.delete(dir);
    const paneKey = makePaneKey(dir, lane);
    const permMode = src?.permMode ?? defaultPermMode(prov);
    const apiKey = prov === 'cursor' ? (cursorKeyRef.current || await fetchCursorKey()) : undefined;
    // 先 kick off send（预热则瞬时；冷启也尽早开始），与下面建窗格/渲染并行。
    const sendP = localAgent.send({ provider: prov, cwd: dir, lane, sessionId: null, prompt: text, permMode, model: src?.model, reasoning: src?.reasoning, mcp: src?.mcp, apiKey });
    // 直接建窗格紧挨源标签插入（不走 addPaneTab —— 这里要预填用户消息 + running 态）。
    setTabs((ts) => {
      if (ts.some((t) => t.cwd === paneKey)) return ts;
      const newTab: Tab = {
        ...emptyTab(paneKey, null, tr('local.newSession'), undefined, permMode, prov),
        model: src?.model, reasoning: src?.reasoning, mcp: src?.mcp, groupId: src?.groupId ?? null,
        messages: [{ role: 'user', parts: [{ kind: 'text', text }], ts: null, uuid: null }],
        running: true, status: tr('local.status.processingShort'),
      };
      const idx = ts.findIndex((t) => t.cwd === cwd);
      const arr = idx >= 0 ? [...ts.slice(0, idx + 1), newTab, ...ts.slice(idx + 1)] : [...ts, newTab];
      return clusterTabs(arr);
    });
    setActiveCwd(paneKey);
    const res = await sendP;
    if (!res.ok) patchTab(paneKey, (t) => ({ running: false, status: t.status.startsWith('⚠') ? t.status : `⚠ ${tr('local.status.startFailed')}` }));
  }, [tabs, providers, provider, patchTab, fetchCursorKey, tr]);

  /** 从队列移除一条（用户在 flush 前反悔）。 */
  const dequeue = useCallback((cwd: string, id: string) => {
    patchTab(cwd, (t) => ({ queue: (t.queue || []).filter((q) => q.id !== id) }));
  }, [patchTab]);

  /** 本轮收尾（running→false）且队列非空 → 把整队打包成一轮自动发出。
   *  flushingRef 防止 async 间隙里副作用重入造成重复发送。 */
  const flushingRef = useRef<Set<string>>(new Set());
  const flushQueue = useCallback(async (cwd: string) => {
    try {
      const tab = tabs.find((t) => t.cwd === cwd);
      const q = tab?.queue || [];
      if (!tab || tab.running || q.length === 0) return;
      patchTab(cwd, { queue: [] });
      const text = q.map((i) => i.text).filter(Boolean).join('\n\n');
      const attachments = q.flatMap((i) => i.attachments || []);
      await dispatchTurn(cwd, text, text, attachments, false);
    } finally {
      flushingRef.current.delete(cwd);
    }
  }, [tabs, patchTab, dispatchTurn]);

  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.running && (tab.queue?.length ?? 0) > 0 && !flushingRef.current.has(tab.cwd)) {
        flushingRef.current.add(tab.cwd);
        void flushQueue(tab.cwd);
      }
    }
  }, [tabs, flushQueue]);

  const interrupt = useCallback((cwd: string) => {
    if (!cwd) return;
    // 中断：把待发队列整合为一条回填到输入框（不发出），用户中断当前轮后可继续编辑再发。
    // 同步清空 queue —— 抢在中断触发的 finalizeTurn（running→false）之前，避免自动 flush 把队列发出去。
    const t = tabsRef.current.find((x) => x.cwd === cwd);
    const q = t?.queue || [];
    if (t && q.length > 0) {
      const merged = q.map((i) => i.text).filter(Boolean).join('\n\n');
      // 时序：队列条目在前（更早入队），用户当前正在敲的草稿在后。草稿走外部 store。
      draftSet(cwd, [merged, getDraft(cwd).trim()].filter(Boolean).join('\n\n'));
      const seen = new Set((t.attachments || []).map((a) => a.id));
      const attachments = [...(t.attachments || [])];
      for (const a of q.flatMap((i) => i.attachments || [])) { if (!seen.has(a.id)) { seen.add(a.id); attachments.push(a); } }
      patchTab(cwd, { queue: [], attachments });
    }
    void localAgent.interrupt(realDir(cwd), paneLane(cwd));
  }, [patchTab]);

  /* ---- 多窗格：二叉分屏树（类 Wave）。把标签拖到某个窗格 → 该窗格一分为二，
         其余窗格自适应填充；分隔线可拖拽改比例。layout=null → 单窗（看 activeCwd）。 ---- */
  const gridCwds = useMemo(() => leavesOf(layout), [layout]);

  /** 把 dragCwd 拖到 targetCwd 窗格的某一边(side) → 在该边分裂出新窗格。
   *  dragCwd 若已在分屏里 = 移动（先摘后插）；否则 = 加入（至多 4）。
   *  分屏在一起的会话自动归入同一分组（默认名「未命名」）。 */
  const placePane = useCallback((targetCwd: string, dragCwd: string, side: DropSide) => {
    if (targetCwd === dragCwd) return;
    const dir: SplitDir = (side === 'left' || side === 'right') ? 'row' : 'col';
    const before = side === 'left' || side === 'top';
    setLayout((cur) => {
      const already = hasLeaf(cur, dragCwd);
      if (!already && leavesOf(cur).length >= 4) return cur;       // 加入时至多 4
      let base: LayoutNode | null = cur ? (already ? removeLeaf(cur, dragCwd) : cur) : null;
      if (!base) base = { kind: 'leaf', cwd: targetCwd };           // 树空了（如 2 格互换）→ 以 target 为底
      if (!hasLeaf(base, targetCwd)) return cur;                    // target 不在了 → 放弃
      return splitLeafSide(base, targetCwd, dragCwd, dir, before);
    });
    setActiveCwd(dragCwd);
    // 分组由下方 [layout] 副作用统一兜底（分屏在一起的会话自动归同一组）。
  }, []);

  /* ---- 自动分组：只要分屏里同时有 ≥2 个窗格，就把它们归入同一分组（沿用已有，
         否则新建「未命名」）。声明式兜底——不依赖拖拽时机/闭包，永远从真实状态对账。 ---- */
  useEffect(() => {
    const leaves = leavesOf(layout);
    if (leaves.length < 2) return;
    const inLayout = tabs.filter((t) => leaves.includes(t.cwd));
    if (inLayout.length < 2) return;
    // 只认仍然存在于 groups 里的分组（避免 tab 残留指向已删分组 → 永远不显示 chip）。
    const existing = inLayout.map((t) => t.groupId).find((gid) => gid && groups.some((g) => g.id === gid)) || undefined;
    if (existing && inLayout.every((t) => t.groupId === existing)) return;   // 已全在同组 → 防循环
    const gid = existing || `g-${Date.now()}-${groupSeqRef.current++}`;
    if (!existing) {
      setGroups((gs) => {
        if (gs.some((g) => g.id === gid)) return gs;
        const used = new Set(gs.map((g) => g.color));
        const color = TAB_COLORS.find((c) => !used.has(c)) || TAB_COLORS[gs.length % TAB_COLORS.length];
        return [...gs, { id: gid, name: tr('local.unnamedGroupName'), color, collapsed: false }];
      });
    }
    setTabs((ts) => clusterTabs(ts.map((t) => (leaves.includes(t.cwd) ? { ...t, groupId: gid } : t))));
  }, [layout, tabs, groups, tr]);

  /** 把某窗格移出网格；剩一个时塌缩回单窗。 */
  const removePane = useCallback((cwd: string) => {
    setLayout((cur) => {
      if (!cur) return cur;
      const next = removeLeaf(cur, cwd);
      if (next && next.kind === 'leaf') {
        const only = next.cwd;
        queueMicrotask(() => setActiveCwd(only));
        // 只剩一个异类叶子（wiki/chat）→ 保留为单叶布局（异类页没有 CLI 单窗形态，
        // 不能塌到 activeCwd 的 CLI 单窗，否则会去渲染一个名为 'wiki' 的 CLI 窗格）。
        return isForeignLeaf(only) ? next : null;
      }
      return next;
    });
  }, []);

  const setSplitRatio = useCallback((id: string, ratio: number) => {
    setLayout((cur) => (cur ? setRatioById(cur, id, ratio) : cur));
  }, []);

  // 标签关掉/项目移除时，把对应窗格从网格里剔除（剩一个则塌缩回单窗）。
  useEffect(() => {
    const open = new Set(tabs.map((t) => t.cwd));
    setLayout((cur) => {
      if (!cur) return cur;
      let next: LayoutNode | null = cur;
      for (const c of leavesOf(cur)) if (!open.has(c)) next = next ? removeLeaf(next, c) : null;
      if (next === cur) return cur;
      if (next && next.kind === 'leaf') { const only = next.cwd; queueMicrotask(() => setActiveCwd(only)); return null; }
      return next;
    });
  }, [tabs]);

  // 返回对象 useMemo：当所有底层 state 都没动时，la 保持同一引用，
  // 让外层的 React.memo（LocalAgentTree / Conversation / TopTabs 等）真正能 skip。
  // 关键场景：chat 在流式（useChatBackend 不停 setState 触发 ShellInner 重渲），
  // 而 useLocalAgent 的内部 state 完全没动 —— 这时 la 应当稳定。
  // dep 里 `activeTab` 覆盖了所有派生字段（activeSessionId / messages / liveMsgs / ...），
  // 因为 activeTab 引用变化当且仅当 tabs/activeCwd 变化。
  const la = useMemo(() => ({
    providers, provider, activeProvider, runningByProvider, attnByProvider, doneByProvider, current, detecting,
    cyclePermMode, commands, skills, modelOptions, modelsLoading, refreshModels, setModel, setReasoning, setMcp, listMcp, refreshMcp, reconnectMcp,
    projects, expanded, toggleProject, sessionsByPath, loadSessionsFor, pinnedSessions, toggleSessionPin, sessionTitles, renameSession,
    addProject, removeProject,
    tabs, activeCwd, setActiveTab, closeTab, closeOtherTabs, promoteTab, activeProject,
    layout, gridCwds, placePane, removePane, setSplitRatio,
    groups, createGroupFromTab, addTabToGroup, removeTabFromGroup, toggleGroup, setGroupColor, renameGroup, ungroupGroup, moveGroupBefore, moveTabBefore,
    activeSessionId: activeTab?.sessionId ?? null,
    sessionTitle: activeTab?.title ?? '',
    messages: activeTab?.messages ?? EMPTY_MSGS,
    liveMsgs: activeTab?.liveMsgs ?? EMPTY_MSGS,
    status: activeTab?.status ?? '',
    running: activeTab?.running ?? false,
    loadingSession: activeTab?.loading ?? false,
    perm: activeTab?.perm ?? null,
    question: activeTab?.question ?? null,
    elicit: activeTab?.elicit ?? null,
    setDraft, appendDraft, setSkill,
    addAttachments, removeAttachment, pickAttachments,
    openSession, ensureAgentSessionTab, handoffToSession, newSession, switchActiveProvider, deleteSession, send, forkSendText, prewarmDerive, dequeue, interrupt, respondPermission, answerQuestion, respondElicitation,
    loadOlder,
    lastSend: { tick: sendTick, cwd: lastSentCwdRef.current },
  }), [
    providers, provider, activeProvider, runningByProvider, attnByProvider, doneByProvider, current, detecting,
    cyclePermMode, commands, skills, modelOptions, modelsLoading, refreshModels, setModel, setReasoning, setMcp, listMcp, refreshMcp, reconnectMcp,
    projects, expanded, toggleProject, sessionsByPath, loadSessionsFor, pinnedSessions, toggleSessionPin, sessionTitles, renameSession,
    addProject, removeProject,
    tabs, activeCwd, setActiveTab, closeTab, closeOtherTabs, promoteTab, activeProject,
    layout, gridCwds, placePane, removePane, setSplitRatio,
    groups, createGroupFromTab, addTabToGroup, removeTabFromGroup, toggleGroup, setGroupColor, renameGroup, ungroupGroup, moveGroupBefore, moveTabBefore,
    activeTab,
    setDraft, appendDraft, setSkill,
    addAttachments, removeAttachment, pickAttachments,
    openSession, ensureAgentSessionTab, handoffToSession, newSession, switchActiveProvider, deleteSession, send, forkSendText, prewarmDerive, dequeue, interrupt, respondPermission, answerQuestion, respondElicitation,
    loadOlder,
    sendTick,
  ]);
  return la;
}

export type LocalAgentState = ReturnType<typeof useLocalAgent>;

const EMPTY_MSGS: TranscriptMessage[] = [];

import type { MsgPart } from './services/localAgent';

/** CLI 注入的本地命令回显（setModel/斜杠命令等的 stdout/stderr），不是对话内容。 */
function isLocalCommandNoise(parts: MsgPart[]): boolean {
  if (parts.length === 0) return false;
  return parts.every((p) => p.kind === 'text' && /^\s*<(local-command-(stdout|stderr)|command-(name|message|args|stdout|stderr))>/.test(p.text));
}

export function normalizeParts(message: any): MsgPart[] {
  if (!message) return [];
  const c = message.content;
  if (typeof c === 'string') return c.trim() ? [{ kind: 'text', text: c }] : [];
  if (!Array.isArray(c)) return [];
  const out: MsgPart[] = [];
  for (const p of c) {
    if (p.type === 'text' && p.text) out.push({ kind: 'text', text: p.text });
    else if (p.type === 'thinking' && p.thinking) out.push({ kind: 'thinking', text: p.thinking });
    else if (p.type === 'tool_use') out.push({ kind: 'tool_use', name: p.name || 'tool', input: p.input, id: p.id });
    else if (p.type === 'tool_result') {
      const txt = typeof p.content === 'string'
        ? p.content
        : Array.isArray(p.content) ? p.content.map((x: any) => x.text || '').join('\n') : '';
      out.push({ kind: 'tool_result', text: (txt || '').slice(0, 8000), isError: !!p.is_error, toolUseId: p.tool_use_id });
    }
  }
  return out;
}
