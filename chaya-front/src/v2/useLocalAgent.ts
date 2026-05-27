/**
 * 本地 Agent 状态钩子 —— 纯本地，与 Chaya 后端无关。
 *
 * 多标签模型（类浏览器）：每个项目目录(cwd)最多一个打开的会话标签 → 标签以 cwd 为键，
 * 当前激活标签即 activeCwd。每个标签独立保留自己的对话状态（消息/流式/草稿/运行中），
 * 切换标签互不打断，后台流式照常推进（事件按 runId→cwd 路由）。
 *
 * provider 由设置决定；探测惰性触发（进入才 detect）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  localAgent, loadProjects, addProject as addProjectStore, removeProject as removeProjectStore,
  loadTabsState, saveTabsState, loadPermBySession, savePermBySession, PERM_MODES,
  type DetectedProvider, type ProviderId, type SessionSummary, type TranscriptMessage, type LocalProject,
  type PermMode, type SlashCommand, type PermissionRequest, type PermissionDecision, type QuestionRequest,
  type TabGroup,
} from './services/localAgent';
import { TYPEWRITER_PRESETS, DEFAULT_TYPEWRITER, FINISH_DRAIN_SEC, type TypewriterConfig } from './typewriter';

export type SessionsState = Record<string, SessionSummary[] | 'loading'>;

/** 一个打开的标签（= 一个项目的当前会话），自带完整对话状态。 */
export interface Tab {
  cwd: string;
  sessionId: string | null;     // null = 尚未落盘的新会话
  title: string;
  messages: TranscriptMessage[];
  liveMsgs: TranscriptMessage[];
  livePreview: string;
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
}

// 自动分配的窗格 / 分组色板（沉静、互相可辨；非强饱和，贴合 letterpress 调性）。
export const TAB_COLORS = ['#c2562f', '#4f46e5', '#3a8a6e', '#b05a7a', '#b8862f', '#5e8bd0', '#8a6fc0', '#3f8e8a'];
let _colorSeq = 0;
function nextColor(): string { return TAB_COLORS[_colorSeq++ % TAB_COLORS.length]; }

