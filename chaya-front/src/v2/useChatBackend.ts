import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAgents, getSessions, getSessionMessages,
  deleteSession as svcDeleteSession,
  deleteAgent as svcDeleteAgent,
  updateSessionName as svcUpdateSessionName,
  truncateMessagesFrom as svcTruncateMessagesFrom,
  type Message, type Session,
} from '../services/chat';
import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';
import { listTeahouses, createTeahouse, updateTeahouse, isTeahouseSession } from './services/teahouse';
import {
  TYPEWRITER_PRESETS, DEFAULT_TYPEWRITER, FINISH_DRAIN_SEC,
  type TypewriterConfig,
} from './typewriter';

export type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** A message the user picked to quote — its content rides along as context on
 *  the next send (ext.quote), and the composer shows a removable quote bar. */
export interface QuotedRef {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
}

/** Sentinel sid used while a teahouse picker has chosen a model but the
 *  conversation row hasn't been POSTed yet. Materialised on first send. */
export const DRAFT_TEAHOUSE_SID = 'draft:teahouse';

interface State {
  loadingMeta: boolean;
  agents: Session[];
  recents: Session[];
  teahouses: Session[];
  activeSessionId: string | null;
  loadingMessages: boolean;
  messages: Message[];
  /** Live, not-yet-persisted assistant stream for the active session.
   *  `reasoning` collects chain-of-thought tokens (DeepSeek-Reasoner / o1 /
   *  Qwen-Thinking emit these before the answer); empty for chat-only models. */
  stream: { id: string; content: string; reasoning: string } | null;
  thinking: boolean;
  sending: boolean;
  wsState: WsState;
  /** Message queued to be quoted on the next send; null when none. */
  quoted: QuotedRef | null;
}

/**
 * Minimal chat backend wiring for the v2 shell.
 *
 * One WebSocket per app instance; subscribes to whichever session is active.
 * On message: backend echoes back `agent_thinking` / `agent_stream_chunk` /
 * `agent_stream_done` / `new_message`. We render the stream live and trust
 * `agent_stream_done` (which carries the saved message) to merge into the
 * persisted list.
 */
/** Per-stream typewriter progress for the active assistant reply. token chunks
 *  land in `raw`; the rAF pump advances `disp` toward raw.length and writes the
 *  shown slice into state.stream.content. Mirrors the CLI engine in useLocalAgent. */
interface ChatSmooth {
  id: string;
  raw: string;
  disp: number;   // float display progress (sub-character, for steady speed)
  shown: number;  // integer chars already written to stream.content
  rate: number;   // current chars/sec (held steady between re-evals)
  evalAt: number; // performance.now() of last rate re-eval
  finalize: (() => void) | null; // run once drained (merge the persisted message)
}

