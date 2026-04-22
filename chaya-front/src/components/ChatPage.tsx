import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getAgents, getSession, getSessionMessages, deleteMessage,
  type Session, type Message,
} from '../services/chat';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { smartnoteRetrieve, smartnoteMemories, getSmartnoteApiKey, type MemoryKind } from '../services/smartnoteApi';
import { getBackendUrl } from '../utils/backendUrl';
import { toast } from './ui/use-toast';
import { isBlurred, BLURRED_IMG_CSS } from '../utils/blurred';

/* ============================================================
   对话 / Chat — aligned with mockups/a-paper-and-press.html
   Minimal, correct WS protocol (see CLAUDE.md):
     C→S: subscribe / message / interrupt / ping
     S→C: event { topic, payload: { type, ... } }
   Handled event types: agent_thinking / agent_stream_chunk /
     agent_stream_done / new_message / agent_deciding / execution_log
   ============================================================ */

interface ChatPageProps {
  sessionId: string | null;
  /** Agent UUID — used to scope Smartnote memory retrieval to this agent. */
  agentId?: string | null;
  enableToolCalling: boolean;
  cmdEnterToSend?: boolean;
  /** Before send: retrieve top-K memories from Smartnote and prepend as context. */
  ragEnabled?: boolean;
  ragTopK?: number;
  /** RAG scope mode:
   *   - 'auto' (default): issue BOTH an agent-scoped and a workspace-wide
   *     retrieve in parallel, merge by id, and let Smartnote's score decide.
   *     "AI decides" in practice — retrieval ranking IS the decision.
   *   - 'agent': hard scope to agent:<id> only (isolated bot).
   *   - 'workspace': no scope — org shared brain. */
  ragScope?: 'auto' | 'agent' | 'workspace';
}

type StreamingDraft = { id: string; content: string; startedAt: number };

/** A backend progress event (execution_log) as shown in the chat stream.
 *  log_type is the backend-provided category (step / tool_call / error / …);
 *  we render them identically but surface the type in tooltip. */
interface ProgressEntry {
  id: string;
  message: string;
  detail?: string;
  logType: string;
  timestamp: number;
}

interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  /** data URL including the `data:...;base64,` prefix */
  dataUrl: string;
  /** raw base64 without prefix — what we send to backend */
  data: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'file';
  /** Set when the attachment was picked from the gallery — lets us honor the
   *  per-output blur flag users set in Create. */
  outputId?: string;
}

const MAX_ATTACH_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_ATTACH_COUNT = 6;

