import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  smartnoteProbe, smartnoteMemories, smartnoteRetrieve, smartnoteDocuments,
  getSmartnoteApiKey,
  type Memory, type MemoryKind, type MemoryCreate, type MemoryPatch,
  type RetrievedMemory, type Document,
} from '../services/smartnoteApi';
import { toast } from './ui/use-toast';
import {
  PaperPage, PaperTopbar, PaperContent, PaperButton, PaperChip,
} from './paper';

/* ============================================================
   知识 / Library · via Smartnote Cloud
   Tabs: 记忆 · 文档 · 搜
   ============================================================ */

type Tab = 'memories' | 'documents' | 'search';

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  procedure: '步骤',
  episode: '回忆',
  document_ref: '文档块',
};

const KIND_TONES: Record<MemoryKind, 'default' | 'ok' | 'warn' | 'soft' | 'err'> = {
  fact: 'default',
  preference: 'ok',
  procedure: 'warn',
  episode: 'soft',
  document_ref: 'soft',
};

const KnowledgePage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('memories');
  const [conn, setConn] = useState<'probing' | 'ok' | 'no-key' | 'down'>('probing');
  const [connErr, setConnErr] = useState<string | null>(null);

  const probe = useCallback(async () => {
    if (!getSmartnoteApiKey()) { setConn('no-key'); return; }
    setConn('probing');
    const r = await smartnoteProbe();
    if (r.ok) { setConn('ok'); setConnErr(null); }
    else { setConn('down'); setConnErr(r.error || null); }
  }, []);

  useEffect(() => { void probe(); }, [probe]);
  // Re-probe when localStorage changes (SettingsPage saves key)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key && (e.key.includes('smartnote'))) void probe();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [probe]);

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Four · Library · via Smartnote Cloud"
        title="知识"
        subtitle={
          conn === 'no-key'  ? '先去「设置 · 高级」配一下 Smartnote API key。'
          : conn === 'down'  ? '连不上。去「设置 · 高级」看看 base URL / key 对不对。'
          : conn === 'probing' ? '正在问一下 Smartnote…'
          : 'memories 在 cloud 上。前端做读写 + 检索 + 文档入库。'
        }
        meta={
          <>
            <ConnDot state={conn} /> {conn === 'ok' ? 'connected' : conn === 'probing' ? 'probing' : conn === 'no-key' ? 'no key' : 'down'}
          </>
        }
        actions={
          <>
            <PaperButton variant="ghost" size="small" onClick={() => { window.location.hash = '#/settings'; }}>
              配置
            </PaperButton>
            <PaperButton variant="ghost" size="small" onClick={() => void probe()}>刷新</PaperButton>
          </>
        }
      />

      <PaperContent>
        {conn === 'no-key' && <NoKeyState />}
        {conn === 'down' && <DownState error={connErr} onRetry={probe} />}
        {(conn === 'ok' || conn === 'probing') && (
          <>
            {/* Tabs */}
            <div style={s.tabs}>
              <TabButton active={tab === 'memories'} onClick={() => setTab('memories')}>记忆</TabButton>
              <span style={s.tabSep}>/</span>
              <TabButton active={tab === 'documents'} onClick={() => setTab('documents')}>文档</TabButton>
              <span style={s.tabSep}>/</span>
              <TabButton active={tab === 'search'} onClick={() => setTab('search')}>搜</TabButton>
            </div>

            {tab === 'memories' && <MemoriesTab />}
            {tab === 'documents' && <DocumentsTab />}
            {tab === 'search' && <SearchTab />}
          </>
        )}
      </PaperContent>
    </PaperPage>
  );
};

/* ============================================================
   MEMORIES
   ============================================================ */

