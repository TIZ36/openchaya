/**
 * 全局 topbar tab 条状态 —— 与现有 activeNav / activeSessionId / la.activeCwd
 * 共存的薄层：负责「打开了哪些会话」+ 每条 tab 的 unread / attn 信号。
 *
 * 真正的「当前激活」仍由 ClientShell 的现有状态机决定（activeNav + activeSessionId
 * + la.activeCwd），TopTab.activeId 仅做派生/同步——避免大刀阔斧的状态迁移。
 *
 * 持久化：lean 字段写入 localStorage.chaya.topTabs；运行时字段（unread/attn）不存。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type TopTabKind = 'local' | 'chat' | 'gallery' | 'kb';

export interface TopTab {
  /** 全局唯一 id；约定：`local:${cwd}` / `chat:${sessionId}` / 'gallery' / 'kb'。 */
  id: string;
  kind: TopTabKind;
  label: string;
  /** chat 类 tab 的会话标识。 */
  sessionId?: string;
  /** 区分主 agent / 普通对话 / 茶馆 —— 仅用于图标。 */
  sessionType?: 'agent' | 'topic_general' | 'memory' | 'research' | 'temporary' | string;
  isPrimary?: boolean;
  /** local 类 tab 的工作目录。 */
  cwd?: string;
  provider?: 'claude' | 'cursor' | string;
  /** 后台有新消息且当前不是该 tab —— 显示未读小点。 */
  unread?: boolean;
  /** 该会话有待批准/选择请求 —— 用 accent 边强调，提示「需要你」。 */
  attn?: boolean;
  /** 固定：缩略显示在最左侧、不可关闭、跨会话常驻。 */
  pinned?: boolean;
}

interface PersistedShape {
  tabs: Omit<TopTab, 'unread' | 'attn'>[];
  activeId: string | null;
}

const LS_KEY = 'chaya.topTabs';

export const localTabId = (cwd: string) => `local:${cwd}`;
export const chatTabId = (sessionId: string) => `chat:${sessionId}`;
export const GALLERY_TAB_ID = 'gallery';
export const KB_TAB_ID = 'kb';

function loadPersisted(): PersistedShape {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p?.tabs)) {
        const tabs = (p.tabs as TopTab[]).filter((t) => !!t && typeof t.id === 'string');
        const activeId = (p.activeId && tabs.find((t) => t.id === p.activeId)) ? p.activeId : null;
        return { tabs, activeId };
      }
    }
  } catch { /* ignore */ }
  return { tabs: [], activeId: null };
}

function persist(tabs: TopTab[], activeId: string | null) {
  try {
    const lean = tabs.map(({ id, kind, label, sessionId, sessionType, isPrimary, cwd, provider, pinned }) =>
      ({ id, kind, label, sessionId, sessionType, isPrimary, cwd, provider, pinned }));
    localStorage.setItem(LS_KEY, JSON.stringify({ tabs: lean, activeId }));
  } catch { /* ignore */ }
}

export interface TopTabsApi {
  tabs: TopTab[];
  activeId: string | null;
  /** 添加或更新一条 tab（id 已存在则只更新 label 等元信息并清未读）。不切换激活。 */
  add: (spec: Omit<TopTab, 'unread' | 'attn'>) => void;
  /** 删除 tab；如果删的是 activeId 则把 activeId 给最近一条。返回下一条 activeId。 */
  remove: (id: string) => string | null;
  /** 仅刷新 activeId（用于外部状态变化后同步进来）。 */
  setActiveId: (id: string | null) => void;
  /** 清除某 tab 的 unread/attn 标记。 */
  clearUnread: (id: string) => void;
  markUnread: (id: string) => void;
  setAttn: (id: string, attn: boolean) => void;
  /** 切换固定（缩略钉在最左）。 */
  togglePin: (id: string) => void;
  /** MRU：把该 tab 移到最左（点击即用即提前）。固定项另有左轨，不受影响。 */
  promote: (id: string) => void;
}

export function useTopTabs(): TopTabsApi {
  const boot = useRef<PersistedShape | null>(null);
  if (boot.current === null) boot.current = loadPersisted();
  const [tabs, setTabs] = useState<TopTab[]>(() => boot.current!.tabs.map((t) => ({ ...t })));
  const [activeId, setActiveId] = useState<string | null>(() => boot.current!.activeId);

  // Persist on any change. Cheap (a few dozen items max) and lets the user
  // resume their open tabs across reloads.
  useEffect(() => { persist(tabs, activeId); }, [tabs, activeId]);

  const add = useCallback((spec: Omit<TopTab, 'unread' | 'attn'>) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === spec.id);
      if (existing) {
        // Short-circuit: nothing changed = no new array reference = no re-render.
        // Critical for perf — this gets called inside an effect that fires on
        // every stream chunk (la.tabs identity changes when liveMsgs grows).
        // Compare every persisted field; do NOT clobber `unread` here (use
        // `clearUnread` for that, gated on activation, not on metadata refresh).
        if (
          existing.kind === spec.kind &&
          existing.label === spec.label &&
          existing.sessionId === spec.sessionId &&
          existing.sessionType === spec.sessionType &&
          existing.isPrimary === spec.isPrimary &&
          existing.cwd === spec.cwd &&
          existing.provider === spec.provider
        ) return prev;
        return prev.map((t) => t.id === spec.id ? { ...t, ...spec } : t);
      }
      return [...prev, { ...spec, unread: false, attn: false }];
    });
  }, []);

  const remove = useCallback((id: string): string | null => {
    let nextActive: string | null = null;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      // If removing the active tab, hand off to the nearest neighbour (prefer the one to the left).
      setActiveId((cur) => {
        if (cur !== id) { nextActive = cur; return cur; }
        if (next.length === 0) { nextActive = null; return null; }
        const pick = next[Math.max(0, idx - 1)] ?? next[0];
        nextActive = pick.id;
        return pick.id;
      });
      return next;
    });
    return nextActive;
  }, []);

  const clearUnread = useCallback((id: string) => {
    setTabs((prev) => prev.some((t) => t.id === id && t.unread)
      ? prev.map((t) => t.id === id ? { ...t, unread: false } : t)
      : prev);
  }, []);

  const markUnread = useCallback((id: string) => {
    setTabs((prev) => prev.some((t) => t.id === id && !t.unread)
      ? prev.map((t) => t.id === id ? { ...t, unread: true } : t)
      : prev);
  }, []);

  const setAttn = useCallback((id: string, attn: boolean) => {
    setTabs((prev) => prev.some((t) => t.id === id && !!t.attn !== attn)
      ? prev.map((t) => t.id === id ? { ...t, attn } : t)
      : prev);
  }, []);

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, pinned: !t.pinned } : t));
  }, []);

  // MRU：被点的 tab 跳到最左，其余保持相对次序——高频用的自然聚到左侧。顺序会持久化。
  const promote = useCallback((id: string) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      if (i <= 0) return prev;
      return [prev[i], ...prev.slice(0, i), ...prev.slice(i + 1)];
    });
  }, []);

  return { tabs, activeId, add, remove, setActiveId, clearUnread, markUnread, setAttn, togglePin, promote };
}
