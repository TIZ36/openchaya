import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getAgents, getSession, getSessionMessages,
  type Session, type Message,
} from '../services/chat';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { smartnoteRetrieve, smartnoteMemories, getSmartnoteApiKey, type MemoryKind } from '../services/smartnoteApi';
import { getBackendUrl } from '../utils/backendUrl';
import { toast } from './ui/use-toast';

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
}

type StreamingDraft = { id: string; content: string; startedAt: number };

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
  ragEnabled, ragTopK = 5,
}) => {
  const [agent, setAgent] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [stream, setStream] = useState<StreamingDraft | null>(null);
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
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  /* ---------- autoscroll on new content ---------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only scroll if user is near the bottom
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: stream ? 'auto' : 'smooth' });
      });
    }
  }, [messages, stream?.content, thinking]);

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
        setThinking(false);
        const finalContent = p.content ?? stream?.content ?? '';
        const msgId = p.message_id || `asst-${Date.now()}`;
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
          setThinking(false);
          setStream(null);
          setSending(false);
        }
        return;
      }

      if (type === 'agent_interrupt_ack') {
        setThinking(false);
        setStream(null);
        setSending(false);
        return;
      }

      // Other types (execution_log, mcp_*) — ignore for now
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
            })),
          }
        : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

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

    // --- Optional RAG: fetch memories + prepend to content as compact context ---
    let finalContent = text;
    if (ragEnabled && text) {
      const hasKey = !!getSmartnoteApiKey();
      if (!hasKey) {
        console.warn('[RAG] enabled but no Smartnote API key — skipping. Go to Settings · 知识.');
        setLastRag({ at: Date.now(), state: 'skipped', hits: 0, error: '没配 API key' });
      } else {
        const scopes = agentId ? `agent:${agentId}` : undefined;
        setLastRag({ at: Date.now(), state: 'querying', hits: 0 });
        try {
          console.log('[RAG] query:', text.slice(0, 60), '· scope:', scopes || '(workspace-wide)', '· topk:', ragTopK);
          const res = await smartnoteRetrieve({
            query: text,
            topk: ragTopK,
            scope: scopes,
          });
          // No score threshold — pgvector retrieve already ranks. Trust the topk cap.
          const hits = res.results || [];
          console.log(`[RAG] got ${hits.length} hit(s)`, hits.map((h) => ({ kind: h.kind, score: h.score, preview: h.content.slice(0, 40) })));
          if (hits.length > 0) {
            const block = hits
              .map((r) => `- (${r.kind}${r.pinned ? ' · pinned' : ''}) ${r.content.replace(/\s+/g, ' ').trim()}`)
              .join('\n');
            finalContent = `[知识 · 来自你之前存的]\n${block}\n\n---\n${text}`;
            setLastRag({ at: Date.now(), state: 'done', hits: hits.length });
          } else {
            // Empty is common if this is a fresh workspace or scope filter is too narrow.
            console.info('[RAG] no relevant memories found.',
              scopes ? `Try loosening scope (currently "${scopes}") or add memories first.` : 'Workspace may be empty.');
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

    try {
      ws.send(JSON.stringify({
        type: 'message',
        payload: {
          conv_id: sessionId,
          content: finalContent,
          enable_tool_calling: enableToolCalling,
          media: payloadMedia.length > 0 ? payloadMedia : undefined,
        },
      }));
    } catch (e: any) {
      setSending(false);
      setThinking(false);
      toast({ title: '寄不出去', description: e?.message || '', variant: 'destructive' });
    }
  }, [draft, attachments, sessionId, agentId, enableToolCalling, ragEnabled, ragTopK]);

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
              <MessageView
                key={m.message_id}
                msg={m}
                agentName={agentName}
                savedMemId={savedMemIds[m.message_id]}
                onSaveToKnowledge={saveMessageToMemory}
              />
            ))}
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
              placeholder={thinking || stream ? `${agentName} 在写…` : attachments.length > 0 ? '给它写两句（也可空着）' : '慢慢打，不急。'}
              disabled={!!stream || sending && thinking}
              style={s.textarea}
            />
          </div>
          {(thinking || stream) ? (
            <button type="button" onClick={interrupt} style={s.stopBtn} title="打断">停</button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={(!draft.trim() && attachments.length === 0) || wsState !== 'open'}
              style={{
                ...s.sendBtn,
                ...((!draft.trim() && attachments.length === 0) || wsState !== 'open' ? s.sendBtnDisabled : null),
              }}
              title={cmdEnterToSend !== false ? '⌘↵ 寄出' : '回车 寄出'}
            >
              寄出
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
}> = ({ msg, agentName, savedMemId, onSaveToKnowledge }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const isMe = msg.role === 'user';
  const isSystem = msg.role === 'system' || msg.role === 'tool';
  if (isSystem) return null;
  const media = msg.ext?.media;
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
      {hasContent && <div style={s.bubble}>{msg.content}</div>}
      {hasContent && onSaveToKnowledge && !msg.message_id.startsWith('local-') && (
        <div style={{ ...s.msgActions, ...(isMe ? s.msgActionsMe : null) }}>
          {savedMemId ? (
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
          )}
        </div>
      )}
    </div>
  );
};

const MediaThumb: React.FC<{ item: { type: string; mimeType: string; data: string } }> = ({ item }) => {
  const src = item.data?.startsWith('data:')
    ? item.data
    : `data:${item.mimeType || 'image/png'};base64,${item.data}`;
  if (item.type === 'image' || (item.mimeType || '').startsWith('image/')) {
    return <img src={src} alt="" style={s.mediaImg} />;
  }
  if (item.type === 'video' || (item.mimeType || '').startsWith('video/')) {
    return <video src={src} controls style={s.mediaImg} />;
  }
  return <span style={s.mediaFile}>📄 附件</span>;
};

const ThinkingRow: React.FC<{ agentName: string }> = ({ agentName }) => (
  <div style={s.msg}>
    <div style={s.byline}>
      <span style={s.bylineDot} />
      <span>{agentName} · 在想</span>
    </div>
    <div style={{ ...s.bubble, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
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
    <div style={{ ...s.bubble, position: 'relative' }}>
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
  return (
    <button
      type="button"
      onClick={onPick}
      style={s.galleryThumb}
      title={item.prompt || item.output_id}
    >
      {!broken ? (
        <img
          src={url}
          alt=""
          onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span style={s.galleryThumbBroken}>—</span>
      )}
    </button>
  );
};

const AttachChip: React.FC<{ att: Attachment; onRemove: () => void }> = ({ att, onRemove }) => {
  const isImage = att.kind === 'image';
  return (
    <span style={s.attachChip} title={`${att.name} · ${(att.size / 1024).toFixed(0)} KB`}>
      {isImage ? (
        <img src={att.dataUrl} alt="" style={s.attachThumb} />
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

  /* Chat scroll */
  chat: {
    padding: '32px 40px',
    overflowY: 'auto',
    scrollBehavior: 'smooth',
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

  /* Message */
  msg: {
    maxWidth: '62ch',
    marginBottom: 28,
  },
  msgMe: {
    marginLeft: 'auto',
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
    lineHeight: 1.7,
    color: 'var(--ink)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
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