const MemoriesTab: React.FC = () => {
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [kindFilter, setKindFilter] = useState<'all' | MemoryKind>('all');
  const [scopeFilter, setScopeFilter] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<null | 'new' | Memory>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await smartnoteMemories.list({
        kind: kindFilter === 'all' ? undefined : kindFilter,
        scope: scopeFilter || undefined,
        limit: 100,
      });
      setItems(data.memories || []);
    } catch (e: any) {
      setErr(e?.message || '取 memories 出错');
    } finally {
      setLoading(false);
    }
  }, [kindFilter, scopeFilter]);

  useEffect(() => { void load(); }, [load]);

  const togglePin = async (m: Memory) => {
    try {
      await smartnoteMemories.update(m.id, { pinned: !m.pinned });
      await load();
    } catch (e: any) {
      toast({ title: '改不了', description: e?.message || '', variant: 'destructive' });
    }
  };

  const remove = async (m: Memory) => {
    if (!confirm(`删掉这条 ${KIND_LABELS[m.kind]} memory？`)) return;
    try {
      await smartnoteMemories.remove(m.id);
      await load();
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    }
  };

  const save = async (draft: Partial<MemoryCreate> & { id?: string }) => {
    try {
      if (draft.id) {
        const patch: MemoryPatch = {};
        if (draft.content !== undefined) patch.content = draft.content;
        if (draft.scope !== undefined) patch.scope = draft.scope;
        if (draft.tags !== undefined) patch.tags = draft.tags;
        if (draft.pinned !== undefined) patch.pinned = draft.pinned;
        await smartnoteMemories.update(draft.id, patch);
      } else {
        await smartnoteMemories.create({
          kind: (draft.kind || 'fact') as MemoryKind,
          content: draft.content || '',
          scope: draft.scope || 'global',
          tags: draft.tags || [],
          pinned: !!draft.pinned,
        });
      }
      setEditing(null);
      await load();
      toast({ title: '存好了', variant: 'success' });
    } catch (e: any) {
      toast({ title: '存不进去', description: e?.message || '', variant: 'destructive' });
    }
  };

  return (
    <>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <div style={s.filterChips}>
          <button type="button" onClick={() => setKindFilter('all')} style={{ ...s.filterChip, ...(kindFilter === 'all' ? s.filterChipOn : null) }}>全部</button>
          {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              style={{ ...s.filterChip, ...(kindFilter === k ? s.filterChipOn : null) }}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <input
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          placeholder="scope（如 agent:abc 或 留空）"
          style={s.scopeInput}
        />
        <PaperButton size="small" onClick={() => setEditing('new')}>+ 新记一条</PaperButton>
      </div>

      {editing !== null && (
        <MemoryForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}

      {err && <div style={s.errBox}>{err}</div>}
      {loading && items.length === 0 ? (
        <Loading text="正在翻 memory…" />
      ) : items.length === 0 ? (
        <Empty title="这里没 memory" hint="点右上「+ 新记一条」，或试试不同的过滤条件。" />
      ) : (
        <div style={s.memList}>
          {items.map((m) => (
            <MemoryRow
              key={m.id}
              m={m}
              onPin={() => void togglePin(m)}
              onEdit={() => setEditing(m)}
              onDelete={() => void remove(m)}
            />
          ))}
        </div>
      )}
    </>
  );
};

const MemoryRow: React.FC<{ m: Memory; onPin: () => void; onEdit: () => void; onDelete: () => void }> = ({ m, onPin, onEdit, onDelete }) => (
  <article style={s.memRow}>
    <div style={s.memMeta}>
      <PaperChip tone={KIND_TONES[m.kind]}>{KIND_LABELS[m.kind]}</PaperChip>
      {m.scope && m.scope !== 'global' && (
        <span style={s.memScope}>scope: {m.scope}</span>
      )}
      {m.tags.length > 0 && m.tags.map((t) => (
        <span key={t} style={s.memTag}>#{t}</span>
      ))}
      {m.pinned && <span style={s.memPinned} title="置顶">★</span>}
      <span style={s.memDate}>{new Date(m.created_at).toLocaleDateString('zh-CN')}</span>
      <div style={s.memActions}>
        <button type="button" style={s.memIconBtn} onClick={onPin} title={m.pinned ? '取消置顶' : '置顶'}>
          {m.pinned ? '✦' : '☆'}
        </button>
        <button type="button" style={s.memIconBtn} onClick={onEdit} title="改">改</button>
        <button type="button" style={{ ...s.memIconBtn, color: 'var(--status-error)' }} onClick={onDelete} title="删">删</button>
      </div>
    </div>
    <div style={s.memContent}>{m.content}</div>
  </article>
);

const MemoryForm: React.FC<{
  initial: Memory | null;
  onClose: () => void;
  onSave: (draft: Partial<MemoryCreate> & { id?: string }) => void | Promise<void>;
}> = ({ initial, onClose, onSave }) => {
  const [kind, setKind] = useState<MemoryKind>(initial?.kind || 'fact');
  const [content, setContent] = useState(initial?.content || '');
  const [scope, setScope] = useState(initial?.scope || 'global');
  const [tagsRaw, setTagsRaw] = useState((initial?.tags || []).join(', '));
  const [pinned, setPinned] = useState(!!initial?.pinned);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!content.trim()) { toast({ title: '得写点内容', variant: 'destructive' }); return; }
    setSaving(true);
    const tags = tagsRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    await onSave({ id: initial?.id, kind, content: content.trim(), scope: scope.trim() || 'global', tags, pinned });
    setSaving(false);
  };

  return (
    <div style={s.formCard}>
      <div style={s.formHead}>
        <span>{initial ? '改这条 memory' : '新记一条 memory'}</span>
        <button type="button" onClick={onClose} style={s.formClose}>×</button>
      </div>

      <div style={s.formRow}>
        <div style={s.formLabel}>类型</div>
        <div style={s.kindPicker}>
          {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              style={{ ...s.kindChip, ...(kind === k ? s.kindChipOn : null) }}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      <div style={s.formRow}>
        <div style={s.formLabel}>内容</div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="一句话把这件事写清楚。"
          style={s.formTextarea}
        />
      </div>

      <div style={s.formGrid2}>
        <div>
          <div style={s.formLabel}>scope</div>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="global / agent:<id> / user:<id>"
            style={s.formInput}
          />
        </div>
        <div>
          <div style={s.formLabel}>tags (逗号分隔)</div>
          <input
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="例：chat, 个人偏好"
            style={s.formInput}
          />
        </div>
      </div>

      <div style={s.formRow}>
        <label style={s.checkboxRow}>
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>置顶 · 检索时永远在前面</span>
        </label>
      </div>

      <div style={s.formActions}>
        <PaperButton variant="ghost" size="small" onClick={onClose}>取消</PaperButton>
        <PaperButton size="small" onClick={submit} disabled={saving}>{saving ? '存…' : '存'}</PaperButton>
      </div>
    </div>
  );
};