const detectKind = (mime: string): Attachment['kind'] => {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const ChatPage: React.FC<ChatPageProps> = ({
  sessionId, agentId, enableToolCalling, cmdEnterToSend,
  ragEnabled, ragTopK = 5, ragScope = 'auto',
}) => {
  const [agent, setAgent] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [stream, setStream] = useState<StreamingDraft | null>(null);
  /** Live progress events for the current (in-flight) turn. Cleared on
   *  session switch and when a new user send starts. Each completed assistant
   *  message also snapshots its own slice keyed by message_id so the row
   *  can render its history inline after the answer arrives. */
  const [liveProgress, setLiveProgress] = useState<ProgressEntry[]>([]);
  const [progressByMsg, setProgressByMsg] = useState<Record<string, ProgressEntry[]>>({});
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [loadingHistory, setLoadingHistory] = useState(true);

  const [llmConfigs, setLlmConfigs] = useState<LLMConfigFromDB[]>([]);

  /** RAG status for last turn — shown briefly in topbar so user can see it happen. */
  const [lastRag, setLastRag] = useState<{
    at: number;
    state: 'querying' | 'done' | 'empty' | 'skipped' | 'error';
    hits: number;
    error?: string;
  } | null>(null);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [gallery, setGallery] = useState<MediaOutputItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryLoaded, setGalleryLoaded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Bump to force a jump-to-bottom regardless of current scroll position.
   *  Used on session switch, after history loads, and when the user sends. */
  const [forceScroll, setForceScroll] = useState(0);
  /** Follow-up suggestion chips rendered below the latest assistant message.
   *  Keyed by message_id so we can keep them bound to their turn when the
   *  user sends another message on top. Best-effort — empty list is fine. */
  const [followups, setFollowups] = useState<Record<string, string[]>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);

  /* ---------- load LLM configs once (for model label lookup) ---------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await getLLMConfigs();
        if (!cancelled) setLlmConfigs(list);
      } catch {/* best-effort */}
    })();
    return () => { cancelled = true; };
  }, []);

  /* ---------- load agent + history ---------- */

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoadingHistory(true);
    setMessages([]);
    setStream(null);
    setThinking(false);
    setLiveProgress([]);
    setProgressByMsg({});
    setFollowups({});

    void (async () => {
      try {
        // Prefer /api/agents lookup — it returns agent record with the real
        // agent UUID + system_prompt + llm_config_id. Fall back to conversation
        // endpoint only for non-agent sessions (rare).
        const [agentsList, list] = await Promise.all([
          getAgents().catch(() => [] as Session[]),
          getSessionMessages(sessionId, 1, 50),
        ]);
        if (cancelled) return;
        const match = agentsList.find((a) => a.session_id === sessionId);
        if (match) {
          setAgent(match);
        } else {
          // Not an agent conversation — fall back to session shell
          try {
            const sess = await getSession(sessionId);
            if (!cancelled && sess) setAgent(sess);
          } catch {/* */}
        }
        setMessages(list.messages);
        // Rehydrate the historical progress strip from whatever the backend
        // persisted on each assistant message's ext. Backwards compatibility:
        // older rows use `agent_log` and newer ones `executionLogs` — both
        // point at the same shape.
        const hydrated: Record<string, ProgressEntry[]> = {};
        for (const m of list.messages) {
          if (m.role !== 'assistant' || !m.ext) continue;
          const raw = (m.ext as { executionLogs?: unknown[]; agent_log?: unknown[] });
          const src = (raw.executionLogs || raw.agent_log) as Array<Record<string, unknown>> | undefined;
          if (!src || src.length === 0) continue;
          hydrated[m.message_id] = src.map((e, i) => ({
            id: String(e.id ?? `${m.message_id}-log-${i}`),
            message: String(e.message ?? ''),
            detail: e.detail ? String(e.detail) : undefined,
            logType: String(e.type ?? e.log_type ?? 'step'),
            timestamp: Number(e.timestamp) || 0,
          })).filter((e) => e.message.trim() !== '');
        }
        setProgressByMsg(hydrated);
        setForceScroll((n) => n + 1);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  /* ---------- autoscroll on new content ---------- */

  // Anchor to the bottom instantly (no animation). Forces scrollBehavior to
  // `auto` on the element itself so any inherited smooth-scroll can't hijack
  // the programmatic scroll — same trick the ai-chatbotee Workflow uses.
  const anchorToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
  }, []);

  // Incremental scroll: only follow along if the user is already near the
  // bottom. Covers streaming chunks + thinking dots arriving over time.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (!nearBottom) return;
    anchorToBottom();
  }, [messages, stream?.content, thinking, anchorToBottom]);

  // Forced scroll: session switch / history load / user just sent — always
  // jump to bottom. useLayoutEffect runs after layout, before paint, so the
  // first frame the user sees is already at the bottom.
  useLayoutEffect(() => {
    anchorToBottom();
    // Re-assert after the browser flushes late layout (fonts, image heights).
    requestAnimationFrame(anchorToBottom);
  }, [forceScroll, anchorToBottom]);

  /* ---------- WebSocket lifecycle ---------- */

  useEffect(() => {
    if (!sessionId) return;
    let mounted = true;

    const connect = () => {
      if (!mounted) return;
      const token = localStorage.getItem('chaya_token') || '';
      if (!token) {
        setWsState('error');
        return;
      }
      const wsBase = getBackendUrl().replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      setWsState('connecting');

      ws.addEventListener('open', () => {
        if (!mounted) return;
        setWsState('open');
        reconnectAttempt.current = 0;
        ws.send(JSON.stringify({ type: 'subscribe', topic: sessionId }));
      });

      ws.addEventListener('message', (ev) => {
        try {
          const envelope = JSON.parse(ev.data);
          if (envelope?.type !== 'event' || !envelope?.payload) return;
          const p = envelope.payload;
          handleEvent(p);
        } catch {
          /* ignore malformed */
        }
      });

      ws.addEventListener('close', () => {
        if (!mounted) return;
        setWsState('closed');
        // Exponential-ish backoff, capped at 10s
        const attempt = Math.min(++reconnectAttempt.current, 6);
        const delay = Math.min(1000 * Math.pow(1.6, attempt), 10_000);
        reconnectTimer.current = window.setTimeout(connect, delay);
      });

      ws.addEventListener('error', () => {
        if (!mounted) return;
        setWsState('error');
      });
    };

    const handleEvent = (p: any) => {
      const type = p?.type;

      if (type === 'agent_thinking') {
        setThinking(true);
        return;
      }

      if (type === 'agent_deciding') {
        // decision phase — keep "thinking" indicator
        setThinking(true);
        return;
      }

      if (type === 'agent_stream_chunk' || type === 'stream_chunk') {
        setThinking(false);
        const id = p.message_id || p.agent_id || 'stream';
        const chunk = p.chunk ?? p.content ?? '';
        setStream((prev) => {
          if (!prev || prev.id !== id) return { id, content: String(chunk || ''), startedAt: Date.now() };
          // 'chunk' is usually a delta; if full content is passed, prefer that
          if (typeof p.chunk === 'string') {
            return { ...prev, content: prev.content + p.chunk };
          }
          if (typeof p.content === 'string') {
            return { ...prev, content: p.content };
          }
          return prev;
        });
        return;
      }

      if (type === 'agent_stream_done' || type === 'stream_done') {
        console.log('[ws] stream_done → fetchFollowups', { msgId: p.message_id, len: (p.content || '').length });
        setThinking(false);
        const finalContent = p.content ?? stream?.content ?? '';
        const msgId = p.message_id || `asst-${Date.now()}`;
        // Kick off followups (async, non-blocking). Look up the last user
        // message to pair with this assistant reply.
        setMessages((prev) => {
          const lastUser = [...prev].reverse().find((m) => m.role === 'user');
          if (lastUser) void fetchFollowupsRef.current(msgId, lastUser.content || '', finalContent);
          return prev;
        });
        setMessages((prev) => {
          // Avoid duplicating if new_message already arrived
          if (prev.some((m) => m.message_id === msgId)) return prev;
          const next: Message = {
            message_id: msgId,
            session_id: sessionId,
            role: 'assistant',
            content: finalContent,
            created_at: new Date().toISOString(),
          };
          return [...prev, next];
        });
        // Snapshot the progress for this turn so it stays visible in history.
        setLiveProgress((live) => {
          if (live.length > 0) {
            setProgressByMsg((m) => ({ ...m, [msgId]: live }));
          }
          return [];
        });
        setStream(null);
        setSending(false);
        return;
      }

      if (type === 'new_message') {
        const raw = p.data || p.message || p;
        const msg: Message = {
          message_id: raw.message_id || raw.id || `m-${Date.now()}`,
          session_id: raw.session_id || raw.conv_id || sessionId,
          role: raw.role || 'assistant',
          content: raw.content || '',
          created_at: raw.created_at || new Date().toISOString(),
          ext: raw.ext,
        };
        setMessages((prev) => {
          if (prev.some((m) => m.message_id === msg.message_id)) return prev;
          return [...prev, msg];
        });
        if (msg.role === 'assistant') {
          console.log('[ws] new_message(assistant) → fetchFollowups', { msgId: msg.message_id, len: (msg.content || '').length });
          setThinking(false);
          setStream(null);
          setSending(false);
          setLiveProgress((live) => {
            if (live.length > 0) {
              setProgressByMsg((m) => ({ ...m, [msg.message_id]: live }));
            }
            return [];
          });
          setMessages((prev) => {
            const lastUser = [...prev].reverse().find((m2) => m2.role === 'user');
            if (lastUser) void fetchFollowupsRef.current(msg.message_id, lastUser.content || '', msg.content || '');
            return prev;
          });
        }
        return;
      }

      if (type === 'agent_interrupt_ack') {
        setThinking(false);
        setStream(null);
        setSending(false);
        return;
      }

      if (type === 'execution_log') {
        // Backend emits these for every tool call / delegation hop / phase
        // change. We render them inline as a progress strip so the user sees
        // the turn advancing in real time instead of staring at a spinner.
        const msgText = String(p.message || '').trim();
        if (!msgText) return;
        const entry: ProgressEntry = {
          id: String(p.id || `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
          message: msgText,
          detail: p.detail ? String(p.detail) : undefined,
          logType: String(p.log_type || 'step'),
          timestamp: Number(p.timestamp) || Date.now(),
        };
        setLiveProgress((prev) => {
          if (prev.some((e) => e.id === entry.id)) return prev;
          return [...prev, entry];
        });
        return;
      }

      // Other types (mcp_* …) — ignore for now
    };

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer.current) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'unsubscribe', topic: sessionId }));
          }
        } catch {/* */}
        ws.close();
      }
      wsRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- attachments ---------- */

  const toggleAttachMenu = () => {
    setAttachMenuOpen((open) => {
      const next = !open;
      if (next && !galleryLoaded) void loadGallery();
      return next;
    });
  };

  const loadGallery = async () => {
    setGalleryLoading(true);
    try {
      const res = await mediaApi.listOutputs(24, 0);
      setGallery(res.items || []);
      setGalleryLoaded(true);
    } catch (e: any) {
      toast({ title: '作品集读不出来', description: e?.message || '', variant: 'destructive' });
    } finally {
      setGalleryLoading(false);
    }
  };

  const pickFiles = () => {
    fileInputRef.current?.click();
    setAttachMenuOpen(false);
  };

  const pickGalleryItem = async (item: MediaOutputItem) => {
    if (attachments.length >= MAX_ATTACH_COUNT) {
      toast({ title: '最多 6 个', variant: 'destructive' });
      return;
    }
    try {
      const url = mediaApi.getOutputFileUrl(item.output_id);
      const token = localStorage.getItem('chaya_token') || '';
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size > MAX_ATTACH_BYTES) {
        toast({ title: '这张太大', description: '单个不超过 10 MB。', variant: 'destructive' });
        return;
      }
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const base64 = dataUrl.split(',', 2)[1] || '';
      const mime = item.mime_type || blob.type || 'image/png';
      const name = (item.prompt || item.output_id).slice(0, 40) || `gallery-${item.output_id.slice(0, 6)}`;
      setAttachments((prev) => [...prev, {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        mimeType: mime,
        dataUrl,
        data: base64,
        size: blob.size,
        kind: detectKind(mime),
        outputId: item.output_id,
      }]);
      setAttachMenuOpen(false);
    } catch (e: any) {
      toast({ title: '拿不到这张', description: e?.message || '', variant: 'destructive' });
    }
  };

  const ingestFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (attachments.length + files.length > MAX_ATTACH_COUNT) {
      toast({ title: '最多 6 个', description: '一次寄太多了。', variant: 'destructive' });
      return;
    }
    const next: Attachment[] = [];
    for (const f of files) {
      if (f.size > MAX_ATTACH_BYTES) {
        toast({ title: `"${f.name}" 太大`, description: '单个不超过 10 MB。', variant: 'destructive' });
        continue;
      }
      try {
        const dataUrl = await readAsDataUrl(f);
        const base64 = dataUrl.split(',', 2)[1] || '';
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          mimeType: f.type || 'application/octet-stream',
          dataUrl,
          data: base64,
          size: f.size,
          kind: detectKind(f.type || ''),
        });
      } catch {
        toast({ title: `读不了 "${f.name}"`, variant: 'destructive' });
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next]);
  };

  const handleFilesPicked = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = ev.target.files ? Array.from(ev.target.files) : [];
    ev.target.value = '';
    await ingestFiles(files);
  };

  /** Paste from clipboard: extract image/* files and treat them as attachments. */
  const handlePaste = async (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = ev.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (blob) {
          // Chrome's clipboard blobs are named "image.png" by default —
          // timestamp for uniqueness.
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const ext = (it.type.split('/')[1] || 'png').replace(/\W/g, '');
          const file = new File([blob], `pasted-${ts}.${ext}`, { type: it.type });
          files.push(file);
        }
      }
    }
    if (files.length > 0) {
      ev.preventDefault();
      await ingestFiles(files);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  /* ---------- Save message to Smartnote as memory ---------- */

  const [savedMemIds, setSavedMemIds] = useState<Record<string, string>>({}); // message_id → memory_id

  /* ---------- Follow-up suggestion chips ---------- */

  /** Called after an assistant message finishes. Fires a best-effort follow-up
   *  suggestion call, stores results in state. Prefers the agent's own LLM
   *  config (any provider), falls back to the first enabled config. */
  const fetchFollowups = useCallback(async (msgId: string, userText: string, assistantText: string) => {
    console.log('[followups] called', {
      msgId,
      userLen: (userText || '').length,
      asstLen: (assistantText || '').length,
      agentId: agent?.id,
      agentLlmCfg: agent?.llm_config_id,
      llmConfigsN: llmConfigs.length,
    });
    if (!assistantText) {
      console.log('[followups] skip: no assistant text');
      return;
    }
    const preferred =
      (agent?.llm_config_id && llmConfigs.find((c) => c.config_id === agent.llm_config_id && c.enabled)) ||
      llmConfigs.find((c) => c.enabled);
    if (!preferred) {
      console.log('[followups] skip: no enabled LLM config. agent.llm_config_id=',
        agent?.llm_config_id, 'configs=', llmConfigs.map((c) => ({ id: c.config_id, enabled: c.enabled, provider: c.provider })));
      return;
    }
    console.log('[followups] using', preferred.provider, preferred.shortname || preferred.model, preferred.config_id);
    try {
      const token = localStorage.getItem('chaya_token') || '';
      const url = `${getBackendUrl()}/api/chat/followups`;
      console.log('[followups] POST', url);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          user_message: (userText || '').slice(0, 2000),
          assistant_message: assistantText.slice(0, 4000),
          config_id: preferred.config_id,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn('[followups] http', res.status, body.slice(0, 300));
        return;
      }
      const raw = await res.json().catch(() => null);
      const data = (raw && raw.code === 0 && raw.data) ? raw.data : raw;
      const list: string[] = Array.isArray(data?.suggestions) ? data.suggestions : [];
      if (list.length === 0) {
        console.info('[followups] empty', data?.note ? `(${data.note})` : '', 'raw:', data);
        return;
      }
      console.log(`[followups] got ${list.length}:`, list);
      setFollowups((prev) => ({ ...prev, [msgId]: list }));
    } catch (e: any) {
      console.warn('[followups] failed:', e?.message || e);
    }
  }, [agent, llmConfigs]);

  // The WS effect below depends only on [sessionId], so its handleEvent
  // closure captures fetchFollowups from first render — when agent/llmConfigs
  // are still empty. Mirror the latest fn through a ref so handleEvent always
  // calls the up-to-date version.
  const fetchFollowupsRef = useRef(fetchFollowups);
  useEffect(() => { fetchFollowupsRef.current = fetchFollowups; }, [fetchFollowups]);

  /* ---------- Rewind: delete target message + everything after ---------- */
  const [rewindingId, setRewindingId] = useState<string | null>(null);

  const rewindToMessage = useCallback(async (target: Message): Promise<void> => {
    if (!sessionId) return;
    // Current state — snapshot so we only touch messages that actually follow
    // target in wall-clock order. We trust index in the current list; anything
    // not yet persisted (local-* optimistic drafts) stays local-only.
    const idx = messages.findIndex((m) => m.message_id === target.message_id);
    if (idx < 0) return;
    const toRemove = messages.slice(idx); // target + everything after
    const persistedIds = toRemove
      .map((m) => m.message_id)
      .filter((id) => id && !id.startsWith('local-'));

    const keepDraft = target.role === 'user' ? (target.content || '').trim() : '';
    const summary = toRemove.length === 1
      ? '回退到这条？这条会被删掉。'
      : `回退到这条？往后 ${toRemove.length - 1} 条也会一起删掉。${keepDraft ? '\n你的原话会回到输入框里。' : ''}`;
    if (!window.confirm(summary)) return;

    setRewindingId(target.message_id);
    try {
      // Delete server-side, newest → oldest so we never leave an assistant
      // message dangling without its user turn. Errors on individual rows
      // bubble up as a single toast — the frontend state refreshes from
      // whatever actually succeeded.
      const errors: string[] = [];
      for (const id of [...persistedIds].reverse()) {
        try { await deleteMessage(sessionId, id); } catch (e: any) {
          errors.push(e?.message || String(e));
        }
      }
      setMessages((prev) => prev.filter((m) => !toRemove.some((t) => t.message_id === m.message_id)));
      setProgressByMsg((prev) => {
        const next = { ...prev };
        for (const m of toRemove) delete next[m.message_id];
        return next;
      });
      setSavedMemIds((prev) => {
        const next = { ...prev };
        for (const m of toRemove) delete next[m.message_id];
        return next;
      });
      if (keepDraft) setDraft((d) => d ? d : keepDraft);
      if (errors.length > 0) {
        toast({
          title: `回退了，${errors.length} 条删不掉`,
          description: errors[0].slice(0, 120),
          variant: 'destructive',
        });
      } else {
        toast({ title: '已回退', description: `删了 ${toRemove.length} 条`, variant: 'success' });
      }
    } finally {
      setRewindingId(null);
    }
  }, [sessionId, messages]);

  const saveMessageToMemory = useCallback(
    async (msg: Message, kind: MemoryKind = 'fact'): Promise<void> => {
      if (!getSmartnoteApiKey()) {
        toast({
          title: '先配 Smartnote',
          description: '去 /settings · 知识 填 API key。',
          variant: 'destructive',
        });
        return;
      }
      const content = (msg.content || '').trim();
      if (!content) {
        toast({ title: '空的不能存', variant: 'destructive' });
        return;
      }
      try {
        const scope = agentId ? `agent:${agentId}` : 'global';
        const aname = (agent?.name || agent?.title || '').trim();
        const tags: string[] = [];
        if (aname) tags.push(aname);
        if (msg.role === 'user') tags.push('user-said');
        if (msg.role === 'assistant') tags.push('agent-said');
        const mem = await smartnoteMemories.create({
          kind,
          content,
          scope,
          tags,
          source_refs: [{ session_id: sessionId || '', message_id: msg.message_id, role: msg.role }],
        });
        setSavedMemIds((prev) => ({ ...prev, [msg.message_id]: mem.id }));
        toast({
          title: '存进知识了',
          description: `${kind} · scope ${scope}`,
          variant: 'success',
        });
      } catch (e: any) {
        toast({ title: '存不进去', description: e?.message || '', variant: 'destructive' });
      }
    },
    [agent, agentId, sessionId],
  );

  /* ---------- send ---------- */

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    if (!sessionId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast({ title: '连接不上', description: '正在重连，稍等一下。', variant: 'destructive' });
      return;
    }

    // If a turn is already in flight, interrupt it before sending the new
    // message. Lets the user redirect mid-turn by just typing + pressing
    // send, rather than having to click "停" first. Pauses briefly so the
    // server's interrupt ack lands before the next message does.
    if (thinking || stream) {
      try { ws.send(JSON.stringify({ type: 'interrupt', topic: sessionId })); } catch {/* */}
      setThinking(false);
      setStream(null);
      await new Promise((r) => setTimeout(r, 80));
    }

    // Optimistic user message (preserve attachment preview locally via ext.media)
    const localId = `local-${Date.now()}`;
    const userMsg: Message = {
      message_id: localId,
      session_id: sessionId,
      role: 'user',
      content: text || (attachments.length > 0 ? `（寄了 ${attachments.length} 个附件）` : ''),
      created_at: new Date().toISOString(),
      ext: attachments.length > 0
        ? {
            media: attachments.map((a) => ({
              type: a.kind === 'image' || a.kind === 'video' || a.kind === 'audio' ? a.kind : 'image',
              mimeType: a.mimeType,
              data: a.dataUrl, // local preview uses full data URL
              outputId: a.outputId,
            })),
          }
        : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setForceScroll((n) => n + 1);

    const payloadMedia = attachments.map((a) => ({
      type: a.kind,
      mime_type: a.mimeType,
      data: a.data, // raw base64 to backend
      name: a.name,
    }));

    setDraft('');
    setAttachments([]);
    setSending(true);
    setThinking(true);
    // Fresh turn → empty the live progress strip. Prior turns keep theirs
    // in `progressByMsg` keyed by message_id.
    setLiveProgress([]);

    // --- Optional RAG: fetch memories, attach to ext.knowledge (NOT content) ---
    // Content stays = what the user typed. The hits live in ext so the bubble
    // can render a compact "知识 · N 条" tag, and the backend can prepend
    // them to its LLM prompt without mutating the persisted user text.
    type KnowledgeHit = { id: string; kind: string; content: string; pinned?: boolean };
    let knowledgeHits: KnowledgeHit[] = [];
    // Skip RAG for short / trivial messages. Classic case: user sends "hi",
    // RAG injects 30 doc chunks, the backend's route classifier sees URLs in
    // the injected content, misroutes to "external link fetch", spends 40s
    // hallucinating. The guard: only run RAG when the user's message has
    // enough substance to actually benefit from retrieval.
    const looksTrivial = (() => {
      const t = text.trim().toLowerCase();
      if (!t) return true;
      if (t.length < 4) return true; // "hi", "ok", "?", "？", "嗨"
      const greetings = ['hi', 'hello', 'hey', '你好', '嗨', '在吗', '在不在', 'ok', '好的', 'thanks', '谢谢', '早', '晚安'];
      if (greetings.some((g) => t === g || t === g + '~' || t === g + '!' || t === g + '！')) return true;
      return false;
    })();
    if (ragEnabled && text && !looksTrivial) {
      const hasKey = !!getSmartnoteApiKey();
      if (!hasKey) {
        console.warn('[RAG] enabled but no Smartnote API key — skipping. Go to Settings · 知识.');
        setLastRag({ at: Date.now(), state: 'skipped', hits: 0, error: '没配 API key' });
      } else {
        const narrowScope = agentId ? `agent:${agentId}` : undefined;
        setLastRag({ at: Date.now(), state: 'querying', hits: 0 });
        try {
          console.log('[RAG] query:', text.slice(0, 60), '· mode:', ragScope, '· topk:', ragTopK);
          // In 'auto' we fire BOTH scoped + workspace in parallel, then merge
          // by id and let Smartnote's hybrid score decide. This is "AI decides"
          // in practice: retrieval ranking IS the decision. Narrow memories
          // tagged with the agent will surface when relevant; otherwise the
          // org's shared brain gets pulled in.
          let hits;
          if (ragScope === 'auto' && narrowScope) {
            const [narrow, wide] = await Promise.all([
              smartnoteRetrieve({ query: text, topk: ragTopK, scope: narrowScope }),
              smartnoteRetrieve({ query: text, topk: ragTopK }),
            ]);
            const byId = new Map<string, typeof narrow.results[number]>();
            for (const r of [...(narrow.results || []), ...(wide.results || [])]) {
              const prev = byId.get(r.id);
              if (!prev || (r.score ?? 0) > (prev.score ?? 0)) byId.set(r.id, r);
            }
            hits = Array.from(byId.values())
              .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
              .slice(0, ragTopK);
          } else {
            const scope = ragScope === 'workspace' ? undefined : narrowScope;
            const res = await smartnoteRetrieve({ query: text, topk: ragTopK, scope });
            hits = res.results || [];
          }
          console.log(`[RAG] got ${hits.length} hit(s)`, hits.map((h) => ({ kind: h.kind, score: h.score, preview: h.content.slice(0, 40) })));
          if (hits.length > 0) {
            knowledgeHits = hits.map((r) => ({
              id: r.id,
              kind: r.kind,
              content: r.content.replace(/\s+/g, ' ').trim(),
              pinned: r.pinned,
            }));
            setLastRag({ at: Date.now(), state: 'done', hits: hits.length });
          } else {
            // Empty is common if this is a fresh workspace or scope filter is too narrow.
            console.info('[RAG] no relevant memories found.',
              `mode=${ragScope}. Add memories first, or switch scope to 'workspace' if you expect cross-agent hits.`);
            setLastRag({ at: Date.now(), state: 'empty', hits: 0 });
          }
        } catch (e: any) {
          const msg = e?.message || String(e);
          console.warn('[RAG] retrieve failed:', msg);
          setLastRag({ at: Date.now(), state: 'error', hits: 0, error: msg });
          // Non-essential — don't block the send
        }
      }
    }

    // If RAG returned hits, attach them to the local user bubble's ext so
    // the chip renders. Doing this AFTER the optimistic push + RAG call
    // keeps the bubble appearing instantly; the tag shows up a moment later.
    if (knowledgeHits.length > 0) {
      setMessages((prev) => prev.map((m) =>
        m.message_id === localId
          ? { ...m, ext: { ...(m.ext || {}), knowledge: knowledgeHits } }
          : m,
      ));
    }

    // Backend contract: payload = { content, conv_id, ext? }
    // Anything beyond content/conv_id must live under `ext` — it's marshalled
    // into envelope.Data and passed into the actor.
    const ext: Record<string, unknown> = {};
    if (payloadMedia.length > 0) ext.media = payloadMedia;
    ext.enable_tool_calling = enableToolCalling;
    if (agentId) ext.agent_id = agentId;
    if (knowledgeHits.length > 0) ext.knowledge = knowledgeHits;

    try {
      ws.send(JSON.stringify({
        type: 'message',
        payload: {
          conv_id: sessionId,
          content: text,
          ext,
        },
      }));
    } catch (e: any) {
      setSending(false);
      setThinking(false);
      toast({ title: '寄不出去', description: e?.message || '', variant: 'destructive' });
    }
  }, [draft, attachments, sessionId, agentId, enableToolCalling, ragEnabled, ragTopK, ragScope]);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) return;
    try {
      ws.send(JSON.stringify({ type: 'interrupt', topic: sessionId }));
      setThinking(false);
      setStream(null);
      setSending(false);
    } catch {/* */}
  }, [sessionId]);

  /* ---------- keyboard ---------- */

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    const wantModifier = cmdEnterToSend !== false;
    const hasModifier = e.metaKey || e.ctrlKey;
    if (wantModifier ? hasModifier : !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const textareaResize = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, []);
  useEffect(textareaResize, [draft, textareaResize]);

  /* ---------- render ---------- */

  const agentName = agent?.name || agent?.title || '未命名';
  const agentSubtitle = firstSentence(agent?.system_prompt || '') || '';
  const modelLabel = useMemo(() => {
    if (!agent) return '';
    // 1) Direct model field on the session (some backends return it).
    const direct = (agent as any).model;
    if (typeof direct === 'string' && direct) return direct;
    // 2) Resolve via llm_config_id → config.shortname / config.model
    if (agent.llm_config_id) {
      const cfg = llmConfigs.find((c) => c.config_id === agent.llm_config_id);
      if (cfg) return cfg.shortname || cfg.model || cfg.name || agent.llm_config_id;
      // Config list not loaded yet, or id isn't in the list — show short hash as placeholder.
      return agent.llm_config_id.length > 10
        ? `cfg-${agent.llm_config_id.slice(0, 6)}`
        : agent.llm_config_id;
    }
    return '未配置模型';
  }, [agent, llmConfigs]);

  const wsStatusLabel = useMemo(() => {
    if (wsState === 'open') return { label: '在线', tone: 'ok' as const };
    if (wsState === 'connecting') return { label: '连接中…', tone: 'warn' as const };
    if (wsState === 'error') return { label: '连接出错', tone: 'err' as const };
    return { label: '断开', tone: 'err' as const };
  }, [wsState]);

  if (!sessionId) {
    return (
      <div style={s.emptyWrap}>
        <p style={s.emptyText}>
          先从左边侧栏挑一只 agent，或者去 <em style={s.emptyEm}>「我养的」</em> 新养一只。
        </p>
      </div>
    );
  }

  return (
    <div style={s.main}>
      {/* Topbar */}
      <header style={s.topbar}>
        <div>
          <div style={s.crumb}>
            Conversation · {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
          </div>
          <h1 style={s.title}>
            {agent ? (
              <>
                {agentName}
                {agentSubtitle && <span style={s.titleDim}> &mdash; {agentSubtitle}</span>}
              </>
            ) : (
              <span style={{ opacity: 0.5 }}>…</span>
            )}
          </h1>
        </div>
        <div style={s.topMeta}>
          {ragEnabled && <RagBadge last={lastRag} />}
          <StatusChip tone={wsStatusLabel.tone}>{wsStatusLabel.label}</StatusChip>
          {modelLabel && <span style={s.meta}>{modelLabel}</span>}
        </div>
      </header>

      {/* Scrollable chat */}
      <section ref={scrollRef} style={s.chat}>
        {loadingHistory && messages.length === 0 ? (
          <LoadingState />
        ) : messages.length === 0 && !stream ? (
          <FirstMessageHint agentName={agentName} />
        ) : (
          <>
            {messages.map((m) => (
              <React.Fragment key={m.message_id}>
                <MessageView
                  msg={m}
                  agentName={agentName}
                  savedMemId={savedMemIds[m.message_id]}
                  onSaveToKnowledge={saveMessageToMemory}
                  onRewind={rewindToMessage}
                  rewinding={rewindingId === m.message_id}
                />
                {m.role === 'assistant' && progressByMsg[m.message_id] && (
                  <ProgressStrip entries={progressByMsg[m.message_id]} historical />
                )}
                {m.role === 'assistant' && followups[m.message_id] && followups[m.message_id].length > 0 && (
                  <FollowupChips
                    suggestions={followups[m.message_id]}
                    onPick={(text) => {
                      setDraft(text);
                      // Best-UX: auto-send so one click = one turn. User can
                      // cancel by typing over the draft before it fires — but
                      // we defer one tick so any in-flight state settles.
                      setTimeout(() => { void send(); }, 0);
                    }}
                  />
                )}
              </React.Fragment>
            ))}
            {(thinking || stream || liveProgress.length > 0) && liveProgress.length > 0 && (
              <ProgressStrip entries={liveProgress} />
            )}
            {thinking && !stream && <ThinkingRow agentName={agentName} />}
            {stream && <StreamingRow content={stream.content} agentName={agentName} />}
          </>
        )}
      </section>

      {/* Composer */}
      <footer style={s.composer}>
        {attachments.length > 0 && (
          <div style={s.attachStrip}>
            {attachments.map((a) => (
              <AttachChip key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <div style={s.composerRow}>
          <div style={s.attachWrap}>
            <button
              type="button"
              onClick={toggleAttachMenu}
              disabled={attachments.length >= MAX_ATTACH_COUNT}
              style={{
                ...s.attachBtn,
                ...(attachments.length >= MAX_ATTACH_COUNT ? s.attachBtnDisabled : null),
                ...(attachMenuOpen ? s.attachBtnActive : null),
              }}
              title="附件（从电脑 / 从作品集）"
              aria-label="附件"
              aria-expanded={attachMenuOpen}
            >
              <ClipSvg />
            </button>
            {attachMenuOpen && (
              <AttachPopover
                onPickFiles={pickFiles}
                onPickGalleryItem={pickGalleryItem}
                gallery={gallery}
                loading={galleryLoading}
                onClose={() => setAttachMenuOpen(false)}
                onRefreshGallery={loadGallery}
              />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,.pdf,.txt,.md"
            onChange={handleFilesPicked}
            style={{ display: 'none' }}
          />
          <div style={s.field}>
            <div style={s.fieldLabel}>说点什么</div>
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={handlePaste}
              placeholder={thinking || stream ? `${agentName} 在写…（你也可以直接打字换方向）` : attachments.length > 0 ? '给它写两句（也可空着）' : '慢慢打，不急。'}
              style={s.textarea}
            />
          </div>
          {(thinking || stream) && !draft.trim() && attachments.length === 0 ? (
            <button type="button" onClick={interrupt} style={s.stopBtn} title="打断当前回答">停</button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={(!draft.trim() && attachments.length === 0) || wsState !== 'open'}
              style={{
                ...((thinking || stream) ? s.redirectBtn : s.sendBtn),
                ...((!draft.trim() && attachments.length === 0) || wsState !== 'open' ? s.sendBtnDisabled : null),
              }}
              title={(thinking || stream) ? '打断并换方向' : (cmdEnterToSend !== false ? '⌘↵ 寄出' : '回车 寄出')}
            >
              {(thinking || stream) ? '↻ 换方向' : '寄出'}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};

/* ============================================================
   Subcomponents
   ============================================================ */

const MessageView: React.FC<{
  msg: Message;
  agentName: string;
  savedMemId?: string;
  onSaveToKnowledge?: (msg: Message, kind?: MemoryKind) => Promise<void> | void;
  onRewind?: (msg: Message) => Promise<void> | void;
  rewinding?: boolean;
}> = ({ msg, agentName, savedMemId, onSaveToKnowledge, onRewind, rewinding }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [kOpen, setKOpen] = useState(false);
  const isMe = msg.role === 'user';
  const isSystem = msg.role === 'system' || msg.role === 'tool';
  if (isSystem) return null;
  const media = msg.ext?.media;
  const knowledge = Array.isArray((msg.ext as any)?.knowledge)
    ? ((msg.ext as any).knowledge as Array<{ id?: string; kind?: string; content?: string; pinned?: boolean }>)
    : [];
  const hasContent = !!(msg.content && msg.content.trim());
  return (
    <div style={{ ...s.msg, ...(isMe ? s.msgMe : null) }} className="chat-msg">
      <div style={{ ...s.byline, ...(isMe ? s.bylineMe : null) }}>
        {isMe ? (
          <>
            <span>你</span>
            <span style={{ ...s.bylineDot, ...s.bylineDotMe }} />
          </>
        ) : (
          <>
            <span style={s.bylineDot} />
            <span>{agentName}</span>
          </>
        )}
      </div>
      {Array.isArray(media) && media.length > 0 && (
        <div style={{ ...s.mediaStrip, ...(isMe ? s.mediaStripMe : null) }}>
          {media.map((m, i) => (
            <MediaThumb key={i} item={m} />
          ))}
        </div>
      )}
      {hasContent && (
        <div style={{ ...s.bubble, ...(isMe ? s.bubbleMe : s.bubbleAgent) }}>
          {msg.content}
        </div>
      )}
      {isMe && knowledge.length > 0 && (
        <div style={s.knowledgeTag}>
          <button
            type="button"
            style={s.knowledgeTagBtn}
            onClick={() => setKOpen((v) => !v)}
            aria-expanded={kOpen}
            title={kOpen ? '收起' : '展开看发给 agent 的知识'}
          >
            🔖 知识 · {knowledge.length} 条 {kOpen ? '▾' : '▸'}
          </button>
          {kOpen && (
            <ol style={s.knowledgeList}>
              {knowledge.map((k, i) => (
                <li key={k.id || i} style={s.knowledgeItem}>
                  <span style={s.knowledgeKind}>
                    {k.kind || 'memory'}{k.pinned ? ' · 置顶' : ''}
                  </span>
                  <span style={s.knowledgeContent}>{k.content}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {hasContent && !msg.message_id.startsWith('local-') && (onSaveToKnowledge || onRewind) && (
        <div style={{ ...s.msgActions, ...(isMe ? s.msgActionsMe : null) }}>
          {onSaveToKnowledge && (savedMemId ? (
            <span style={s.msgActionDone} title={`memory id: ${savedMemId}`}>✓ 已存知识</span>
          ) : (
            <div style={s.msgActionGroup}>
              <button
                type="button"
                style={s.msgActionBtn}
                onClick={() => { setMenuOpen(false); void onSaveToKnowledge(msg, 'fact'); }}
                title="存为事实（默认）"
              >→ 知识</button>
              <button
                type="button"
                style={s.msgActionCaret}
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="选类型"
                aria-expanded={menuOpen}
              >▾</button>
              {menuOpen && (
                <div style={s.msgActionMenu}>
                  {(['fact', 'preference', 'procedure', 'episode'] as MemoryKind[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      style={s.msgActionMenuItem}
                      onClick={() => { setMenuOpen(false); void onSaveToKnowledge(msg, k); }}
                    >
                      {k === 'fact' ? '事实' : k === 'preference' ? '偏好' : k === 'procedure' ? '步骤' : '回忆'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {onRewind && (
            <button
              type="button"
              style={s.msgActionBtn}
              onClick={() => { setMenuOpen(false); void onRewind(msg); }}
              disabled={rewinding}
              title={isMe ? '回退到这条（原话回填到输入框）' : '回退到这条'}
            >
              {rewinding ? '删…' : '↩ 回退'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const MediaThumb: React.FC<{ item: { type: string; mimeType: string; data: string; outputId?: string } }> = ({ item }) => {
  const src = item.data?.startsWith('data:')
    ? item.data
    : `data:${item.mimeType || 'image/png'};base64,${item.data}`;
  const covered = isBlurred(item.outputId);
  if (item.type === 'image' || (item.mimeType || '').startsWith('image/')) {
    return <img src={src} alt="" style={{ ...s.mediaImg, ...(covered ? BLURRED_IMG_CSS : null) }} />;
  }
  if (item.type === 'video' || (item.mimeType || '').startsWith('video/')) {
    return <video src={src} controls style={s.mediaImg} />;
  }
  return <span style={s.mediaFile}>📄 附件</span>;
};

/**
 * Renders the backend's per-turn progress events ("execution_log") as a
 * compact, collapsible strip. Live turns show expanded so the user can watch
 * work advance; historical strips stay collapsed (one-line summary) by
 * default so they don't clutter the transcript.
 */
const ProgressStrip: React.FC<{ entries: ProgressEntry[]; historical?: boolean }> = ({ entries, historical }) => {
  const [open, setOpen] = useState(!historical);
  const [openDetail, setOpenDetail] = useState<Record<string, boolean>>({});
  const listRef = useRef<HTMLOListElement>(null);
  // Keep the strip anchored to the most recent step while the turn is live.
  useLayoutEffect(() => {
    if (historical || !open) return;
    const el = listRef.current;
    if (!el) return;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
  }, [entries.length, historical, open]);
  if (!entries || entries.length === 0) return null;
  const lastMsg = entries[entries.length - 1].message;
  return (
    <div style={s.progressStrip}>
      <button
        type="button"
        style={s.progressHead}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span style={s.progressCount}>
          {historical ? `${entries.length} 步进度` : `进行中 · ${entries.length}`}
        </span>
        <span style={s.progressSummary}>{open ? '收起' : lastMsg}</span>
        <span style={s.progressCaret}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ol ref={listRef} style={s.progressList}>
          {entries.map((e) => {
            const hasDetail = !!(e.detail && e.detail.trim());
            const detailOpen = !!openDetail[e.id];
            return (
              <li key={e.id} style={s.progressItem}>
                <span style={progressDot(e.logType)} />
                <div style={s.progressItemBody}>
                  <button
                    type="button"
                    onClick={() => hasDetail && setOpenDetail((m) => ({ ...m, [e.id]: !m[e.id] }))}
                    style={{ ...s.progressMsgBtn, cursor: hasDetail ? 'pointer' : 'default' }}
                    title={hasDetail ? (detailOpen ? '收起详情' : '展开详情') : e.logType}
                    disabled={!hasDetail}
                  >
                    <span style={s.progressMsg}>{e.message}</span>
                    {hasDetail && (
                      <span style={s.progressDetailHint}>{detailOpen ? '▾' : '▸'}</span>
                    )}
                  </button>
                  {hasDetail && detailOpen && (
                    <pre style={s.progressDetail}>{e.detail}</pre>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

const progressDot = (logType: string): React.CSSProperties => {
  const base: React.CSSProperties = { width: 5, height: 5, borderRadius: '50%', flexShrink: 0, marginTop: 6 };
  if (logType === 'error') return { ...base, background: 'var(--status-error)' };
  if (logType === 'tool_call' || logType === 'tool') return { ...base, background: 'var(--marginalia-ink)' };
  return { ...base, background: 'var(--accent-ink)' };
};

/**
 * Follow-up suggestion chips — large, unambiguously tappable cards rendered
 * below the finished assistant reply. Stacked vertically for easy thumb
 * reach on mobile and quick scanning on desktop. Click = auto-send.
 */
const FollowupChips: React.FC<{ suggestions: string[]; onPick: (text: string) => void }> = ({ suggestions, onPick }) => {
  const [hover, setHover] = useState<number | null>(null);
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div style={s.followupRow}>
      <div style={s.followupLabel}>
        <span style={s.followupLabelLine} aria-hidden />
        <span>接着问</span>
        <span style={s.followupLabelLine} aria-hidden />
      </div>
      <div style={s.followupCol}>
        {suggestions.slice(0, 3).map((sug, i) => {
          const active = hover === i;
          return (
            <button
              key={i}
              type="button"
              style={{ ...s.followupChip, ...(active ? s.followupChipHover : null) }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => onPick(sug)}
              title={`点一下直接发：${sug}`}
            >
              <span style={s.followupChipText}>{sug}</span>
              <span style={{ ...s.followupChipArrow, ...(active ? s.followupChipArrowHover : null) }}>→</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const ThinkingRow: React.FC<{ agentName: string }> = ({ agentName }) => (
  <div style={s.msg}>
    <div style={s.byline}>
      <span style={s.bylineDot} />
      <span>{agentName} · 在想</span>
    </div>
    <div style={{ ...s.bubble, ...s.bubbleAgent, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <InkPulse delay={0} />
      <InkPulse delay={200} />
      <InkPulse delay={400} />
    </div>
  </div>
);

const StreamingRow: React.FC<{ content: string; agentName: string }> = ({ content, agentName }) => (
  <div style={s.msg}>
    <div style={s.byline}>
      <span style={s.bylineDot} />
      <span>{agentName} · 正在写</span>
    </div>
    <div style={{ ...s.bubble, ...s.bubbleAgent, position: 'relative' }}>
      {content}
      <span style={s.cursor}>▌</span>
    </div>
  </div>
);

const AttachPopover: React.FC<{
  onPickFiles: () => void;
  onPickGalleryItem: (item: MediaOutputItem) => void;
  gallery: MediaOutputItem[];
  loading: boolean;
  onClose: () => void;
  onRefreshGallery: () => void;
}> = ({ onPickFiles, onPickGalleryItem, gallery, loading, onClose, onRefreshGallery }) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleAway = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handleAway);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('mousedown', handleAway);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} style={s.attachPopover} role="dialog" aria-label="附件">
      <div style={s.attachPopTabs}>
        <button
          type="button"
          style={{ ...s.attachPopTab, ...s.attachPopTabActive }}
          onClick={onPickFiles}
        >
          从电脑
        </button>
        <span style={s.attachPopTabSep}>/</span>
        <span style={s.attachPopTabPassive}>从作品集</span>
      </div>

      <div style={s.attachPopSection}>
        <div style={s.attachPopLabel}>
          <span>从作品集</span>
          <button type="button" onClick={onRefreshGallery} style={s.attachPopRefresh} title="刷新">
            ↻
          </button>
        </div>
        {loading && gallery.length === 0 ? (
          <div style={s.attachPopHint}>
            <em>正在翻画册…</em>
          </div>
        ) : gallery.length === 0 ? (
          <div style={s.attachPopHint}>
            <em>还没画过东西。</em>
            <br />去「创作」画一张，这里就会有。
          </div>
        ) : (
          <div style={s.attachPopGrid}>
            {gallery.map((item) => (
              <GalleryThumb key={item.output_id} item={item} onPick={() => onPickGalleryItem(item)} />
            ))}
          </div>
        )}
      </div>

      <div style={s.attachPopFooter}>
        <span style={s.attachPopFooterNote}>点击图片 → 挂到消息上</span>
        <button type="button" onClick={onPickFiles} style={s.attachPopPick}>
          <ClipSvg /> 从电脑选
        </button>
      </div>
    </div>
  );
};

const GalleryThumb: React.FC<{ item: MediaOutputItem; onPick: () => void }> = ({ item, onPick }) => {
  const [broken, setBroken] = useState(false);
  const url = mediaApi.getOutputFileUrl(item.output_id);
  const covered = isBlurred(item.output_id);
  return (
    <button
      type="button"
      onClick={onPick}
      style={s.galleryThumb}
      title={(covered ? '已遮 · ' : '') + (item.prompt || item.output_id)}
    >
      {!broken ? (
        <img
          src={url}
          alt=""
          onError={() => setBroken(true)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            ...(covered ? BLURRED_IMG_CSS : null),
          }}
        />
      ) : (
        <span style={s.galleryThumbBroken}>—</span>
      )}
    </button>
  );
};

const AttachChip: React.FC<{ att: Attachment; onRemove: () => void }> = ({ att, onRemove }) => {
  const isImage = att.kind === 'image';
  const covered = isBlurred(att.outputId);
  return (
    <span style={s.attachChip} title={`${covered ? '已遮 · ' : ''}${att.name} · ${(att.size / 1024).toFixed(0)} KB`}>
      {isImage ? (
        <img
          src={att.dataUrl}
          alt=""
          style={{ ...s.attachThumb, ...(covered ? BLURRED_IMG_CSS : null) }}
        />
      ) : (
        <span style={s.attachIcon}>{att.kind === 'video' ? '🎞' : att.kind === 'audio' ? '🎵' : '📄'}</span>
      )}
      <span style={s.attachName}>{att.name}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        style={s.attachRemove}
        aria-label={`移除 ${att.name}`}
        title="移除"
      >×</button>
    </span>
  );
};

const ClipSvg: React.FC = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49L12.95 2.56a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.49" />
  </svg>
);

const InkPulse: React.FC<{ delay: number }> = ({ delay }) => (
  <span
    style={{
      display: 'inline-block',
      width: 5, height: 5,
      borderRadius: '50%',
      background: 'var(--accent-ink)',
      animation: 'inkPulse 1.4s cubic-bezier(0.4,0,0.6,1) infinite',
      animationDelay: `${delay}ms`,
    }}
  />
);

const RagBadge: React.FC<{
  last: { at: number; state: 'querying' | 'done' | 'empty' | 'skipped' | 'error'; hits: number; error?: string } | null;
}> = ({ last }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!last || (last.state !== 'querying' && Date.now() - last.at > 6000)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [last]);

  if (!last) {
    return <span style={{ ...s.statusChip, color: 'var(--pencil-soft)' }} title="RAG on · 还没触发过">RAG 待</span>;
  }
  const fresh = now - last.at < 6000 || last.state === 'querying';
  if (!fresh) {
    return <span style={{ ...s.statusChip, color: 'var(--pencil-soft)' }} title={`上次: ${labelFor(last)}`}>RAG {last.hits > 0 ? `${last.hits}条` : '0'}</span>;
  }
  const color =
    last.state === 'done' ? 'var(--status-success)'
      : last.state === 'empty' ? 'var(--pencil)'
      : last.state === 'querying' ? 'var(--marginalia-ink)'
      : 'var(--status-error)';
  return (
    <span style={{ ...s.statusChip, color }} title={last.error || ''}>
      <span style={{ ...s.statusDot, background: color }} />
      {labelFor(last)}
    </span>
  );
};

const labelFor = (r: { state: 'querying' | 'done' | 'empty' | 'skipped' | 'error'; hits: number }): string => {
  switch (r.state) {
    case 'querying': return 'RAG 查…';
    case 'done':     return `RAG ${r.hits} 条`;
    case 'empty':    return 'RAG 无';
    case 'skipped':  return 'RAG 跳';
    case 'error':    return 'RAG 失败';
  }
};

const StatusChip: React.FC<{ tone: 'ok' | 'warn' | 'err'; children: React.ReactNode }> = ({ tone, children }) => {
  const color =
    tone === 'ok' ? 'var(--status-success)'
      : tone === 'warn' ? 'var(--marginalia-ink)'
      : 'var(--status-error)';
  return (
    <span style={{ ...s.statusChip, color }}>
      <span style={{ ...s.statusDot, background: color }} />
      {children}
    </span>
  );
};

const LoadingState: React.FC = () => (
  <div style={s.centerState}>
    <p style={s.centerText}>正在翻前几页的对话…</p>
  </div>
);

const FirstMessageHint: React.FC<{ agentName: string }> = ({ agentName }) => (
  <div style={s.centerState}>
    <svg width="120" height="10" viewBox="0 0 120 10" fill="none" aria-hidden>
      <path
        d="M1 5.2 C 16 3.2, 32 7.2, 48 4.6 S 88 3.4, 105 5.8 S 115 4.2, 119 5.0"
        stroke="var(--accent-ink)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeOpacity="0.6"
        fill="none"
      />
    </svg>
    <p style={s.centerText}>
      跟 <em style={s.emptyEm}>{agentName}</em> 还没开始聊。
      <br />下面写一句话，按 <span style={s.kbd}>⌘↵</span> 寄出。
    </p>
  </div>
);

/* ============================================================
   Utils + Styles
   ============================================================ */

const firstSentence = (s: string): string => {
  const t = (s || '').trim();
  if (!t) return '';
  const m = t.match(/^([^。.\n]{3,40})[。.\n]?/);
  return m ? m[1] : (t.length > 28 ? t.slice(0, 28) + '…' : t);
};

const s: Record<string, React.CSSProperties> = {
  main: {
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--paper)',
    color: 'var(--ink)',
    fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif",
  },
  emptyWrap: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  emptyText: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 15,
    color: 'var(--pencil)',
    textAlign: 'center',
  },
  emptyEm: {
    color: 'var(--accent-ink)',
    fontStyle: 'italic',
    fontFamily: "'Young Serif', serif",
  },

  /* Topbar */
  topbar: {
    padding: '22px 40px 16px',
    borderBottom: '1px solid var(--rule)',
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
    flexShrink: 0,
  },
  crumb: {
    fontSize: 11,
    color: 'var(--pencil)',
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 26,
    color: 'var(--ink-strong)',
    letterSpacing: '-0.01em',
    margin: '4px 0 0',
    fontWeight: 400,
  },
  titleDim: {
    color: 'var(--pencil)',
    fontStyle: 'italic',
    fontSize: 18,
  },
  topMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  meta: {
    fontSize: 11,
    color: 'var(--pencil-soft)',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.08em',
  },
  statusChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  statusDot: {
    width: 6, height: 6, borderRadius: '50%',
  },

  /* Chat scroll — scroll-behavior must stay `auto` (instant). Any value of
     `smooth` here causes every programmatic scrollTop assignment to animate,
     which fights the autoscroll logic and makes new messages "slide" in. */
  chat: {
    padding: '32px 40px',
    overflowY: 'auto',
  },
  centerState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: '72px 20px',
  },
  centerText: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 14,
    color: 'var(--pencil)',
    textAlign: 'center',
    lineHeight: 1.8,
  },
  kbd: {
    fontFamily: "'JetBrains Mono', monospace",
    fontStyle: 'normal',
    fontSize: 11,
    color: 'var(--pencil-soft)',
    padding: '1px 6px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    background: 'var(--page-elev)',
    letterSpacing: '0.04em',
  },

  /* Message — column that hugs its own side so user's bubble sits flush
     right against the "你 ●" byline and agent's sits flush left. */
  msg: {
    maxWidth: '62ch',
    marginBottom: 28,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  msgMe: {
    marginLeft: 'auto',
    alignItems: 'flex-end',
  },
  byline: {
    fontSize: 11,
    color: 'var(--pencil)',
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    marginBottom: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  bylineMe: {
    justifyContent: 'flex-end',
  },
  bylineDot: {
    width: 5, height: 5,
    background: 'var(--accent-ink)',
    borderRadius: '50%',
  },
  bylineDotMe: {
    background: 'var(--marginalia-ink)',
  },
  bubble: {
    fontSize: 15.5,
    lineHeight: 1.65,
    color: 'var(--ink)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    padding: '10px 14px',
    borderRadius: 3,
    border: '1px solid var(--rule)',
    maxWidth: '100%',
  },
  bubbleAgent: {
    /* Agent reply — a soft page-elev card so it reads as "printed" against
       the paper background. Keeps the letterpress feel (no pill/chat-bubble
       gloss), just a subtle substrate. */
    background: 'var(--page-elev)',
    borderColor: 'var(--rule-strong)',
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.04)',
  },
  bubbleMe: {
    /* User reply — aubergine-tinted so it's obviously "yours". Right-aligned
       text so the bubble hugs the right edge alongside the "你 ●" byline. */
    background: 'color-mix(in oklch, var(--accent-ink) 8%, var(--paper))',
    borderColor: 'color-mix(in oklch, var(--accent-ink) 28%, var(--rule-strong))',
    color: 'var(--ink-strong)',
  },
  mediaStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
  },
  mediaStripMe: {
    justifyContent: 'flex-end',
  },

  /* Knowledge tag on user bubbles — compact "🔖 N 条" chip that expands to
     show the retrieved memories. Editorial side-note feel, never competes
     with the bubble itself. */
  knowledgeTag: {
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 6,
    maxWidth: '100%',
  },
  knowledgeTagBtn: {
    padding: '3px 8px',
    background: 'color-mix(in oklch, var(--accent-ink) 6%, transparent)',
    border: '1px dotted color-mix(in oklch, var(--accent-ink) 32%, var(--rule))',
    borderRadius: 2,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.04em',
    cursor: 'pointer',
  },
  knowledgeList: {
    listStyle: 'none',
    margin: 0,
    padding: '8px 10px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule)',
    borderRadius: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    maxHeight: 220,
    overflowY: 'auto',
    width: '100%',
    maxWidth: '62ch',
  },
  knowledgeItem: {
    fontSize: 12.5,
    lineHeight: 1.55,
    color: 'var(--ink)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    borderBottom: '1px dotted var(--rule)',
    paddingBottom: 6,
  },
  knowledgeKind: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.06em',
    color: 'var(--marginalia-ink)',
    textTransform: 'uppercase',
  },
  knowledgeContent: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
  },

  /* Follow-up chips — stacked full-width cards. Clearly tappable, clearly
     "different thing" from the main answer. Letterpress: page-elev paper
     with rule-strong border, accent-ink arrow that slides on hover. */
  followupRow: {
    maxWidth: '62ch',
    margin: '-6px 0 22px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  followupLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    letterSpacing: '0.18em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    padding: '2px 0',
  },
  followupLabelLine: {
    flex: 1,
    height: 1,
    borderTop: '1px dotted var(--rule)',
  },
  followupCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  followupChip: {
    // Full-width row-button: rectangular card, clear tap target ≥ 44px tall
    // on average content. Intentionally rectangular (no pill / no rounded
    // corners beyond 2px) to stay in letterpress vocabulary.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    width: '100%',
    padding: '10px 14px',
    background: 'var(--page-elev)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--rule-strong)',
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink)',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background 160ms ease, border-color 160ms ease, transform 160ms ease',
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.04)',
  },
  followupChipHover: {
    background: 'color-mix(in oklch, var(--accent-ink) 8%, var(--page-elev))',
    borderColor: 'var(--accent-ink)',
    transform: 'translateX(2px)',
  },
  followupChipText: {
    flex: 1,
    fontStyle: 'italic',
    lineHeight: 1.4,
  },
  followupChipArrow: {
    flexShrink: 0,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 16,
    color: 'var(--pencil-soft)',
    transition: 'color 160ms ease, transform 160ms ease',
  },
  followupChipArrowHover: {
    color: 'var(--accent-ink)',
    transform: 'translateX(3px)',
  },

  /* Progress strip — backend execution_log events rendered as a compact
     collapsible row sitting between assistant turns. Intentionally quieter
     than the bubble: treated as editorial "side note" not main content. */
  progressStrip: {
    maxWidth: '62ch',
    margin: '-14px 0 20px',
    fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)',
  },
  progressHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    width: '100%',
    padding: '4px 2px',
    background: 'transparent',
    border: 0,
    borderBottom: '1px dotted var(--rule)',
    cursor: 'pointer',
    color: 'var(--pencil)',
    fontSize: 11,
    letterSpacing: '0.04em',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  progressCount: {
    color: 'var(--marginalia-ink)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    flexShrink: 0,
  },
  progressSummary: {
    flex: 1,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    letterSpacing: 'normal',
    textTransform: 'none',
    fontSize: 12.5,
  },
  progressCaret: {
    color: 'var(--pencil-soft)',
    flexShrink: 0,
  },
  progressList: {
    listStyle: 'none',
    margin: 0,
    padding: '6px 2px 4px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    // Fixed height — long turns (20+ steps) would otherwise shove the real
    // answer off-screen. Scrolls internally; newest steps auto-scroll thanks
    // to flex-direction: column + scrollTop update on append (handled by
    // useLayoutEffect in ProgressStrip).
    maxHeight: 200,
    overflowY: 'auto',
  },
  progressItem: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--pencil)',
  },
  progressMsg: {
    flex: 1,
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    wordBreak: 'break-word',
  },
  progressItemBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  progressMsgBtn: {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
    width: '100%',
    padding: 0,
    background: 'transparent',
    border: 0,
    color: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  progressDetailHint: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    color: 'var(--pencil-soft)',
    flexShrink: 0,
  },
  progressDetail: {
    margin: '2px 0 0',
    padding: '6px 8px',
    background: 'color-mix(in oklch, var(--accent-ink) 5%, var(--page-elev))',
    border: '1px solid var(--rule)',
    borderRadius: 2,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    lineHeight: 1.55,
    color: 'var(--ink)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'auto',
    maxHeight: 240,
  },
  mediaImg: {
    maxWidth: 240,
    maxHeight: 240,
    borderRadius: 3,
    border: '1px solid var(--rule-strong)',
    display: 'block',
    background: 'color-mix(in oklch, var(--ink) 5%, var(--paper))',
  },
  mediaFile: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--pencil)',
  },
  /* Per-message action row */
  msgActions: {
    marginTop: 8,
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    opacity: 0.55,
    transition: 'opacity 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  msgActionsMe: {
    justifyContent: 'flex-end',
  },
  msgActionGroup: {
    display: 'inline-flex',
    position: 'relative',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
  },
  msgActionBtn: {
    background: 'transparent',
    border: 0,
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 11.5,
    color: 'var(--ink)',
    padding: '4px 10px',
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  msgActionCaret: {
    background: 'transparent',
    border: 0,
    borderLeft: '1px solid var(--rule)',
    color: 'var(--pencil)',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 10,
    lineHeight: 1,
  },
  msgActionMenu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 10,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    boxShadow: '0 6px 16px oklch(0.18 0.02 310 / 0.15)',
    display: 'flex',
    flexDirection: 'column',
    padding: 4,
    minWidth: 96,
  },
  msgActionMenuItem: {
    background: 'transparent',
    border: 0,
    padding: '6px 10px',
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 1,
    letterSpacing: '0.02em',
  },
  msgActionDone: {
    fontFamily: "'Young Serif', serif",
    fontSize: 11.5,
    color: 'var(--status-success)',
    fontStyle: 'italic',
  },
  cursor: {
    color: 'var(--accent-ink)',
    animation: 'blink 1.1s steps(1) infinite',
    marginLeft: 2,
  },

  /* Composer */
  composer: {
    borderTop: '1px solid var(--rule)',
    padding: '16px 40px 22px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    flexShrink: 0,
    background: 'var(--paper)',
  },
  composerRow: {
    display: 'flex',
    gap: 14,
    alignItems: 'flex-end',
  },
  attachStrip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 2,
  },
  attachChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px 4px 4px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    maxWidth: 220,
    fontSize: 12,
    color: 'var(--ink)',
    fontFamily: "'Young Serif', serif",
  },
  attachThumb: {
    width: 28, height: 28,
    borderRadius: 2,
    objectFit: 'cover',
    border: '1px solid var(--rule-strong)',
    background: 'color-mix(in oklch, var(--ink) 10%, var(--paper))',
  },
  attachIcon: {
    width: 28, height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
  },
  attachName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12,
    color: 'var(--pencil)',
  },
  attachRemove: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil-soft)',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '0 2px',
    marginLeft: 2,
  },
  attachWrap: {
    position: 'relative',
    flexShrink: 0,
  },
  attachBtn: {
    width: 36, height: 36,
    marginBottom: 6,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--pencil)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    transition: 'color 180ms cubic-bezier(0.22,1,0.36,1), border-color 180ms cubic-bezier(0.22,1,0.36,1), background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  attachBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  attachBtnActive: {
    color: 'var(--accent-ink)',
    borderColor: 'var(--accent-ink)',
    background: 'color-mix(in oklch, var(--accent-ink) 8%, transparent)',
  },
  /* Attach popover */
  attachPopover: {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    left: 0,
    width: 360,
    maxHeight: 420,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 3,
    boxShadow: '0 14px 40px oklch(0.18 0.02 310 / 0.18), 0 2px 6px oklch(0.18 0.02 310 / 0.08)',
    zIndex: 20,
    overflow: 'hidden',
  },
  attachPopTabs: {
    padding: '14px 18px 6px',
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    borderBottom: '1px solid var(--rule)',
  },
  attachPopTab: {
    background: 'transparent',
    border: 0,
    padding: 0,
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
    cursor: 'pointer',
    letterSpacing: '0.01em',
  },
  attachPopTabActive: {
    // underline done via footer buttons; here we just bold
    fontWeight: 500,
  },
  attachPopTabPassive: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--pencil)',
    letterSpacing: '0.01em',
    fontWeight: 400,
  },
  attachPopTabSep: {
    color: 'var(--rule-strong)',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
  },
  attachPopSection: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '10px 14px 12px',
  },
  attachPopLabel: {
    fontSize: 10,
    letterSpacing: '0.22em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    margin: '6px 4px 10px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  attachPopRefresh: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil)',
    cursor: 'pointer',
    fontSize: 13,
    padding: '2px 6px',
    lineHeight: 1,
  },
  attachPopHint: {
    padding: '18px 10px',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--pencil)',
    textAlign: 'center',
    lineHeight: 1.7,
  },
  attachPopGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 6,
  },
  galleryThumb: {
    aspectRatio: '1 / 1',
    padding: 0,
    background: 'color-mix(in oklch, var(--ink) 5%, var(--paper))',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'border-color 180ms cubic-bezier(0.22,1,0.36,1), transform 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  galleryThumbBroken: {
    color: 'var(--pencil-soft)',
    fontSize: 18,
  },
  attachPopFooter: {
    padding: '10px 14px 12px',
    borderTop: '1px solid var(--rule)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page-elev))',
    flexShrink: 0,
  },
  attachPopFooterNote: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--pencil)',
  },
  attachPopPick: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'transparent',
    color: 'var(--accent-ink)',
    border: '1px solid var(--accent-ink)',
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontSize: 12.5,
    cursor: 'pointer',
  },
  field: { flex: 1, minWidth: 0 },
  fieldLabel: {
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  textarea: {
    width: '100%',
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    outline: 'none',
    fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif",
    fontSize: 15,
    color: 'var(--ink)',
    padding: '10px 0',
    resize: 'none',
    lineHeight: 1.55,
    minHeight: 40,
    maxHeight: 220,
    overflow: 'auto',
    caretColor: 'var(--accent-ink)',
    transition: 'border-bottom-color 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  sendBtn: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    padding: '12px 22px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.02em',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 8px oklch(0.18 0.02 310 / 0.12)',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  sendBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
  stopBtn: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    padding: '12px 20px',
    background: 'transparent',
    color: 'var(--status-error)',
    border: '1px solid var(--status-error)',
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.02em',
  },
  redirectBtn: {
    // Same shape as send, but marginalia ochre — signals "turn is running,
    // sending now will interrupt and redirect" without looking alarming.
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    padding: '12px 20px',
    background: 'var(--marginalia-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.02em',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 8px oklch(0.18 0.02 310 / 0.12)',
  },
};

/* ---------- keyframes ---------- */
const styleTagId = 'chat-page-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(styleTagId)) {
  const tag = document.createElement('style');
  tag.id = styleTagId;
  tag.textContent = `
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes inkPulse {
      0%, 100% { opacity: 1; transform: translateY(0); }
      50%      { opacity: 0.35; transform: translateY(-1px); }
    }
    .chat-msg > div:last-child[style*="opacity: 0.55"] { opacity: 0.55; }
    .chat-msg:hover > div[style*="opacity: 0.55"] { opacity: 1 !important; }
    .chat-msg button[style]:hover { background: color-mix(in oklch, var(--accent-ink) 6%, transparent) !important; }
  `;
  document.head.appendChild(tag);
}

export default ChatPage;
