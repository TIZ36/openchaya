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
  type PermMode, type SlashCommand, type PermissionRequest, type PermissionDecision, type QuestionRequest,
  type TabGroup, type ModelInfo, type McpStatus, type Attachment,
} from './services/localAgent';
import { loadSkills, expandSkill, syncCliSkills, SKILLS_CHANGED_EVENT, type LocalSkill } from './services/skills';
import { api } from '../utils/apiClient';
import { TYPEWRITER_PRESETS, DEFAULT_TYPEWRITER, FINISH_DRAIN_SEC, type TypewriterConfig } from './typewriter';
import { useI18n } from '../i18n';

export type SessionsState = Record<string, SessionSummary[] | 'loading'>;

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
  draft: string;
  pendingLoad?: boolean;   // 从持久化恢复、尚未读盘载入的标签
  perm?: PermissionRequest | null;   // agent 正在等用户授权/选择
  question?: QuestionRequest | null; // agent 用 AskUserQuestion 抛来的选择题
  color: string;           // 偏好色（自动分配）：用于窗格头部/头像/边框
  groupId?: string | null; // 所属标签分组（类 Chrome 标签组），null = 未分组
  permMode: PermMode;      // 每个会话独立的权限模式（切一个不影响其他）
  model?: string;          // 每个会话选用的模型（空 = provider 默认）
  reasoning?: string;      // Codex 思考强度（空 = Codex 默认）
  skill?: string;          // 选中的 Chaya 技能名（composer pill；发送时用它包裹 draft 后展开）
  histMore?: number;       // 历史窗口化：还有多少条更早的消息没进时间线（藏在 histRef，上滑懒加载）
  mcp?: string[];          // 该会话启用的 MCP server 名字（空 = 不启用）
  mcpStatus?: McpStatus[]; // MCP 连接状态（来自 init / setMcp 回执）
  attachments?: Attachment[]; // 待发送的参考附件（拖入/选取的文件 + 粘贴图片），发送后清空
  queue?: QueuedMsg[];        // AI 处理中时用户继续发的指令：本轮结束后自动打包成一轮发出
}

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