export function useChatBackend(typewriter: TypewriterConfig = DEFAULT_TYPEWRITER) {
  const [s, setS] = useState<State>({
    loadingMeta: true,
    agents: [],
    recents: [],
    teahouses: [],
    activeSessionId: null,
    loadingMessages: false,
    messages: [],
    stream: null,
    thinking: false,
    sending: false,
    wsState: 'idle',
    quoted: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const activeSidRef = useRef<string | null>(null);
  /** 始终镜像最新 messages，供事件回调同步读取（setS 的 updater 是延迟执行的，
   *  不能在调用处立刻读到 updater 内赋的值——回退/编辑就栽在这个坑上）。 */
  const messagesRef = useRef<Message[]>([]);
  /** sid → true iff it's a teahouse conversation. Used by sendMessage to route
   *  the WS envelope type without depending on render-time state. */
  const teahouseSidsRef = useRef<Set<string>>(new Set());
  /** Pending teahouse draft — picker chose a model but the conv hasn't been
   *  POSTed yet. We materialise the row on the first send so empty drafts
   *  never pollute the sidebar. */
  const draftTeahouseRef = useRef<{ llm_config_id: string; model?: string; title?: string } | null>(null);
  /** Stable handle to refreshMeta so the WS event handler (declared inside a
   *  one-shot useEffect) can call the latest closure without re-binding. */
  const refreshMetaRef = useRef<((selectIfEmpty?: boolean) => Promise<void>) | null>(null);

  /* -------- typewriter smoothing for the assistant stream -------- */
  // Live config (toggle + speed) read by the rAF pump without re-binding it.
  const twRef = useRef<TypewriterConfig>(typewriter);
  twRef.current = typewriter;
  const smoothRef = useRef<ChatSmooth | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);

  /** Merge a finished assistant stream into the persisted message list and
   *  clear the live stream. Shared by the immediate and post-drain paths. */
  const mergeAssistantDone = useCallback((id: string, content: string, reasoning: string) => {
    setS((prev) => {
      const carriedReason = reasoning || prev.stream?.reasoning || '';
      const msg: Message = {
        message_id: id,
        session_id: activeSidRef.current || '',
        role: 'assistant',
        content,
        created_at: new Date().toISOString(),
        ext: carriedReason ? { reasoning: carriedReason } : undefined,
      };
      const dedup = prev.messages.filter((m) => m.message_id !== id);
      return { ...prev, stream: null, thinking: false, sending: false, messages: [...dedup, msg] };
    });
  }, []);

  // 保持 messagesRef 与 state 同步。
  useEffect(() => { messagesRef.current = s.messages; }, [s.messages]);

  const resetChatSmooth = useCallback(() => {
    smoothRef.current = null;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    lastFrameRef.current = 0;
  }, []);

  // rAF drain: advance disp toward raw.length at a held-steady rate; write the
  // shown slice into stream.content. When disabled mid-stream, snap to full.
  const pump = useCallback(() => {
    const sm = smoothRef.current;
    if (!sm) { rafRef.current = null; lastFrameRef.current = 0; return; }
    const tw = twRef.current;
    const P = TYPEWRITER_PRESETS[tw.speed] || TYPEWRITER_PRESETS.normal;
    const now = performance.now();
    if (lastFrameRef.current === 0) lastFrameRef.current = now;
    const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000);
    lastFrameRef.current = now;

    if (!tw.enabled) sm.disp = sm.raw.length; // switched off → reveal everything now
    const target = sm.raw.length;
    const finalizing = sm.finalize != null;
    const backlog = target - sm.disp;
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
      const shownText = sm.raw.slice(0, nextShown);
      const id = sm.id;
      setS((p) => (p.stream && p.stream.id === id ? { ...p, stream: { ...p.stream, content: shownText } } : p));
    }
    if (sm.disp >= target && sm.finalize) {
      const fn = sm.finalize;
      smoothRef.current = null; rafRef.current = null; lastFrameRef.current = 0;
      fn(); // text already fully shown → merge the persisted message, no jump
      return;
    }
    rafRef.current = requestAnimationFrame(pump);
  }, []);

  const ensureChatPump = useCallback(() => {
    if (rafRef.current == null) { lastFrameRef.current = 0; rafRef.current = requestAnimationFrame(pump); }
  }, [pump]);

  // Stop the rAF when the hook unmounts.
  useEffect(() => () => resetChatSmooth(), [resetChatSmooth]);

  /* -------- meta (agents + recents) -------- */
  const refreshMeta = useCallback(async (selectIfEmpty = true) => {
    setS((p) => ({ ...p, loadingMeta: true }));
    try {
      const [agents, sessions, teahouses] = await Promise.all([
        getAgents(),
        getSessions(),
        listTeahouses().catch(() => [] as Session[]),
      ]);
      const agentList = agents || [];
      const recents = (sessions || []).filter((x) => x.session_type === 'topic_general');
      setS((p) => {
        const fallback = selectIfEmpty && !p.activeSessionId
          ? (agentList.find((a) => a.is_primary)?.session_id || agentList[0]?.session_id || null)
          : p.activeSessionId;
        return { ...p, loadingMeta: false, agents: agentList, recents, teahouses, activeSessionId: fallback };
      });
      teahouseSidsRef.current = new Set((teahouses || []).map((t) => t.session_id));
    } catch (e) {
      console.warn('[v2] refreshMeta failed', e);
      setS((p) => ({ ...p, loadingMeta: false }));
    }
  }, []);

  useEffect(() => { refreshMetaRef.current = refreshMeta; }, [refreshMeta]);
  useEffect(() => { void refreshMeta(true); }, [refreshMeta]);

  /* -------- WebSocket lifecycle (single connection, swap subscriptions) -------- */
  useEffect(() => {
    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      const token = localStorage.getItem('chaya_token') || '';
      if (!token) { setS((p) => ({ ...p, wsState: 'error' })); return; }
      const wsBase = getBackendUrl().replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/ws`, ['bearer', token]);
      wsRef.current = ws;
      setS((p) => ({ ...p, wsState: 'connecting' }));

      ws.addEventListener('open', () => {
        if (!mounted) return;
        reconnectAttempt.current = 0;
        setS((p) => ({ ...p, wsState: 'open' }));
        const sid = activeSidRef.current;
        if (sid) { try { ws.send(JSON.stringify({ type: 'subscribe', topic: sid })); } catch {} }
      });

      ws.addEventListener('message', (ev) => {
        try {
          const env = JSON.parse(ev.data);
          if (env?.type !== 'event' || !env?.payload) return;
          handleEvent(env.payload, env.topic);
        } catch { /* ignore */ }
      });

      ws.addEventListener('close', () => {
        if (!mounted) return;
        setS((p) => ({ ...p, wsState: 'closed' }));
        const attempt = Math.min(++reconnectAttempt.current, 6);
        const delay = Math.min(1000 * Math.pow(1.6, attempt), 10_000);
        reconnectTimer.current = window.setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => { if (mounted) setS((p) => ({ ...p, wsState: 'error' })); });
    };

    const handleEvent = (p: any, topic?: string) => {
      const type = p?.type;
      // Drop events for sessions other than the one we're viewing.
      if (topic && topic !== activeSidRef.current) return;

      if (type === 'agent_thinking' || type === 'agent_deciding') {
        setS((prev) => ({ ...prev, thinking: true }));
        return;
      }
      if (type === 'agent_reasoning_chunk') {
        const id = p.message_id || p.agent_id || 'stream';
        const chunkDelta = typeof p.chunk === 'string' ? p.chunk : '';
        const fullReason = typeof p.content === 'string' ? p.content : '';
        setS((prev) => {
          const base = (prev.stream && prev.stream.id === id)
            ? prev.stream
            : { id, content: '', reasoning: '' };
          const next = chunkDelta
            ? { ...base, reasoning: base.reasoning + chunkDelta }
            : fullReason
              ? { ...base, reasoning: fullReason }
              : base;
          return { ...prev, thinking: false, stream: next };
        });
        return;
      }
      if (type === 'agent_stream_chunk' || type === 'stream_chunk') {
        const id = p.message_id || p.agent_id || 'stream';
        const chunkDelta = typeof p.chunk === 'string' ? p.chunk : '';
        const fullContent = typeof p.content === 'string' ? p.content : '';

        // Smoothing OFF → legacy: append the delta straight into the visible stream.
        if (!twRef.current.enabled) {
          setS((prev) => {
            const base = (prev.stream && prev.stream.id === id)
              ? prev.stream
              : { id, content: '', reasoning: '' };
            const nextContent = chunkDelta
              ? base.content + chunkDelta
              : (fullContent || base.content);
            return { ...prev, thinking: false, stream: { ...base, content: nextContent } };
          });
          return;
        }

        // Smoothing ON → token chunks accumulate in `raw`; the rAF pump reveals
        // them at a steady rate. We only ensure the live stream object exists here.
        let sm = smoothRef.current;
        if (!sm || sm.id !== id) {
          sm = { id, raw: '', disp: 0, shown: 0, rate: 0, evalAt: 0, finalize: null };
          smoothRef.current = sm;
        }
        if (chunkDelta) sm.raw += chunkDelta;
        else if (fullContent.length > sm.raw.length) sm.raw = fullContent;
        setS((prev) => {
          if (prev.stream && prev.stream.id === id) return { ...prev, thinking: false };
          return { ...prev, thinking: false, stream: { id, content: '', reasoning: prev.stream?.reasoning || '' } };
        });
        ensureChatPump();
        return;
      }
      if (type === 'agent_stream_done') {
        // Backend has persisted the assistant message; merge into messages and clear stream.
        const id = p.message_id || p.agent_id || 'stream';
        const content = typeof p.content === 'string' ? p.content : '';
        const reasoning = typeof p.reasoning === 'string' ? p.reasoning : '';

        // Smoothing ON and the visible text hasn't caught up → let the pump finish
        // draining, then merge (text stays identical, no jump). Otherwise merge now.
        // 回合结束后静默对齐 DB 真值：把乐观的 local- id 换成真实 UUID，
        // 这样「回退 / 回退并编辑」总能拿到有效锚点删库（后端不发 new_message 也不怕）。
        const reconcileIds = () => { const sid = activeSidRef.current; if (sid) void loadMessages(sid, /*silent*/ true); };
        const sm = smoothRef.current;
        const fullLen = content.length || (sm ? sm.raw.length : 0);
        if (twRef.current.enabled && sm && sm.id === id && sm.disp < fullLen) {
          if (content.length > sm.raw.length) sm.raw = content;
          sm.finalize = () => { mergeAssistantDone(id, content || sm.raw, reasoning); reconcileIds(); };
          ensureChatPump();
          return;
        }
        smoothRef.current = null;
        mergeAssistantDone(id, content, reasoning);
        reconcileIds();
        return;
      }
      if (type === 'new_message') {
        // Reload tail to capture media / ext for the freshest message.
        if (activeSidRef.current) void loadMessages(activeSidRef.current, /*silent*/ true);
        return;
      }
      if (type === 'conversation_renamed') {
        // Auto-title (e.g. teahouse first turn) — pull fresh sidebar metadata
        // so the new label shows up without a manual reload.
        void refreshMetaRef.current?.(false);
        return;
      }
    };

    connect();
    return () => {
      mounted = false;
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------- active session: load history + (re)subscribe -------- */
  const loadMessages = useCallback(async (sid: string, silent = false) => {
    if (!silent) setS((p) => ({ ...p, loadingMessages: true, messages: [] }));
    try {
      const res = await getSessionMessages(sid, 1, 50);
      setS((p) => (activeSidRef.current === sid
        ? { ...p, loadingMessages: false, messages: res.messages || [] }
        : p));
    } catch (e) {
      console.warn('[v2] loadMessages failed', e);
      setS((p) => ({ ...p, loadingMessages: false }));
    }
  }, []);

  const setActiveSessionId = useCallback((sid: string | null) => {
    const prev = activeSidRef.current;
    activeSidRef.current = sid;
    resetChatSmooth(); // drop any in-flight typewriter from the previous session
    setS((p) => ({ ...p, activeSessionId: sid, messages: [], stream: null, thinking: false }));
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        if (prev && prev !== sid) ws.send(JSON.stringify({ type: 'unsubscribe', topic: prev }));
        if (sid) ws.send(JSON.stringify({ type: 'subscribe', topic: sid }));
      } catch {}
    }
    if (sid) void loadMessages(sid);
  }, [loadMessages, resetChatSmooth]);

  // Keep ref synchronized whenever state's activeSessionId moves (e.g. first refreshMeta).
  useEffect(() => {
    if (s.activeSessionId && activeSidRef.current !== s.activeSessionId) {
      const sid = s.activeSessionId;
      activeSidRef.current = sid;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'subscribe', topic: sid })); } catch {}
      }
      void loadMessages(sid);
    }
  }, [s.activeSessionId, loadMessages]);

  /* -------- send -------- */
  const sendMessage = useCallback(async (text: string, opts?: { agentId?: string; ext?: Record<string, unknown> }) => {
    if (!text.trim()) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    // Lazily materialise a teahouse draft: the picker only stashed the config;
    // we POST and create the conv right before the first send so empty drafts
    // (user opens picker then bails) never leak rows into the sidebar.
    let sid = activeSidRef.current;
    if (sid === DRAFT_TEAHOUSE_SID) {
      const draft = draftTeahouseRef.current;
      if (!draft) return false;
      try {
        const created = await createTeahouse({
          llm_config_id: draft.llm_config_id,
          model: draft.model,
          title: draft.title,
        });
        sid = created.session_id;
        if (!sid) return false;
        teahouseSidsRef.current.add(sid);
        activeSidRef.current = sid;
        draftTeahouseRef.current = null;
        setS((p) => ({ ...p, activeSessionId: sid! }));
        try { ws.send(JSON.stringify({ type: 'subscribe', topic: sid })); } catch {}
        void refreshMeta(false);
      } catch (e) {
        console.warn('[v2] materialise draft teahouse failed', e);
        return false;
      }
    }
    if (!sid) return false;

    const localId = `local-${Date.now()}`;
    const userMsg: Message = {
      message_id: localId,
      session_id: sid,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
      // Carry the send-time ext (quote / knowledge_domains / media) so chips
      // render immediately; the post-turn reload later swaps in the DB row.
      ext: opts?.ext as Message['ext'],
    };
    setS((p) => ({ ...p, messages: [...p.messages, userMsg], sending: true, thinking: true }));

    const ext: Record<string, unknown> = { ...(opts?.ext || {}) };
    if (opts?.agentId) ext.agent_id = opts.agentId;
    const wsType = teahouseSidsRef.current.has(sid) ? 'teahouse_message' : 'message';
    try {
      ws.send(JSON.stringify({
        type: wsType,
        payload: { conv_id: sid, content: text, ext },
      }));
      return true;
    } catch (e) {
      console.warn('[v2] sendMessage failed', e);
      setS((p) => ({ ...p, sending: false, thinking: false }));
      return false;
    }
  }, [refreshMeta]);

  /** Start a new chat in draft mode: stash the picker's chosen llm_config and
   *  open an empty chat surface. Nothing is persisted until the first send. */
  const startTeahouseDraft = useCallback((params: {
    llm_config_id: string;
    model?: string;
    title?: string;
  }) => {
    draftTeahouseRef.current = {
      llm_config_id: params.llm_config_id,
      model: params.model,
      title: params.title,
    };
    // Unsubscribe from whatever was previously active.
    const prev = activeSidRef.current;
    const ws = wsRef.current;
    if (prev && prev !== DRAFT_TEAHOUSE_SID && ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'unsubscribe', topic: prev })); } catch {}
    }
    activeSidRef.current = DRAFT_TEAHOUSE_SID;
    setS((p) => ({ ...p, activeSessionId: DRAFT_TEAHOUSE_SID, messages: [], stream: null, thinking: false, sending: false }));
  }, []);

  /** Create a new topic conversation, set it active, optionally send first message. */
  const createTopicAndOpen = useCallback(async (firstText?: string, agentId?: string, extraExt?: Record<string, unknown>): Promise<string | null> => {
    try {
      const created = await api.post<Session>('/api/conversations', {
        title: firstText ? firstText.slice(0, 40) : '新会话',
        session_type: 'topic_general',
      });
      const sid: string | undefined = (created as any).session_id || (created as any).id;
      if (!sid) return null;
      // refresh recents list so the new topic shows
      void refreshMeta(false);
      activeSidRef.current = sid;
      setS((p) => ({ ...p, activeSessionId: sid, messages: [], stream: null, thinking: false }));
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'subscribe', topic: sid })); } catch {}
      }
      if (firstText && firstText.trim()) {
        // Give the WS subscribe a tick to land before pushing the message.
        setTimeout(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          const localId = `local-${Date.now()}`;
          const userMsg: Message = {
            message_id: localId, session_id: sid, role: 'user',
            content: firstText, created_at: new Date().toISOString(),
          };
          setS((p) => ({ ...p, messages: [userMsg], sending: true, thinking: true }));
          const ext: Record<string, unknown> = { ...(extraExt || {}) };
          if (agentId) ext.agent_id = agentId;
          try {
            ws.send(JSON.stringify({ type: 'message', payload: { conv_id: sid, content: firstText, ext } }));
          } catch (e) {
            console.warn('[v2] new-topic first send failed', e);
            setS((p) => ({ ...p, sending: false, thinking: false }));
          }
        }, 60);
      }
      return sid;
    } catch (e) {
      console.warn('[v2] createTopic failed', e);
      return null;
    }
  }, [refreshMeta]);

  const renameSession = useCallback(async (sid: string, name: string) => {
    try {
      // Teahouse rows live under /api/teahouse/conversations — the generic
      // /api/sessions/{id}/name endpoint doesn't reach them.
      if (teahouseSidsRef.current.has(sid)) {
        await updateTeahouse(sid, { title: name });
      } else {
        await svcUpdateSessionName(sid, name);
      }
      void refreshMeta(false);
    } catch (e) { console.warn('[v2] rename failed', e); throw e; }
  }, [refreshMeta]);

  /** Update the llm_config (and optional model) for a teahouse session.
   *  No-op for non-teahouse sessions. */
  const setTeahouseModel = useCallback(async (sid: string, llm_config_id: string, model?: string) => {
    if (!teahouseSidsRef.current.has(sid)) return false;
    try {
      await updateTeahouse(sid, { llm_config_id, model });
      await refreshMeta(false);
      return true;
    } catch (e) { console.warn('[v2] setTeahouseModel failed', e); return false; }
  }, [refreshMeta]);

  const removeSession = useCallback(async (s: Session) => {
    try {
      const isAgentEntity = !!(s.id && s.session_id && s.id !== s.session_id);
      if (isAgentEntity && !s.is_primary) {
        await svcDeleteAgent(s.id!);
      } else {
        await svcDeleteSession(s.session_id);
      }
      if (activeSidRef.current === s.session_id) {
        activeSidRef.current = null;
        setS((p) => ({ ...p, activeSessionId: null, messages: [], stream: null }));
      }
      void refreshMeta(true);
    } catch (e) { console.warn('[v2] delete failed', e); throw e; }
  }, [refreshMeta]);

  const interrupt = useCallback(() => {
    const sid = activeSidRef.current;
    const ws = wsRef.current;
    if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return;
    const type = teahouseSidsRef.current.has(sid) ? 'teahouse_interrupt' : 'interrupt';
    try { ws.send(JSON.stringify({ type, topic: sid })); } catch {}
    resetChatSmooth(); // stop revealing buffered text once the user interrupts
  }, [resetChatSmooth]);

  /* -------- quote / revert (回退 · 回退并编辑 · 引用) -------- */

  /** Queue a message to be quoted on the next send. AI and user messages both
   *  quotable; only the content rides along. */
  const quoteMessage = useCallback((m: Message) => {
    setS((p) => ({
      ...p,
      quoted: {
        messageId: m.message_id,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: (m.content || '').trim(),
      },
    }));
  }, []);

  const clearQuote = useCallback(() => setS((p) => ({ ...p, quoted: null })), []);

  /** Rewind the active conversation to (and excluding) a message: drops that
   *  message and everything after it, locally and — for persisted rows — in the
   *  DB. Backing for 回退 / 回退并编辑. Returns false if it couldn't be applied. */
  const revertToMessage = useCallback(async (messageId: string): Promise<boolean> => {
    const sid = activeSidRef.current;
    if (!sid) return false;

    // 关键：从 messagesRef 同步取当前消息算下标。绝不能依赖 setS updater 里赋的值——
    // updater 是延迟执行的，调用处立刻读必为初值（这正是回退一直没真删的根因）。
    const anchorIdx = messagesRef.current.findIndex((m) => m.message_id === messageId);
    if (anchorIdx < 0) return false;

    // 乐观本地切片：删掉锚点及其之后。
    setS((p) => ({
      ...p,
      messages: p.messages.slice(0, anchorIdx),
      stream: null,
      thinking: false,
      sending: false,
      // 指向被删消息的引用会悬空 → 清掉。
      quoted: p.quoted?.messageId === messageId ? null : p.quoted,
    }));

    // 解析锚点的持久化 UUID。乐观发送的消息带 `local-…` id（后端不发 new_message），
    // 这类锚点按位置映射到 DB 真值（已加载消息全部 asc 同序）。
    const isUuid = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(x);
    let anchorId = messageId;
    if (!isUuid(anchorId)) {
      try {
        const res = await getSessionMessages(sid, 1, 50);
        const db = res.messages || [];
        if (anchorIdx < db.length && isUuid(db[anchorIdx].message_id)) anchorId = db[anchorIdx].message_id;
      } catch { /* 落到下方守卫 */ }
    }
    if (!isUuid(anchorId)) {
      void loadMessages(sid, /*silent*/ true);   // 映射不到持久行 → 与 DB 重新对齐
      return true;
    }
    try {
      await svcTruncateMessagesFrom(sid, anchorId);
      return true;
    } catch (e) {
      console.warn('[v2] revertToMessage failed', e);
      void loadMessages(sid, /*silent*/ true);
      return false;
    }
  }, [loadMessages]);

  return {
    ...s,
    setActiveSessionId,
    refreshMeta,
    sendMessage,
    createTopicAndOpen,
    startTeahouseDraft,
    setTeahouseModel,
    /** Force-reload messages for the currently-active session — used by
     *  REST mutations (e.g. saving a creation turn) that don't trigger the
     *  WebSocket new_message broadcast. */
    reloadActiveMessages: (): Promise<void> => {
      const sid = activeSidRef.current;
      return sid ? loadMessages(sid, /*silent*/ true) : Promise.resolve();
    },
    renameSession,
    removeSession,
    interrupt,
    quoteMessage,
    clearQuote,
    revertToMessage,
    isTeahouseSession,
  };
}