/* ============================================================
   DOCUMENTS
   ============================================================ */

const DocumentsTab: React.FC = () => {
  const [items, setItems] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [ingesting, setIngesting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await smartnoteDocuments.list();
      setItems(data.documents || []);
    } catch (e: any) {
      setErr(e?.message || '');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: `"${file.name}" 太大`, description: '单个不超过 5 MB（文本）。', variant: 'destructive' });
      return;
    }
    if (!/\.(md|txt|html?|markdown)$/i.test(file.name) && !file.type.startsWith('text/')) {
      toast({ title: '只收 text', description: 'PDF/图片现在还没支持。先转成 .md/.txt 再上传。', variant: 'destructive' });
      return;
    }
    setUploading(true);
    try {
      const text = await file.text();
      const doc = await smartnoteDocuments.create({
        name: file.name,
        content: text,
        kind: /\.md|markdown/i.test(file.name) ? 'markdown' : 'text',
      });
      toast({ title: '已入库', description: `${doc.name} · ${Math.round(doc.byte_size / 1024)} KB` });
      setIngesting(doc.id);
      try {
        const r = await smartnoteDocuments.ingest(doc.id);
        toast({ title: '已切块', description: `${r.chunks} 段 memory`, variant: 'success' });
      } catch (e: any) {
        toast({ title: '切块失败', description: e?.message || '', variant: 'destructive' });
      } finally {
        setIngesting(null);
      }
      await load();
    } catch (e: any) {
      toast({ title: '上传失败', description: e?.message || '', variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const reingest = async (doc: Document) => {
    setIngesting(doc.id);
    try {
      const r = await smartnoteDocuments.ingest(doc.id);
      toast({ title: `重切了 ${r.chunks} 段`, variant: 'success' });
      await load();
    } catch (e: any) {
      toast({ title: '切块失败', description: e?.message || '', variant: 'destructive' });
    } finally {
      setIngesting(null);
    }
  };

  return (
    <>
      <div style={s.toolbar}>
        <div style={s.docNote}>
          只接 <code style={s.code}>.md</code> / <code style={s.code}>.txt</code> / html / 纯文本。PDF/图片需要先抽成文本（后面会加）。
        </div>
        <PaperButton size="small" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '上传中…' : '+ 塞一本'}
        </PaperButton>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,.html,text/plain,text/markdown,text/html"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>

      {err && <div style={s.errBox}>{err}</div>}
      {loading && items.length === 0 ? (
        <Loading text="正在翻书架…" />
      ) : items.length === 0 ? (
        <Empty title="书架空着" hint="点「+ 塞一本」上传 markdown/txt，Smartnote 会自动切块+embed 存成 memory。" />
      ) : (
        <div style={s.docGrid}>
          {items.map((d) => (
            <article key={d.id} style={s.docCard}>
              <span style={s.docTag}>{d.kind || 'text'}</span>
              <h3 style={s.docName}>{d.name}</h3>
              <div style={s.docMeta}>
                {Math.round(d.byte_size / 1024)} KB · {new Date(d.created_at).toLocaleDateString('zh-CN')}
              </div>
              <div style={s.docFoot}>
                {d.ingested_at ? (
                  <span style={s.docIngested}>✓ 已切块 · {new Date(d.ingested_at).toLocaleDateString('zh-CN')}</span>
                ) : (
                  <span style={s.docPending}>待切块</span>
                )}
                <PaperButton
                  variant="link"
                  size="small"
                  onClick={() => void reingest(d)}
                  disabled={ingesting === d.id}
                >
                  {ingesting === d.id ? '切…' : '重切'}
                </PaperButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
};

/* ============================================================
   SEARCH
   ============================================================ */

const SearchTab: React.FC = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RetrievedMemory[]>([]);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [kindSel, setKindSel] = useState<MemoryKind | ''>('');
  const [searched, setSearched] = useState('');

  const runSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const tags = tagsRaw.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const data = await smartnoteRetrieve({
        query,
        topk: 20,
        scope: scope.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        kinds: kindSel ? [kindSel] : undefined,
      });
      setResults(data.results || []);
      setSearched(query);
    } catch (e: any) {
      toast({ title: '搜不到', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void runSearch(); }
  };

  return (
    <>
      <div style={s.searchBox}>
        <div style={s.search}>
          <span style={s.searchIcon}>搜</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="一句话、一个关键词、一段话…"
            style={s.searchInput}
          />
          {searching && <span style={s.searchSpinner}>…</span>}
        </div>

        <div style={s.searchFilters}>
          <select value={kindSel} onChange={(e) => setKindSel(e.target.value as MemoryKind | '')} style={s.scopeInput}>
            <option value="">所有类型</option>
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="scope (留空=所有)"
            style={s.scopeInput}
          />
          <input
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="tags 逗号分隔"
            style={s.scopeInput}
          />
          <PaperButton size="small" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
            {searching ? '…' : '搜'}
          </PaperButton>
        </div>
      </div>

      {searched && results.length === 0 ? (
        <Empty title="没找到" hint={`换个说法试试。关键词「${searched}」${scope ? ` · scope ${scope}` : ''}${tagsRaw ? ` · tags ${tagsRaw}` : ''}`} />
      ) : searched && (
        <div>
          <div style={s.shelfLabel}>
            <span>搜到的</span>
            <span style={s.shelfCount}>{results.length} 条 · 「{searched}」</span>
            <span style={s.shelfLine} />
          </div>
          <div style={s.searchResults}>
            {results.map((r) => (
              <article key={r.id} style={s.memRow}>
                <div style={s.memMeta}>
                  <PaperChip tone={KIND_TONES[(r.kind as MemoryKind) || 'fact']}>{KIND_LABELS[(r.kind as MemoryKind) || 'fact']}</PaperChip>
                  {r.scope && r.scope !== 'global' && (<span style={s.memScope}>scope: {r.scope}</span>)}
                  {r.tags?.map((t) => (<span key={t} style={s.memTag}>#{t}</span>))}
                  {r.pinned && <span style={s.memPinned}>★</span>}
                  <span style={s.memDate}>{new Date(r.created_at).toLocaleDateString('zh-CN')}</span>
                  <span style={s.scoreBar} title={`vec ${r.vector_score.toFixed(2)} · lex ${r.lexical_score.toFixed(2)}`}>
                    {r.score.toFixed(2)}
                  </span>
                </div>
                <div style={s.memContent}>{r.content}</div>
              </article>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

/* ============================================================
   Bits
   ============================================================ */

const TabButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    style={{ ...s.tabBtn, ...(active ? s.tabBtnActive : null) }}
  >
    {children}
  </button>
);

const ConnDot: React.FC<{ state: string }> = ({ state }) => {
  const color =
    state === 'ok' ? 'var(--status-success)'
      : state === 'probing' ? 'var(--marginalia-ink)'
      : state === 'no-key' ? 'var(--pencil)'
      : 'var(--status-error)';
  return <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, marginRight: 6 }} aria-hidden />;
};

const Loading: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ textAlign: 'center', padding: '48px 0', fontFamily: "'Young Serif', serif", fontStyle: 'italic', color: 'var(--pencil)' }}>
    {text}
  </div>
);

const Empty: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div style={s.empty}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 36, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>·</div>
    <h3 style={s.emptyTitle}>{title}</h3>
    {hint && <p style={s.emptyHint}>{hint}</p>}
  </div>
);

const NoKeyState: React.FC = () => (
  <div style={s.downBox}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 36, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>🔑</div>
    <h3 style={s.emptyTitle}>先配一下 Smartnote API key</h3>
    <p style={s.emptyHint}>
      去「设置 · 高级」里填 API key 和 base URL，回来刷新就行。
    </p>
    <div style={{ marginTop: 16 }}>
      <PaperButton size="small" onClick={() => { window.location.hash = '#/settings'; }}>去设置 →</PaperButton>
    </div>
  </div>
);

const DownState: React.FC<{ error: string | null; onRetry: () => void | Promise<void> }> = ({ error, onRetry }) => (
  <div style={s.downBox}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 34, color: 'var(--status-error)', lineHeight: 1, marginBottom: 12 }}>…</div>
    <h3 style={s.emptyTitle}>连不上 Smartnote Cloud</h3>
    <p style={s.emptyHint}>
      {error ? (<>后端说：<em>{error}</em></>) : '无法建立连接。'}
      <br />看看「设置 · 高级」的 base URL 和 API key 对不对。
    </p>
    <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
      <PaperButton size="small" variant="ghost" onClick={() => void onRetry()}>再试一次</PaperButton>
      <PaperButton size="small" onClick={() => { window.location.hash = '#/settings'; }}>去设置 →</PaperButton>
    </div>
  </div>
);

/* ---------- styles ---------- */

const s: Record<string, React.CSSProperties> = {
  tabs: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    paddingBottom: 14,
    borderBottom: '1px solid var(--rule)',
    marginBottom: 22,
  },
  tabBtn: {
    background: 'transparent',
    border: 0,
    padding: '0 0 6px',
    fontFamily: "'Young Serif', serif",
    fontSize: 18,
    color: 'var(--pencil)',
    cursor: 'pointer',
    position: 'relative',
    letterSpacing: '0.01em',
  },
  tabBtnActive: {
    color: 'var(--ink-strong)',
    fontWeight: 500,
    borderBottom: '2px solid var(--accent-ink)',
  },
  tabSep: {
    color: 'var(--rule-strong)',
    fontFamily: "'Young Serif', serif",
    fontSize: 16,
  },

  toolbar: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 18,
  },
  filterChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  filterChip: {
    padding: '3px 10px',
    fontSize: 11.5,
    fontFamily: "'Young Serif', serif",
    color: 'var(--pencil)',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  filterChipOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  scopeInput: {
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '6px 10px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: 'var(--ink)',
    outline: 'none',
    minWidth: 180,
  },
  docNote: {
    flex: 1,
    minWidth: 260,
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 12.5,
    color: 'var(--pencil)',
  },
  code: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    background: 'var(--paper)',
    padding: '1px 6px',
    borderRadius: 2,
    border: '1px solid var(--rule)',
    fontStyle: 'normal',
  },

  errBox: {
    padding: '12px 14px',
    background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    color: 'oklch(0.40 0.130 25)',
    fontSize: 13,
    borderRadius: 2,
    marginBottom: 16,
    fontFamily: "'Young Serif', serif",
  },
  downBox: {
    padding: '56px 32px',
    textAlign: 'center',
    border: '2px dashed var(--rule-strong)',
    borderRadius: 4,
    color: 'var(--pencil)',
  },
  empty: {
    padding: '56px 32px',
    textAlign: 'center',
    border: '2px dashed var(--rule-strong)',
    borderRadius: 4,
    color: 'var(--pencil)',
  },
  emptyTitle: { fontFamily: "'Young Serif', serif", fontSize: 18, color: 'var(--ink-strong)', margin: 0 },
  emptyHint: {
    marginTop: 10, fontSize: 13, color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif", fontStyle: 'italic',
    maxWidth: '48ch', margin: '10px auto 0', lineHeight: 1.8,
  },

  /* Memory rows */
  memList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  memRow: {
    padding: '14px 14px',
    borderBottom: '1px dotted var(--rule)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  memMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  memScope: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.06em',
  },
  memTag: {
    fontFamily: "'Young Serif', serif",
    fontSize: 11.5,
    color: 'var(--marginalia-ink)',
    fontStyle: 'italic',
  },
  memPinned: {
    color: 'var(--accent-ink)',
    fontSize: 13,
  },
  memDate: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil-soft)',
    marginLeft: 'auto',
  },
  memActions: {
    display: 'flex',
    gap: 4,
    marginLeft: 6,
  },
  memIconBtn: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil)',
    cursor: 'pointer',
    fontSize: 11.5,
    fontFamily: "'Young Serif', serif",
    padding: '2px 6px',
    borderRadius: 2,
    letterSpacing: '0.04em',
  },
  memContent: {
    fontSize: 14,
    color: 'var(--ink)',
    lineHeight: 1.7,
    fontFamily: "'Young Serif', serif",
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },

  /* Form */
  formCard: {
    padding: '14px 16px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    background: 'var(--page-elev)',
    marginBottom: 16,
  },
  formHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--ink-strong)',
    marginBottom: 10,
  },
  formClose: {
    background: 'transparent', border: 0, cursor: 'pointer',
    fontSize: 18, lineHeight: 1, padding: '0 4px',
    color: 'var(--pencil)',
  },
  formRow: { marginBottom: 12 },
  formLabel: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  kindPicker: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  kindChip: {
    padding: '3px 10px',
    fontSize: 12,
    fontFamily: "'Young Serif', serif",
    color: 'var(--pencil)',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  kindChipOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  formTextarea: {
    width: '100%',
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '10px 12px',
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink)',
    lineHeight: 1.7,
    resize: 'vertical',
    outline: 'none',
    minHeight: 70,
  },
  formInput: {
    width: '100%',
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    padding: '6px 0',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12.5,
    color: 'var(--ink)',
    outline: 'none',
  },
  formGrid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
    marginBottom: 12,
  },
  checkboxRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink)',
    cursor: 'pointer',
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },

  /* Documents */
  docGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 14,
  },
  docCard: {
    position: 'relative',
    padding: '18px 16px 14px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    minHeight: 130,
  },
  docTag: {
    position: 'absolute',
    top: -1, right: 14,
    fontFamily: "'Young Serif', serif",
    fontSize: 10,
    color: 'var(--paper)',
    padding: '3px 8px 2px',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    borderRadius: '0 0 1px 1px',
    background: 'var(--accent-ink)',
  },
  docName: {
    fontFamily: "'Young Serif', serif",
    fontSize: 15,
    color: 'var(--ink-strong)',
    lineHeight: 1.3,
    margin: '10px 0 0',
    wordBreak: 'break-all',
  },
  docMeta: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil-soft)',
    marginTop: 6,
    letterSpacing: '0.04em',
  },
  docFoot: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: '1px dotted var(--rule-strong)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 11,
    color: 'var(--pencil-soft)',
    fontFamily: "'JetBrains Mono', monospace",
  },
  docIngested: { color: 'var(--status-success)' },
  docPending: { color: 'var(--marginalia-ink)' },

  /* Search */
  searchBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginBottom: 22,
  },
  search: { position: 'relative' },
  searchIcon: {
    position: 'absolute',
    left: 13, top: '50%', transform: 'translateY(-50%)',
    fontFamily: "'Young Serif', serif",
    fontSize: 13, color: 'var(--accent-ink)',
  },
  searchInput: {
    width: '100%',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '10px 14px 10px 36px',
    fontFamily: "'Commissioner', sans-serif",
    fontSize: 14, color: 'var(--ink)', outline: 'none',
  },
  searchSpinner: {
    position: 'absolute',
    right: 13, top: '50%', transform: 'translateY(-50%)',
    color: 'var(--pencil)',
  },
  searchFilters: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    alignItems: 'center',
  },

  shelfLabel: {
    fontFamily: "'Young Serif', serif",
    fontSize: 16,
    color: 'var(--ink-strong)',
    marginBottom: 14,
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    paddingBottom: 6,
    borderBottom: '1px solid var(--rule)',
  },
  shelfCount: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: 'var(--pencil)',
    letterSpacing: '0.08em',
  },
  shelfLine: { flex: 1 },
  searchResults: { display: 'flex', flexDirection: 'column' },
  scoreBar: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--accent-ink)',
    marginLeft: 'auto',
    background: 'var(--accent-soft)',
    padding: '1px 6px',
    borderRadius: 2,
    letterSpacing: '0.04em',
  },
};

export default KnowledgePage;