function emptyTab(cwd: string, sessionId: string | null, title: string, color?: string, permMode: PermMode = 'default'): Tab {
  return { cwd, sessionId, title, color: color || nextColor(), messages: [], liveMsgs: [], status: '', running: false, loading: false, draft: '', permMode };
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

  // 启动即从持久化恢复 —— 放进 useState 初始值，首帧就正确。
  // 不再用 effect 恢复：那会与 reconciliation 副作用（prune/auto-group/layout-cleanup）
  // 及 StrictMode 的双跑竞态，把分组/分屏在恢复后又冲掉。
  const [boot] = useState(() => {
    const { tabs: s, activeCwd: a, groups: g, layout: l } = loadTabsState();
    const gidSet = new Set(g.map((x) => x.id));
    const modelMem = loadModelBySession();
    const reasoningMem = loadReasoningBySession();
    const mcpMem = loadMcpBySession();
    // 恢复的标签属于当前 provider：把不属于该 provider 档位集的权限模式归一到该 provider 的默认
    //（如 cursor 不认 default/acceptEdits → 落到 force；避免显示/行为串档）。
    const okPerm = permModesFor(provider);
    const t: Tab[] = s.map((x) => ({ ...emptyTab(x.cwd, x.sessionId, x.title), groupId: (x.groupId && gidSet.has(x.groupId)) ? x.groupId : null, permMode: (x.permMode && okPerm.includes(x.permMode)) ? x.permMode : defaultPermMode(provider), model: (x.sessionId && modelMem[x.sessionId]) || undefined, reasoning: (x.sessionId && reasoningMem[x.sessionId]) || undefined, mcp: (x.sessionId && mcpMem[x.sessionId]) || undefined, pendingLoad: !!x.sessionId }));
    const valid = new Set(t.map((x) => x.cwd));
    let lay: LayoutNode | null = null;
    if (l) { const pruned = pruneLayout(l as LayoutNode, valid); if (pruned && pruned.kind === 'split') lay = pruned; }
    const active = a && t.some((x) => x.cwd === a) ? a : (t.length ? t[t.length - 1].cwd : null);
    return { tabs: clusterTabs(t), activeCwd: active, groups: g, layout: lay };
  });

  // 多标签：每个 cwd 一个标签；activeCwd 是当前激活标签。
  const [tabs, setTabs] = useState<Tab[]>(boot.tabs);
  const [activeCwd, setActiveCwd] = useState<string | null>(boot.activeCwd);
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

  const current = providers.find((p) => p.id === provider);
  const activeTab = tabs.find((t) => t.cwd === activeCwd) || null;
  const activeProject = projects.find((p) => p.path === realDir(activeCwd || '')) || null;

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
    localAgent.detect(provider).then((cur) => {
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
    localAgent.listCommands(provider, realDir(activeCwd || '')).then((c) => { if (alive) setCommands(c); });
    return () => { alive = false; };
  }, [active, activeCwd, provider]);

  /* ---- cursor：进入即预拉 API Key（让随后的 warm/send 同步拿到，少一跳） ---- */
  useEffect(() => {
    if (active && provider === 'cursor') void fetchCursorKey();
  }, [active, provider, fetchCursorKey]);

  /* ---- 模型列表：进入 / 切 provider 即主动探测（不必先发消息）。探测较慢（claude 起一次性
   *      SDK query；copilot/gemini 起 ACP 连接），期间给按钮 loading 态。会话启动后的
   *      ev.models 事件仍会覆盖刷新成该会话真实模型。登录完成后也可手动 refreshModels()。 ---- */
  const modelsReqRef = useRef(0);
  const refreshModels = useCallback(() => {
    if (!current?.live) return Promise.resolve();
    const tok = ++modelsReqRef.current;
    setModelsLoading(true);
    const apiKey = provider === 'cursor' ? cursorKeyRef.current : undefined;
    return localAgent.listModels(provider, apiKey)
      .then((ms) => { if (tok === modelsReqRef.current && Array.isArray(ms) && ms.length) setModelOptions(ms); })
      .finally(() => { if (tok === modelsReqRef.current) setModelsLoading(false); });
  }, [provider, current?.live]);
  useEffect(() => {
    if (!active || !current?.live) return;
    setModelOptions([]);
    void refreshModels();
  }, [active, refreshModels]);

  /* ---- provider 切换：会话历史按 provider 区分，整体重置（项目目录跨 provider 保留） ---- */
  const prevProviderRef = useRef(provider);
  useEffect(() => {
    if (prevProviderRef.current === provider) return;
    prevProviderRef.current = provider;
    cursorKeyRef.current = null;   // 换 provider → 失效缓存的 cursor key（再进 cursor 重拉）
    smoothRef.current.clear();
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    for (const t of tabs) void localAgent.sessionClose(realDir(t.cwd), paneLane(t.cwd));   // 关掉所有常驻进程
    for (const [d, l] of specLaneRef.current) void localAgent.sessionClose(d, l);          // 关掉预热的待衍生会话
    specLaneRef.current.clear();
    setSessionsByPath({});
    // 注意：不清 expanded —— 项目目录跨 provider 保留，展开记忆也应保留。会话列表清空后
    // 走「懒加载」：下方 active-load 副作用只按新 provider 拉「当前激活项目」一个目录，
    // 其它展开项目点到了再拉（不再一把把所有展开目录都重拉）。
    setTabs([]);
    setActiveCwd(null);
    setLayout(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 每个会话独立切档：只改这个标签的 permMode，不动其他会话。按 provider 的档位集循环
  // （claude: default/plan/acceptEdits/bypass；cursor: plan/ask/force）。
  const cyclePermMode = useCallback((cwd: string) => {
    const list = permModesFor(provider);
    setTabs((ts) => ts.map((t) => {
      if (t.cwd !== cwd) return t;
      const i = list.indexOf(t.permMode);
      const next = i < 0 ? defaultPermMode(provider) : list[(i + 1) % list.length];   // 当前档不属于该 provider → 回默认档
      void localAgent.setPermMode(realDir(cwd), next, paneLane(cwd));   // 进行中的常驻会话即时切档
      return { ...t, permMode: next };
    }));
  }, [provider]);

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
    setSessionsByPath((m) => ({ ...m, [dir]: 'loading' }));
    let ss = await localAgent.listSessions(provider, dir);
    if (provider === 'codex') {
      const imported = loadCodexImportedSessions()[dir];
      if (imported && imported.length) {
        const allow = new Set(imported);
        ss = ss.filter((s) => allow.has(s.sessionId));
      }
    }
    setSessionsByPath((m) => ({ ...m, [dir]: ss }));
  }, [provider, codexImportsTick]);

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
  }, [active, provider, projects, sessionsByPath, codexImportsTick, loadSessionsFor]);

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
    }
    setTabs((ts) => ts.filter((t) => realDir(t.cwd) !== dir));
    setActiveCwd((c) => (c && realDir(c) === dir ? null : c));
  }, [dropSmooth, tabs]);

  /* ---- 标签操作：每个 session 一个独立窗格(pane)；同项目多个 session 并存同时跑 ----
   * 给项目分配 paneKey：项目还没开过 → 裸 dir；已开过 → 新 lane(dir#@#lane)。 */
  const paneKeyForDir = useCallback((dir: string): string =>
    tabs.some((t) => t.cwd === dir) ? makePaneKey(dir, nextLaneId()) : dir
  , [tabs]);

  /* 新增一个会话窗格：紧挨触发它的标签插入、继承其分组；不 sessionClose 旧会话
   * （这是同项目多会话并行的关键——旧实现是替换+关进程，只能一个）。
   * paneKey 已存在（裸 dir 首会话复用）→ 替换该标签并保留偏好色。 */
  const addPaneTab = useCallback((paneKey: string, sessionId: string | null, title: string, sourceCwd?: string): void => {
    const defPerm = defaultPermMode(provider);
    dropSmooth(paneKey);
    pendingByCwd.current.delete(paneKey);
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.cwd === paneKey);
      if (i >= 0) {
        const next = [...ts];
        next[i] = emptyTab(paneKey, sessionId, title, ts[i].color, defPerm);
        return next;
      }
      const src = sourceCwd ?? activeCwd ?? undefined;
      const srcIdx = src ? ts.findIndex((t) => t.cwd === src) : -1;
      const srcTab = srcIdx >= 0 ? ts[srcIdx] : undefined;
      const fresh: Tab = { ...emptyTab(paneKey, sessionId, title, undefined, defPerm), groupId: srcTab?.groupId ?? null };
      const arr = srcIdx >= 0 ? [...ts.slice(0, srcIdx + 1), fresh, ...ts.slice(srcIdx + 1)] : [...ts, fresh];
      return clusterTabs(arr);
    });
    setActiveCwd(paneKey);
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
    const existing = tabs.find((t) => realDir(t.cwd) === dir && t.sessionId === sid);
    if (existing) { setActiveCwd(existing.cwd); return; }
    const paneKey = paneKeyForDir(dir);
    addPaneTab(paneKey, sid, title, sourceCwd);
    const remembered = permMemRef.current[sid];
    const pm = (remembered && permModesFor(provider).includes(remembered)) ? remembered : defaultPermMode(provider);
    const md = modelMemRef.current[sid] || undefined;
    const rs = reasoningMemRef.current[sid] || undefined;
    const mc = mcpMemRef.current[sid] || undefined;
    // 回显：默认切到该会话上次记住的权限级别 + 模型 + MCP。
    patchTab(paneKey, { loading: true, permMode: pm, model: md, reasoning: rs, mcp: mc });
    // 预热：立刻起常驻进程（含 resume 读盘）；冷启在「载入会话…」期间付掉，发送时已暖。
    // cursor 无常驻进程，warm 只登记状态 + 拉模型；apiKey 注入（已预拉则同步可得）。
    if (current?.live) void localAgent.warm({ provider, cwd: dir, lane: paneLane(paneKey), sessionId: sid, permMode: pm, model: md, reasoning: rs, mcp: mc, apiKey: provider === 'cursor' ? cursorKeyRef.current : undefined });
    const { messages: msgs } = await localAgent.readSession(provider, dir, sid);
    setHistory(paneKey, sid, msgs);
  }, [provider, current, tabs, paneKeyForDir, addPaneTab, patchTab, setHistory]);

  // 新建会话：同样开成独立新窗格，紧挨触发它的标签。
  // providerOverride：从 composer 切 provider 时显式带入目标 provider —— 直接用它预热，
  // 不依赖「先 setState 改全局 provider → 等重渲染」的时序（那条链路易踩 stale 闭包）。
  const newSession = useCallback((projPath: string, sourceCwd?: string, providerOverride?: ProviderId) => {
    const prov = providerOverride || provider;
    const dir = realDir(projPath);
    const paneKey = paneKeyForDir(dir);
    addPaneTab(paneKey, null, tr('local.newSession'), sourceCwd);
    // 预热新会话：先把进程起好，首条消息即暖。warm/send 本就按 call 传 provider，
    // 所以新 lane 可立刻用目标 provider 起，无需等全局 provider 落定。
    const det = providers.find((p) => p.id === prov);
    if (det?.live) void localAgent.warm({ provider: prov, cwd: dir, lane: paneLane(paneKey), sessionId: null, permMode: defaultPermMode(prov), apiKey: prov === 'cursor' ? cursorKeyRef.current : undefined });
  }, [provider, providers, paneKeyForDir, addPaneTab, tr]);

  const closeTab = useCallback((cwd: string) => {
    dropSmooth(cwd);
    histRef.current.delete(cwd);
    void localAgent.sessionClose(realDir(cwd), paneLane(cwd));   // 关标签 → 回收常驻进程
    pendingByCwd.current.delete(cwd);
    setTabs((ts) => {
      const next = ts.filter((t) => t.cwd !== cwd);
      setActiveCwd((c) => (c === cwd ? (next.length ? next[next.length - 1].cwd : null) : c));
      return next;
    });
  }, [dropSmooth]);

  /* ---- 持久化：所有打开的标签 + 激活标签 + 分组 + 分屏树。
         恢复已挪到 useState 初始值（见上方 boot），这里只负责写。
         跳过首帧避免用初始值原样回写（无谓写入）。
         关键性能点：tabs 引用在流式期间每帧都变（livePreview/liveMsgs），但落盘的
         只有下面这几个低频字段——用结构指纹作依赖，避免打字机每帧同步写 localStorage。 ---- */
  const firstSaveRef = useRef(true);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const tabsPersistFp = tabs.map((t) => `${t.cwd}|${t.sessionId ?? ''}|${t.title}|${t.groupId ?? ''}|${t.permMode ?? ''}`).join('§');
  useEffect(() => {
    if (firstSaveRef.current) { firstSaveRef.current = false; return; }
    const ts = tabsRef.current;
    const liveGroupIds = new Set(ts.map((t) => t.groupId).filter(Boolean));
    saveTabsState(
      ts.map((t) => ({ cwd: t.cwd, sessionId: t.sessionId, title: t.title, groupId: t.groupId ?? null, permMode: t.permMode })),
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
    localAgent.readSession(provider, realDir(activeCwd), sid).then(({ messages: msgs }) => setHistory(activeCwd, sid, msgs));
  }, [active, activeCwd, tabs, provider, patchTab, setHistory]);

  const setActiveTab = useCallback((cwd: string) => setActiveCwd(cwd), []);

  // 草稿/发送/中断都按 cwd 寻址（多窗格下每个窗独立）。
  const setDraft = useCallback((cwd: string, v: string) => { patchTab(cwd, { draft: v }); }, [patchTab]);
  /** 选/清 Chaya 技能（composer pill）。空字符串/undefined = 清除。 */
  const setSkill = useCallback((cwd: string, name: string | undefined) => { patchTab(cwd, { skill: name || undefined }); }, [patchTab]);
  /** 往某标签的输入框追加文本（评审「发送到对话」用）：稳定引用，不随 draft 变化。 */
  const appendDraft = useCallback((cwd: string, text: string) => {
    patchTab(cwd, (t) => ({ draft: (t.draft ? `${t.draft}\n\n` : '') + text }));
  }, [patchTab]);

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
    const res = await localAgent.deleteSession(provider, realDir(cwd), sid);
    if (!res.ok) void loadSessionsFor(cwd);
    return res;
  }, [provider, loadSessionsFor, closeTab]);

  function handleEvent(cwd: string, ev: any) {
    const t = ev?.type;
    const parentId: string | null = (ev && ev.parent_tool_use_id) || null;
    // 子 agent（Task）的生命周期/流式不驱动主回合、也不吐进主预览；但它的 assistant/user
    // 消息要保留（带 parentId），好在渲染时收进对应 Task 卡片里（见 buildBlocks 嵌套）。
    if (t === 'models') {   // 主进程拉到的可选模型 → 填模型选择器
      if (Array.isArray(ev.models) && ev.models.length) setModelOptions(ev.models);
      return;
    }
    if (t === 'system' && ev.subtype === 'init') {
      if (parentId) return;
      if (ev.session_id) pendingByCwd.current.set(cwd, ev.session_id);
      // init 带 MCP 连接状态 → 存到该标签供 MCP 控件显示。
      const mcpStatus = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : undefined;
      // 预热（用户还没发送）时 init 也会来——此时 running=false，别显示「处理中」。
      patchTab(cwd, (tab) => ({ ...(tab.running ? { status: tr('local.status.processing') } : {}), ...(mcpStatus ? { mcpStatus } : {}) }));
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
      patchTab(cwd, { question: { permId: ev.permId, questions: (ev.input && ev.input.questions) || [] }, status: tr('local.status.awaitingChoice') });
      return;
    }
    if (t === 'permission_request') {
      patchTab(cwd, {
        perm: {
          permId: ev.permId, toolName: ev.toolName, input: ev.input,
          title: ev.title, displayName: ev.displayName, description: ev.description, suggestions: ev.suggestions,
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
    const pending = pendingByCwd.current.get(cwd) || null;
    patchTab(cwd, (tab) => {
      if (!tab.running && tab.liveMsgs.length === 0) return {}; // 已收尾，避免重复
      const sid = pending || tab.sessionId;
      // 记住这个会话「最后一次发送时的权限级别」，重开历史会话时默认切回它。
      if (sid) { permMemRef.current[sid] = tab.permMode; savePermBySession(permMemRef.current); }
      return {
        messages: [...tab.messages, ...tab.liveMsgs],
        liveMsgs: [], running: false, perm: null, question: null,
        sessionId: sid,
        status: errStatus || '',
      };
    });
    void loadSessionsFor(cwd);   // 新会话拿到真实 id / 已更新 → 刷新左栏
    expandProject(cwd);
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

  /** 真正把一轮发给后端：拼用户气泡、running=true、调 localAgent.send。
   *  text/attachments 显式传入（manual send 来自 draft，队列 flush 来自打包后的队列）。
   *  clearComposer：manual send 把 draft/附件清空；队列 flush 不动用户正在敲的 draft。 */
  const dispatchTurn = useCallback(async (cwd: string, sendText: string, displayText: string, attachments: Attachment[], clearComposer: boolean, skillName?: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!cwd || !tab) return;
    if (!current?.installed || !current?.live) { patchTab(cwd, { status: `⚠ ${tr('local.status.unavailable', { provider: current?.label || provider })}` }); return; }
    const sid = tab.sessionId;   // 仅首条用于 resume；常驻会话已存在时后端忽略
    // cursor headless 必需 API Key——优先用缓存，没有则现拉（拉不到则主进程会回 error 提示去设置录入）。
    const apiKey = provider === 'cursor' ? (cursorKeyRef.current || await fetchCursorKey()) : undefined;
    dropSmooth(cwd);
    // 气泡里把附件名缀在用户文本后，让发出去的这一轮一眼看出带了哪些参考。
    const attNote = attachments.length ? `${displayText ? '\n' : ''}📎 ${attachments.map((a) => a.name).join('、')}` : '';
    // 气泡显示「技能 pill + 用户原话」，CLI 收到的是展开后的 sendText（两者解耦）。
    const parts: MsgPart[] = skillName
      ? [{ kind: 'skill', name: skillName }, { kind: 'text', text: displayText + attNote }]
      : [{ kind: 'text', text: displayText + attNote }];
    patchTab(cwd, (t) => ({
      ...(clearComposer ? { draft: '', attachments: [], skill: undefined } : {}),
      messages: [...t.messages, { role: 'user', parts, ts: null, uuid: null }],
      liveMsgs: [], running: true, status: tr('local.status.processingShort'), perm: null, question: null,
    }));
    const res = await localAgent.send({ provider, cwd: realDir(cwd), lane: paneLane(cwd), sessionId: sid, prompt: sendText, permMode: tab.permMode, model: tab.model, reasoning: tab.reasoning, mcp: tab.mcp, apiKey, attachments });
    if (!res.ok) patchTab(cwd, (t) => ({ running: false, status: t.status.startsWith('⚠') ? t.status : `⚠ ${tr('local.status.startFailed')}` }));
  }, [tabs, current, provider, patchTab, dropSmooth, fetchCursorKey, tr]);

  const queueSeqRef = useRef(0);
  const mkQueueId = () => `q-${Date.now()}-${queueSeqRef.current++}`;

  const send = useCallback(async (cwd: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!cwd || !tab) return;
    const raw = tab.draft.trim();
    const attachments = tab.attachments || [];
    if (!raw && attachments.length === 0 && !tab.skill) return;
    if (tab.perm && attachments.length === 0) {
      const shortcut = normalizePermissionShortcut(raw);
      if (shortcut) {
        patchTab(cwd, { draft: '', attachments: [] });
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
    let skillName: string | undefined;
    const picked = tab.skill ? skillsRef.current.find((s) => s.name === tab.skill) : null;
    if (picked) {
      sendText = picked.body.includes('{{input}}') ? picked.body.split('{{input}}').join(raw) : (raw ? `${picked.body}\n\n${raw}` : picked.body);
      skillName = picked.name;
    } else {
      const ex = expandSkill(raw, skillsRef.current);
      if (ex != null) { sendText = ex; skillName = /^\s*\/([a-zA-Z0-9_-]+)/.exec(raw)?.[1]; }
    }
    // AI 处理中（含等权限/选择）→ 不阻塞输入，入队；本轮收尾后由 flush 副作用打包发出（队列发展开后的 sendText）。
    if (tab.running) {
      patchTab(cwd, (t) => ({
        draft: '', attachments: [], skill: undefined,
        queue: [...(t.queue || []), { id: mkQueueId(), text: sendText, attachments }],
      }));
      return;
    }
    await dispatchTurn(cwd, sendText, raw, attachments, true, skillName);
  }, [tabs, patchTab, respondPermission, dispatchTurn, tr]);

  /** 衍生：在当前 cwd 新开一个全新 session，并立刻把 text 作为首条发出。
   *  与原 session 地位一致（普通会话、进项目树、可再次衍生）。必须先 sessionClose 关掉
   *  当前常驻进程——否则带 sessionId:null 的 send 会被复用到旧会话，而非新建。 */
  // 预热：选中 AI 文本时就为该目录后台冷启一条「待衍生」会话（每目录至多 1 条）；
  // 用户点「展开讲讲」时直接消费它 → 跳过大半冷启，首 token 快很多。dir → 预热 laneId。
  const specLaneRef = useRef<Map<string, string>>(new Map());

  /** 选中 AI 回答时调用：后台预热一条衍生会话（claude 才有常驻进程可预热）。 */
  const prewarmDerive = useCallback((cwd: string) => {
    if (provider !== 'claude' || !current?.live) return;
    const dir = realDir(cwd);
    if (specLaneRef.current.has(dir)) return;        // 已有预热中 → 不重复
    const lane = nextLaneId();
    specLaneRef.current.set(dir, lane);
    const src = tabs.find((t) => t.cwd === cwd);
    void localAgent.warm({ provider, cwd: dir, lane, sessionId: null, permMode: src?.permMode ?? defaultPermMode(provider), model: src?.model, reasoning: src?.reasoning, mcp: src?.mcp });
  }, [provider, current, tabs]);

  /** 衍生：在当前 cwd 下新开一个**独立会话窗格**（新 lane = 同目录并行常驻会话），
   *  作为新标签紧挨源标签插入并立刻把 text 作为首条发出。与普通会话地位一致；想并排看
   *  自行把标签拖去分屏。性能：优先消费 prewarmDerive 预热好的会话；send（冷启）提前 kick off。 */
  const forkSendText = useCallback(async (cwd: string, rawText: string) => {
    const text = (rawText || '').trim();
    if (!cwd || !text) return;
    if (!current?.installed || !current?.live) { patchTab(cwd, { status: `⚠ ${tr('local.status.unavailable', { provider: current?.label || provider })}` }); return; }
    const dir = realDir(cwd);
    const spec = specLaneRef.current.get(dir);       // 已预热的会话 → 直接用，跳过大半冷启
    const lane = spec ?? nextLaneId();
    if (spec) specLaneRef.current.delete(dir);
    const paneKey = makePaneKey(dir, lane);
    const src = tabs.find((t) => t.cwd === cwd);     // 继承当前窗格的 model/mcp/perm + 分组
    const permMode = src?.permMode ?? defaultPermMode(provider);
    const apiKey = provider === 'cursor' ? (cursorKeyRef.current || await fetchCursorKey()) : undefined;
    // 先 kick off send（预热则瞬时；冷启也尽早开始），与下面建窗格/渲染并行。
    const sendP = localAgent.send({ provider, cwd: dir, lane, sessionId: null, prompt: text, permMode, model: src?.model, reasoning: src?.reasoning, mcp: src?.mcp, apiKey });
    // 直接建窗格紧挨源标签插入（不走 addPaneTab —— 这里要预填用户消息 + running 态）。
    setTabs((ts) => {
      if (ts.some((t) => t.cwd === paneKey)) return ts;
      const newTab: Tab = {
        ...emptyTab(paneKey, null, tr('local.newSession'), undefined, permMode),
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
  }, [tabs, current, provider, patchTab, fetchCursorKey, tr]);

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
    patchTab(cwd, (t) => {
      const q = t.queue || [];
      if (q.length === 0) return {};
      const merged = q.map((i) => i.text).filter(Boolean).join('\n\n');
      // 时序：队列条目在前（更早入队），用户当前正在敲的草稿在后。
      const draft = [merged, t.draft.trim()].filter(Boolean).join('\n\n');
      const seen = new Set((t.attachments || []).map((a) => a.id));
      const attachments = [...(t.attachments || [])];
      for (const a of q.flatMap((i) => i.attachments || [])) { if (!seen.has(a.id)) { seen.add(a.id); attachments.push(a); } }
      return { queue: [], draft, attachments };
    });
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
    providers, provider, current, detecting,
    cyclePermMode, commands, skills, modelOptions, modelsLoading, refreshModels, setModel, setReasoning, setMcp, listMcp, refreshMcp, reconnectMcp,
    projects, expanded, toggleProject, sessionsByPath, loadSessionsFor,
    addProject, removeProject,
    tabs, activeCwd, setActiveTab, closeTab, activeProject,
    layout, gridCwds, placePane, removePane, setSplitRatio,
    groups, createGroupFromTab, addTabToGroup, removeTabFromGroup, toggleGroup, setGroupColor, renameGroup, ungroupGroup, moveGroupBefore, moveTabBefore,
    activeSessionId: activeTab?.sessionId ?? null,
    sessionTitle: activeTab?.title ?? '',
    messages: activeTab?.messages ?? EMPTY_MSGS,
    liveMsgs: activeTab?.liveMsgs ?? EMPTY_MSGS,
    status: activeTab?.status ?? '',
    running: activeTab?.running ?? false,
    loadingSession: activeTab?.loading ?? false,
    draft: activeTab?.draft ?? '',
    perm: activeTab?.perm ?? null,
    question: activeTab?.question ?? null,
    setDraft, appendDraft, setSkill,
    addAttachments, removeAttachment, pickAttachments,
    openSession, newSession, deleteSession, send, forkSendText, prewarmDerive, dequeue, interrupt, respondPermission, answerQuestion,
    loadOlder,
  }), [
    providers, provider, current, detecting,
    cyclePermMode, commands, skills, modelOptions, modelsLoading, refreshModels, setModel, setReasoning, setMcp, listMcp, refreshMcp, reconnectMcp,
    projects, expanded, toggleProject, sessionsByPath, loadSessionsFor,
    addProject, removeProject,
    tabs, activeCwd, setActiveTab, closeTab, activeProject,
    layout, gridCwds, placePane, removePane, setSplitRatio,
    groups, createGroupFromTab, addTabToGroup, removeTabFromGroup, toggleGroup, setGroupColor, renameGroup, ungroupGroup, moveGroupBefore, moveTabBefore,
    activeTab,
    setDraft, appendDraft, setSkill,
    addAttachments, removeAttachment, pickAttachments,
    openSession, newSession, deleteSession, send, forkSendText, prewarmDerive, dequeue, interrupt, respondPermission, answerQuestion,
    loadOlder,
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