function emptyTab(cwd: string, sessionId: string | null, title: string, color?: string): Tab {
  return { cwd, sessionId, title, color: color || nextColor(), messages: [], liveMsgs: [], livePreview: '', status: '', running: false, loading: false, draft: '', permMode: 'default' };
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
function pruneLayout(n: LayoutNode, valid: Set<string>): LayoutNode | null {
  if (n.kind === 'leaf') return valid.has(n.cwd) ? n : null;
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

export function useLocalAgent(active: boolean, provider: ProviderId, typewriter: TypewriterConfig = DEFAULT_TYPEWRITER) {
  // Live typewriter config (toggle + speed) read by the rAF pump without re-binding it.
  const twRef = useRef<TypewriterConfig>(typewriter);
  twRef.current = typewriter;

  const [providers, setProviders] = useState<DetectedProvider[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);

  const [projects, setProjects] = useState<LocalProject[]>(() => loadProjects());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessionsByPath, setSessionsByPath] = useState<SessionsState>({});

  // 启动即从持久化恢复 —— 放进 useState 初始值，首帧就正确。
  // 不再用 effect 恢复：那会与 reconciliation 副作用（prune/auto-group/layout-cleanup）
  // 及 StrictMode 的双跑竞态，把分组/分屏在恢复后又冲掉。
  const [boot] = useState(() => {
    const { tabs: s, activeCwd: a, groups: g, layout: l } = loadTabsState();
    const gidSet = new Set(g.map((x) => x.id));
    const t: Tab[] = s.map((x) => ({ ...emptyTab(x.cwd, x.sessionId, x.title), groupId: (x.groupId && gidSet.has(x.groupId)) ? x.groupId : null, permMode: (x.permMode && PERM_MODES.includes(x.permMode)) ? x.permMode : 'default', pendingLoad: !!x.sessionId }));
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
  // 事件处理函数放 ref，订阅一次也总调用最新闭包（避免 provider/projects 变了仍用旧的）。
  const handleEventRef = useRef<(cwd: string, ev: any) => void>(() => {});

  const current = providers.find((p) => p.id === provider);
  const activeTab = tabs.find((t) => t.cwd === activeCwd) || null;
  const activeProject = projects.find((p) => p.path === activeCwd) || null;

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
        patchTab(cwd, { livePreview: sm.raw.slice(0, nextShown) });
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
  }, [patchTab]);

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
      patchTab(cwd, { livePreview: sm.raw });
      return;
    }
    ensurePump();
  }, [ensurePump, patchTab]);

  const dropSmooth = useCallback((cwd: string) => { smoothRef.current.delete(cwd); }, []);

  // 卸载时停掉 rAF。
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  /* ---- 惰性探测 ---- */
  useEffect(() => {
    if (!active || detectedRef.current) return;
    detectedRef.current = true;
    setDetecting(true);
    localAgent.detect().then(setProviders).finally(() => setDetecting(false));
  }, [active]);

  /* ---- 斜杠命令：进入即加载（无项目用 home），随激活项目/ provider 重取 ---- */
  useEffect(() => {
    if (!active) return;
    let alive = true;
    localAgent.listCommands(provider, activeCwd || '').then((c) => { if (alive) setCommands(c); });
    return () => { alive = false; };
  }, [active, activeCwd, provider]);

  /* ---- provider 切换：会话历史按 provider 区分，整体重置（项目目录跨 provider 保留） ---- */
  const prevProviderRef = useRef(provider);
  useEffect(() => {
    if (prevProviderRef.current === provider) return;
    prevProviderRef.current = provider;
    smoothRef.current.clear();
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    for (const t of tabs) void localAgent.sessionClose(t.cwd);   // 关掉所有常驻进程
    setSessionsByPath({});
    setExpanded(new Set());
    setTabs([]);
    setActiveCwd(null);
    setLayout(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // 每个会话独立切档：只改这个标签的 permMode，不动其他会话。
  const cyclePermMode = useCallback((cwd: string) => {
    setTabs((ts) => ts.map((t) => {
      if (t.cwd !== cwd) return t;
      const next = PERM_MODES[(PERM_MODES.indexOf(t.permMode) + 1) % PERM_MODES.length];
      void localAgent.setPermMode(cwd, next);   // 进行中的常驻会话即时切档
      return { ...t, permMode: next };
    }));
  }, []);

  /* ---- 实时事件订阅（常驻会话按 cwd 路由到对应标签） ---- */
  useEffect(() => {
    const off = localAgent.onEvent(({ cwd, ev }) => handleEventRef.current(cwd, ev));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSessionsFor = useCallback(async (path: string) => {
    setSessionsByPath((m) => ({ ...m, [path]: 'loading' }));
    const ss = await localAgent.listSessions(provider, path);
    setSessionsByPath((m) => ({ ...m, [path]: ss }));
  }, [provider]);

  const toggleProject = useCallback((p: LocalProject) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(p.id)) next.delete(p.id);
      else { next.add(p.id); if (!sessionsByPath[p.path]) void loadSessionsFor(p.path); }
      return next;
    });
  }, [sessionsByPath, loadSessionsFor]);

  const expandProject = useCallback((cwd: string) => {
    const p = projects.find((x) => x.path === cwd);
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
    setProjects(removeProjectStore(id));
    dropSmooth(path);
    void localAgent.sessionClose(path);
    pendingByCwd.current.delete(path);
    setTabs((ts) => ts.filter((t) => t.cwd !== path));
    setActiveCwd((c) => (c === path ? null : c));
  }, [dropSmooth]);

  /* ---- 标签操作：每个 cwd 最多一个标签；同项目开新会话替换该项目的标签 ---- */
  const upsertTab = useCallback((cwd: string, sessionId: string | null, title: string): boolean => {
    let existed = false;
    dropSmooth(cwd);  // 换会话 → 丢弃旧标签的平滑状态
    void localAgent.sessionClose(cwd);   // 切到新会话 → 关掉旧的常驻进程，下次发送按新 sid 重起
    pendingByCwd.current.delete(cwd);
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.cwd === cwd);
      if (i >= 0) {
        existed = true;
        // 同项目换会话：替换该标签（保留其偏好色）
        const next = [...ts];
        next[i] = emptyTab(cwd, sessionId, title, ts[i].color);
        return next;
      }
      return [...ts, emptyTab(cwd, sessionId, title)];
    });
    setActiveCwd(cwd);
    return existed;
  }, [dropSmooth]);

  const openSession = useCallback(async (cwd: string, sid: string, title: string) => {
    upsertTab(cwd, sid, title);
    const pm = permMemRef.current[sid] || 'default';
    // 回显：默认切到该会话上次发送时记住的权限级别。
    patchTab(cwd, { loading: true, permMode: pm });
    // 预热：立刻起常驻进程（含 resume 读盘）；冷启在「载入会话…」期间付掉，发送时已暖。
    if (current?.live) void localAgent.warm({ provider, cwd, sessionId: sid, permMode: pm });
    const { messages: msgs } = await localAgent.readSession(provider, cwd, sid);
    patchTab(cwd, { messages: msgs, loading: false });
  }, [provider, current, upsertTab, patchTab]);

  const newSession = useCallback((cwd: string) => {
    upsertTab(cwd, null, '新会话');
    // 预热新会话：先把进程起好，首条消息即暖。
    if (current?.live) void localAgent.warm({ provider, cwd, sessionId: null, permMode: 'default' });
  }, [provider, current, upsertTab]);

  const closeTab = useCallback((cwd: string) => {
    dropSmooth(cwd);
    void localAgent.sessionClose(cwd);   // 关标签 → 回收常驻进程
    pendingByCwd.current.delete(cwd);
    setTabs((ts) => {
      const next = ts.filter((t) => t.cwd !== cwd);
      setActiveCwd((c) => (c === cwd ? (next.length ? next[next.length - 1].cwd : null) : c));
      return next;
    });
  }, [dropSmooth]);

  /* ---- 持久化：所有打开的标签 + 激活标签 + 分组 + 分屏树。
         恢复已挪到 useState 初始值（见上方 boot），这里只负责写。
         跳过首帧避免用初始值原样回写（无谓写入）。 ---- */
  const firstSaveRef = useRef(true);
  useEffect(() => {
    if (firstSaveRef.current) { firstSaveRef.current = false; return; }
    const liveGroupIds = new Set(tabs.map((t) => t.groupId).filter(Boolean));
    saveTabsState(
      tabs.map((t) => ({ cwd: t.cwd, sessionId: t.sessionId, title: t.title, groupId: t.groupId ?? null, permMode: t.permMode })),
      activeCwd,
      groups.filter((g) => liveGroupIds.has(g.id)),
      layout,
    );
  }, [tabs, activeCwd, groups, layout]);

  /* ---- 惰性续传：进入 Local Agents 后，激活的待载入标签读盘载入对话。 ---- */
  useEffect(() => {
    if (!active || !activeCwd) return;
    const tab = tabs.find((t) => t.cwd === activeCwd);
    if (!tab || !tab.pendingLoad || !tab.sessionId || tab.loading) return;
    patchTab(activeCwd, { loading: true, pendingLoad: false });
    const sid = tab.sessionId;
    localAgent.readSession(provider, activeCwd, sid).then(({ messages: msgs }) => {
      patchTab(activeCwd, { messages: msgs, loading: false });
    });
  }, [active, activeCwd, tabs, provider, patchTab]);

  const setActiveTab = useCallback((cwd: string) => setActiveCwd(cwd), []);

  // 草稿/发送/中断都按 cwd 寻址（多窗格下每个窗独立）。
  const setDraft = useCallback((cwd: string, v: string) => { patchTab(cwd, { draft: v }); }, [patchTab]);

  /* ---- 标签分组（类 Chrome 标签组）：合并多个标签、设色、折叠/展开。 ---- */
  const groupSeqRef = useRef(0);
  const createGroupFromTab = useCallback((cwd: string) => {
    const id = `g-${Date.now()}-${groupSeqRef.current++}`;
    setGroups((gs) => {
      const used = new Set(gs.map((g) => g.color));
      const color = TAB_COLORS.find((c) => !used.has(c)) || TAB_COLORS[gs.length % TAB_COLORS.length];
      return [...gs, { id, name: '新分组', color, collapsed: false }];
    });
    setTabs((ts) => clusterTabs(ts.map((t) => (t.cwd === cwd ? { ...t, groupId: id } : t))));
    return id;
  }, []);
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

  /** 删除会话（移到回收站）。乐观从列表移除；若某标签正开着它则清空该标签会话。 */
  const deleteSession = useCallback(async (cwd: string, sid: string) => {
    setSessionsByPath((m) => {
      const cur = m[cwd];
      if (!Array.isArray(cur)) return m;
      return { ...m, [cwd]: cur.filter((s) => s.sessionId !== sid) };
    });
    setTabs((ts) => ts.map((t) => {
      if (t.cwd === cwd && t.sessionId === sid) { dropSmooth(cwd); return emptyTab(cwd, null, '新会话', t.color); }
      return t;
    }));
    const res = await localAgent.deleteSession(provider, cwd, sid);
    if (!res.ok) void loadSessionsFor(cwd);
    return res;
  }, [provider, loadSessionsFor, dropSmooth]);

  function handleEvent(cwd: string, ev: any) {
    const t = ev?.type;
    const parentId: string | null = (ev && ev.parent_tool_use_id) || null;
    // 子 agent（Task）的生命周期/流式不驱动主回合、也不吐进主预览；但它的 assistant/user
    // 消息要保留（带 parentId），好在渲染时收进对应 Task 卡片里（见 buildBlocks 嵌套）。
    if (t === 'system' && ev.subtype === 'init') {
      if (parentId) return;
      if (ev.session_id) pendingByCwd.current.set(cwd, ev.session_id);
      // 预热（用户还没发送）时 init 也会来——此时 running=false，别显示「处理中」。
      patchTab(cwd, (tab) => (tab.running ? { status: 'Agent 处理中…' } : {}));
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
      const merge = () => patchTab(cwd, (tab) => ({
        liveMsgs: parts.length > 0 ? [...tab.liveMsgs, { role: t, parts, ts: null, uuid: ev.uuid || null, parentId }] : tab.liveMsgs,
        livePreview: '',
      }));
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
      patchTab(cwd, { question: { permId: ev.permId, questions: (ev.input && ev.input.questions) || [] }, status: '等待你的选择…' });
      return;
    }
    if (t === 'permission_request') {
      patchTab(cwd, {
        perm: {
          permId: ev.permId, toolName: ev.toolName, input: ev.input,
          title: ev.title, displayName: ev.displayName, description: ev.description, suggestions: ev.suggestions,
        },
        status: '等待你的授权…',
      });
      return;
    }
    // result = 一个回合结束（常驻会话仍存活，等下一条）。子 agent 的 result 不收尾主回合。
    if (t === 'result') {
      if (parentId) return;
      if (ev.session_id) pendingByCwd.current.set(cwd, ev.session_id);
      finalizeTurn(cwd, (ev.subtype && ev.subtype !== 'success') ? '⚠ 回合异常结束' : '');
      return;
    }
    if (t === 'error') { patchTab(cwd, { status: `⚠ ${ev.error || '执行出错'}` }); return; }
    // 进程真正退出（关标签/切会话/出错）：兜底收尾。
    if (t === 'session_closed') { finalizeTurn(cwd, ''); return; }
  }
  handleEventRef.current = handleEvent;

  /** 收尾一个回合：排空平滑、把 liveMsgs 合进历史、running=false、写回 sessionId、刷新左栏。 */
  function finalizeTurn(cwd: string, errStatus: string) {
    const sm = smoothRef.current.get(cwd);
    if (sm) { smoothRef.current.delete(cwd); if (sm.finalize) sm.finalize(); }
    const pending = pendingByCwd.current.get(cwd) || null;
    patchTab(cwd, (tab) => {
      if (!tab.running && tab.liveMsgs.length === 0 && !tab.livePreview) return {}; // 已收尾，避免重复
      const sid = pending || tab.sessionId;
      // 记住这个会话「最后一次发送时的权限级别」，重开历史会话时默认切回它。
      if (sid) { permMemRef.current[sid] = tab.permMode; savePermBySession(permMemRef.current); }
      return {
        messages: [...tab.messages, ...tab.liveMsgs],
        liveMsgs: [], livePreview: '', running: false, perm: null, question: null,
        sessionId: sid,
        status: errStatus || '',
      };
    });
    void loadSessionsFor(cwd);   // 新会话拿到真实 id / 已更新 → 刷新左栏
    expandProject(cwd);
  }

  /** 用户对权限请求作答 → 回传给 SDK 的 canUseTool，agent 继续。 */
  const respondPermission = useCallback((cwd: string, permId: string, decision: PermissionDecision) => {
    patchTab(cwd, { perm: null, status: decision.behavior === 'allow' ? 'Agent 处理中…' : '' });
    void localAgent.permissionRespond(permId, decision);
  }, [patchTab]);

  /** 用户答完 AskUserQuestion → 把选择作为答案经 deny-message 回传，agent 据此继续。 */
  const answerQuestion = useCallback((cwd: string, permId: string, answerText: string) => {
    patchTab(cwd, { question: null, status: 'Agent 处理中…' });
    void localAgent.permissionRespond(permId, { behavior: 'deny', message: answerText });
  }, [patchTab]);

  const send = useCallback(async (cwd: string) => {
    const tab = tabs.find((t) => t.cwd === cwd);
    if (!cwd || !tab) return;
    const text = tab.draft.trim();
    if (!text || tab.running) return;
    if (!current?.installed || !current?.live) { patchTab(cwd, { status: `⚠ ${current?.label || provider} 不可用` }); return; }
    const sid = tab.sessionId;   // 仅首条用于 resume；常驻会话已存在时后端忽略
    dropSmooth(cwd);
    patchTab(cwd, (t) => ({
      draft: '',
      messages: [...t.messages, { role: 'user', parts: [{ kind: 'text', text }], ts: null, uuid: null }],
      liveMsgs: [], livePreview: '', running: true, status: '处理中…', perm: null, question: null,
    }));
    const res = await localAgent.send({ provider, cwd, sessionId: sid, prompt: text, permMode: tab.permMode });
    if (!res.ok) patchTab(cwd, (t) => ({ running: false, status: t.status.startsWith('⚠') ? t.status : '⚠ 启动失败' }));
  }, [tabs, current, provider, patchTab, dropSmooth]);

  const interrupt = useCallback((cwd: string) => { if (cwd) void localAgent.interrupt(cwd); }, []);

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
        return [...gs, { id: gid, name: '未命名', color, collapsed: false }];
      });
    }
    setTabs((ts) => clusterTabs(ts.map((t) => (leaves.includes(t.cwd) ? { ...t, groupId: gid } : t))));
  }, [layout, tabs, groups]);

  /** 把某窗格移出网格；剩一个时塌缩回单窗。 */
  const removePane = useCallback((cwd: string) => {
    setLayout((cur) => {
      if (!cur) return cur;
      const next = removeLeaf(cur, cwd);
      if (next && next.kind === 'leaf') { const only = next.cwd; queueMicrotask(() => setActiveCwd(only)); return null; }
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

  return {
    providers, provider, current, detecting,
    cyclePermMode, commands,
    projects, expanded, toggleProject, sessionsByPath,
    addProject, removeProject,
    // 标签 + 多窗格（分屏树）
    tabs, activeCwd, setActiveTab, closeTab, activeProject,
    layout, gridCwds, placePane, removePane, setSplitRatio,
    // 标签分组（类 Chrome）
    groups, createGroupFromTab, addTabToGroup, removeTabFromGroup, toggleGroup, setGroupColor, renameGroup, ungroupGroup, moveGroupBefore, moveTabBefore,
    // 激活标签派生（供对话组件直接读）
    activeSessionId: activeTab?.sessionId ?? null,
    sessionTitle: activeTab?.title ?? '',
    messages: activeTab?.messages ?? EMPTY_MSGS,
    liveMsgs: activeTab?.liveMsgs ?? EMPTY_MSGS,
    livePreview: activeTab?.livePreview ?? '',
    status: activeTab?.status ?? '',
    running: activeTab?.running ?? false,
    loadingSession: activeTab?.loading ?? false,
    draft: activeTab?.draft ?? '',
    perm: activeTab?.perm ?? null,
    question: activeTab?.question ?? null,
    setDraft,
    openSession, newSession, deleteSession, send, interrupt, respondPermission, answerQuestion,
  };
}

export type LocalAgentState = ReturnType<typeof useLocalAgent>;

const EMPTY_MSGS: TranscriptMessage[] = [];

import type { MsgPart } from './services/localAgent';
function normalizeParts(message: any): MsgPart[] {
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
