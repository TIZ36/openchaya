import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  smartnoteProbe, smartnoteMemories, smartnoteDocuments, smartnoteTags,
  smartnoteChunks, smartnoteSearchHistory, smartnoteRetrieve,
  getSmartnoteApiKey, setSmartnoteApiKey,
  getSmartnoteBaseUrl, setSmartnoteBaseUrl,
  type Memory, type MemoryKind, type MemoryCreate, type MemoryPatch,
  type Document, type Tag, type RetrievedMemory,
  type ChunkSearchHit, type ChunkSource, type SearchHistoryItem,
} from '../services/smartnoteApi';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { kbAnswer } from '../services/kbApi';
import {
  isLocalNotesAvailable, listNotes, importNotes, newNoteFile,
  readNote as readLocalNote, writeNote as writeLocalNote,
  renameNote as renameLocalNote, deleteNote as deleteLocalNote,
  noteTitle, syncedDocId, mapSync, syncedDocIds,
  type LocalNoteFile,
} from './services/localNotes';
import { IconPin, IconEdit, IconTrash, IconDoc, IconPlus, IconSearch, IconModel, IconChevron, IconKB, IconCloud } from './icons';
import { NoteEditor, type NoteEditorHandle } from './kb/NoteEditor';
import { CodeBlock, PreBlock, mdRehypePlugins } from './codeBlock';

/** Shared markdown surface for note preview + AI answer. */
const MD_COMPONENTS = {
  a: ({ node: _n, ...p }: any) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  code: CodeBlock,
  pre: PreBlock,
} as React.ComponentProps<typeof ReactMarkdown>['components'];
const MD: React.FC<{ text: string }> = React.memo(({ text }) => (
  <div className="v2-md">
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={mdRehypePlugins} components={MD_COMPONENTS}>{text}</ReactMarkdown>
  </div>
));
MD.displayName = 'KbMD';

/** Domain swatch palette — kept aligned with the create modal choices. */
const DOMAIN_COLORS = ['#6e6e6e', '#c15f3c', '#c8923f', '#3a8a5c', '#3a6f9c', '#7a5cc2', '#b14a8a'];
export function domainColor(t?: Tag | null): string {
  const c = (t?.color || '').trim();
  return c && c.startsWith('#') ? c : '#6e6e6e';
}

/* ============================================================
   Knowledge (v2) — via Smartnote Cloud.
   两栏工作台：左资源树（知识域 → 笔记/文档 + 记忆入口）/ 右画布
   （总览 · 笔记编辑 · 文档只读 · 记忆）+ 顶部全局搜索浮层。
   ============================================================ */

type ConnState = 'probing' | 'ok' | 'no-key' | 'down';

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  procedure: '步骤',
  episode: '回忆',
  document_ref: '文档块',
};
const KIND_TONES: Record<MemoryKind, string> = {
  fact: 'mute',
  preference: 'ok',
  procedure: 'warn',
  episode: 'soft',
  document_ref: 'soft',
};

/** Read the user's default LLM config id from persisted settings — the
 *  search AI answer uses it; falls back to backend GetAny when absent. */
function readDefaultLLMConfigId(): string | undefined {
  try {
    const raw = localStorage.getItem('settings');
    if (!raw) return undefined;
    const s = JSON.parse(raw);
    return s?.defaultLLMConfigId || undefined;
  } catch { return undefined; }
}

/** 常驻笔记领域 —— 不可删、不需手动新建；新建笔记自动归入。 */
const NOTES_DOMAIN = '笔记';
const NOTES_DOMAIN_COLOR = '#c8923f';

/** What the right canvas is currently showing.
 *  note = 本地 .md 文件（path 为 id）；doc = 云端上传文档（cloud id）。 */
type Selection =
  | { kind: 'all' }
  | { kind: 'memories' }
  | { kind: 'note'; path: string }
  | { kind: 'doc'; id: string };

const KnowledgeView: React.FC = () => {
  const [conn, setConn] = useState<ConnState>('probing');
  const [connErr, setConnErr] = useState<string | null>(null);
  const llmConfigId = useMemo(() => readDefaultLLMConfigId(), []);

  const [domains, setDomains] = useState<Tag[]>([]);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [notes, setNotes] = useState<LocalNoteFile[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: 'all' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [domainModal, setDomainModal] = useState<Tag | 'new' | null>(null);
  const [createUnder, setCreateUnder] = useState<string | null | undefined>(undefined); // doc-upload modal; value = preset domain
  const [searchOpen, setSearchOpen] = useState(false);
  const localOk = isLocalNotesAvailable();

  const probe = useCallback(async () => {
    setConn('probing'); setConnErr(null);
    if (!getSmartnoteApiKey()) { setConn('no-key'); return; }
    try {
      const r = await smartnoteProbe();
      if (r.ok) setConn('ok');
      else { setConn('down'); setConnErr(r.error || '探测失败'); }
    } catch (e: any) { setConn('down'); setConnErr(e?.message || '探测失败'); }
  }, []);
  const loadDomains = useCallback(async () => {
    try {
      let list = await smartnoteTags.list() || [];
      // 确保常驻「笔记」域存在；缺失则补建一次（让 @笔记 在全局检索里也成立）。
      if (!list.some((t) => t.name === NOTES_DOMAIN)) {
        try { await smartnoteTags.upsert({ name: NOTES_DOMAIN, color: NOTES_DOMAIN_COLOR }); list = await smartnoteTags.list() || []; }
        catch { /* 补建失败不阻断：树里仍以常驻方式渲染 */ }
      }
      setDomains(list);
    } catch (e) { console.warn('[v2] tags.list', e); }
  }, []);
  const loadDocs = useCallback(async () => {
    try { const r = await smartnoteDocuments.list(); setDocs(r.documents || []); }
    catch { setDocs([]); }
  }, []);
  const loadNotes = useCallback(async () => {
    if (!localOk) { setNotes([]); return; }
    try { setNotes(await listNotes()); } catch { setNotes([]); }
  }, [localOk]);

  useEffect(() => { void probe(); }, [probe]);
  useEffect(() => { if (conn === 'ok') { void loadDomains(); void loadDocs(); } }, [conn, loadDomains, loadDocs]);
  useEffect(() => { void loadNotes(); }, [loadNotes]);
  // 笔记域默认展开（新建笔记落进这里，要立刻看得到）。
  useEffect(() => { setExpanded((p) => new Set(p).add(NOTES_DOMAIN)); }, []);

  // ⌘K focuses search · ⌘N new note · Esc closes search overlay · 双击 Shift 也开搜索
  useEffect(() => {
    let lastShift = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void addNote(); }
      else if (e.key === 'Escape' && searchOpen) setSearchOpen(false);
      else if (e.key === 'Shift' && !e.repeat) {
        const now = e.timeStamp || Date.now();
        if (now - lastShift < 400) { setSearchOpen(true); lastShift = 0; } else lastShift = now;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  const toggleExpand = (key: string) =>
    setExpanded((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // 新建笔记 = 保存对话框选位置（任意目录）→ 建空 .md → 平铺登记 → 打开。
  const addNote = useCallback(async () => {
    if (!localOk) { window.alert('本地笔记仅桌面版可用。'); return; }
    try {
      const p = await newNoteFile('未命名笔记.md');
      if (!p) return;
      setExpanded((s) => new Set(s).add(NOTES_DOMAIN));
      await loadNotes();
      setSel({ kind: 'note', path: p });
    } catch (e: any) { window.alert(e?.message || '创建失败'); }
  }, [localOk, loadNotes]);

  // 导入：从任意目录挑选已有的 .md/.txt 文件，平铺加入。
  const importNote = useCallback(async () => {
    if (!localOk) { window.alert('本地笔记仅桌面版可用。'); return; }
    try {
      const added = await importNotes();
      if (!added.length) return;
      setExpanded((s) => new Set(s).add(NOTES_DOMAIN));
      await loadNotes();
      setSel({ kind: 'note', path: added[0] });
    } catch (e: any) { window.alert(e?.message || '导入失败'); }
  }, [localOk, loadNotes]);

  // 哪些云端文档其实是「笔记」：本地同步的镜像 + 云端 kind:note —— 供搜索分组用。
  const noteDocIds = useMemo(() => {
    const s = syncedDocIds();
    for (const d of docs || []) if (d.kind === 'note') s.add(d.id);
    return s;
    // notes 变化（同步映射可能改动）也要重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, notes]);

  // 搜索结果回车 → 在工作区打开并关闭面板。命中镜像文档时优先打开对应本地笔记。
  const openFromSearch = useCallback((t: SearchOpenTarget) => {
    if (t.kind === 'memory') { setSel({ kind: 'memories' }); setSearchOpen(false); return; }
    const local = notes.find((n) => syncedDocId(n.path) === t.id);
    setSel(local ? { kind: 'note', path: local.path } : { kind: 'doc', id: t.id });
    setSearchOpen(false);
  }, [notes]);

  return (
    <div className="v2-view v2-kb-view">
      {/* ── 顶栏：全局搜索（占主） + 连接状态 ── */}
      <div className="v2-kb-top">
        <button className="v2-kb-searchbtn" onClick={() => setSearchOpen(true)} title="搜索全部内容 (⌘K · 双击 Shift)">
          <IconSearch /><span>搜索笔记、文档、记忆…</span><kbd>⌘K</kbd>
        </button>
        <KbConn state={conn} />
      </div>

      {conn === 'no-key' && <div className="v2-kb-body"><NoKey onSaved={probe} /></div>}
      {conn === 'down' && <div className="v2-kb-body"><Down err={connErr} onRetry={probe} /></div>}
      {conn === 'probing' && <div className="v2-kb-body"><KbEmpty title="连接中…" /></div>}

      {conn === 'ok' && (
        <div className="v2-kb-workspace">
          <KbTree
            domains={domains}
            docs={docs}
            notes={notes}
            localOk={localOk}
            sel={sel}
            expanded={expanded}
            onSelect={setSel}
            onToggle={toggleExpand}
            onNewDomain={() => setDomainModal('new')}
            onEditDomain={(t) => setDomainModal(t)}
            onUpload={(dom) => setCreateUnder(dom ?? null)}
            onAddNote={addNote}
            onImportNote={importNote}
          />
          <KbCanvas
            sel={sel}
            docs={docs}
            notes={notes}
            domains={domains}
            llmConfigId={llmConfigId}
            onDocsChanged={loadDocs}
            onNotesChanged={loadNotes}
            onSelect={setSel}
            onAddNote={addNote}
          />
        </div>
      )}

      {searchOpen && (
        <SearchOverlay domain={null} llmConfigId={llmConfigId} noteDocIds={noteDocIds} onOpen={openFromSearch} onClose={() => setSearchOpen(false)} />
      )}

      {createUnder !== undefined && (
        <DocumentCreateModal
          domain={createUnder}
          onClose={() => setCreateUnder(undefined)}
          onCreated={() => { setCreateUnder(undefined); void loadDocs(); }}
        />
      )}

      {domainModal && (
        <DomainEditModal
          tag={domainModal === 'new' ? null : domainModal}
          onClose={() => setDomainModal(null)}
          onSaved={async (_savedName, _removed) => { setDomainModal(null); await loadDomains(); await loadDocs(); }}
        />
      )}
    </div>
  );
};

/* ============ Left resource tree ============ */

const KbTree: React.FC<{
  domains: Tag[];
  docs: Document[] | null;
  notes: LocalNoteFile[];
  localOk: boolean;
  sel: Selection;
  expanded: Set<string>;
  onSelect: (s: Selection) => void;
  onToggle: (key: string) => void;
  onNewDomain: () => void;
  onEditDomain: (t: Tag) => void;
  onUpload: (domain?: string) => void;
  onAddNote: () => void;
  onImportNote: () => void;
}> = ({ domains, docs, notes, localOk, sel, expanded, onSelect, onToggle, onNewDomain, onEditDomain, onUpload, onAddNote, onImportNote }) => {
  // 云端文档按域分桶。包含上传文档 + 历史云端笔记（如「东方玄学」），但排除
  // 已是本地笔记镜像的云 note（避免与「笔记」组重复）。
  const mirrorIds = useMemo(() => syncedDocIds(), [notes]);
  const byDomain = useMemo(() => {
    const m = new Map<string, Document[]>();
    const push = (k: string, d: Document) => (m.get(k) ?? m.set(k, []).get(k)!).push(d);
    for (const d of docs || []) {
      if (mirrorIds.has(d.id)) continue;   // 本地镜像 → 不在云树重复
      const ds = docDomains(d).filter((x) => x !== NOTES_DOMAIN);  // 「笔记」域不在云树里出现
      if (ds.length === 0) { push('__none__', d); continue; }
      for (const name of ds) push(name, d);
    }
    return m;
  }, [docs, mirrorIds]);

  const others = domains.filter((t) => t.name !== NOTES_DOMAIN);
  // 各子域内文档按名字典序排列（zh-aware）。
  const restGroups: Array<{ key: string; tag: Tag | null; items: Document[] }> = [
    ...others.map((t) => ({ key: t.name, tag: t, items: (byDomain.get(t.name) || []).slice().sort(byDocName) })),
  ];
  const untagged = (byDomain.get('__none__') || []).slice().sort(byDocName);
  if (untagged.length) restGroups.push({ key: '__none__', tag: null, items: untagged });

  const docCount = (docs || []).filter((d) => !mirrorIds.has(d.id)).length;
  const noteCount = notes.length;

  const renderGroup = (g: { key: string; tag: Tag | null; items: Document[] }) => {
    const open = expanded.has(g.key);
    return (
      <div key={g.key} className="v2-kb-group">
        <div className="v2-kb-group-row" onClick={() => onToggle(g.key)}>
          <span className={`caret${open ? ' open' : ''}`}><IconChevron /></span>
          <span className="dot" style={{ background: g.tag ? domainColor(g.tag) : 'var(--c-ink-4)' }} />
          <span className="nm">{g.tag ? g.tag.name : '未归类'}</span>
          <span className="cnt">{g.items.length || ''}</span>
          {/* 未归类不可编辑；用户自建域有铅笔。 */}
          {g.tag && (
            <button className="row-act" title="编辑域" onClick={(e) => { e.stopPropagation(); onEditDomain(g.tag!); }}><IconEdit /></button>
          )}
        </div>
        {open && g.items.map((d) => (
          <button
            key={d.id}
            className={`v2-kb-node leaf${sel.kind === 'doc' && sel.id === d.id ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'doc', id: d.id })}
            title={d.name}
          >
            <span className="ic"><IconDoc /></span>
            <span className="nm">{d.name || '未命名'}</span>
          </button>
        ))}
        {open && g.items.length === 0 && <div className="v2-kb-node-empty">空</div>}
      </div>
    );
  };

  return (
    <aside className="v2-kb-tree">
      <div className="v2-kb-tree-scroll">
        {/* 笔记组置顶（在「全部」之上）—— 本地 .md 文件。导入/新建都是 icon 按钮；
            没有笔记时不可展开（无 caret、点头不展开）。 */}
        {(() => {
          const empty = notes.length === 0;
          const open = !empty && expanded.has(NOTES_DOMAIN);
          return (
        <div className="v2-kb-group v2-kb-group-notes">
          <div className="v2-kb-group-row" onClick={() => { if (!empty) onToggle(NOTES_DOMAIN); }}>
            <span className={`caret${open ? ' open' : ''}${empty ? ' hidden' : ''}`}>{!empty && <IconChevron />}</span>
            <span className="ic-lead" style={{ color: NOTES_DOMAIN_COLOR }}><IconEdit /></span>
            <span className="nm">笔记</span>
            <span className="cnt">{noteCount || ''}</span>
            {localOk && <button className="row-act" title="导入已有笔记文件" onClick={(e) => { e.stopPropagation(); onImportNote(); }}><IconDoc /></button>}
            {localOk && <button className="row-act" title="新建笔记" onClick={(e) => { e.stopPropagation(); onAddNote(); }}><IconPlus /></button>}
          </div>
          {open && notes.slice().sort(byNoteName).map((f) => (
            <button
              key={f.path}
              className={`v2-kb-node leaf${sel.kind === 'note' && sel.path === f.path ? ' active' : ''}`}
              onClick={() => onSelect({ kind: 'note', path: f.path })}
              title={f.path}
            >
              <span className="ic"><IconEdit /></span>
              <span className="nm">{noteTitle(f)}</span>
            </button>
          ))}
        </div>
          );
        })()}

        {/* 特殊入口 */}
        <button className={`v2-kb-node top${sel.kind === 'all' ? ' active' : ''}`} onClick={() => onSelect({ kind: 'all' })}>
          <span className="ic"><IconKB /></span><span className="nm">全部</span><span className="cnt">{docCount || ''}</span>
        </button>
        <button className={`v2-kb-node top${sel.kind === 'memories' ? ' active' : ''}`} onClick={() => onSelect({ kind: 'memories' })}>
          <span className="ic"><IconPin /></span><span className="nm">记忆</span>
        </button>

        <div className="v2-kb-tree-sec">
          <span>知识域</span>
          <button className="v2-kb-tree-add" title="新建知识域" onClick={onNewDomain}><IconPlus /></button>
        </div>

        {restGroups.length === 0 && <div className="v2-kb-tree-empty">还没有其它知识域</div>}
        {restGroups.map(renderGroup)}
      </div>

      <div className="v2-kb-tree-foot">
        <button className="v2-kb-tree-footbtn" onClick={() => onUpload(undefined)}><IconPlus /> 上传 wiki</button>
      </div>
    </aside>
  );
};

/** 文档名字典序（zh-aware）。 */
function byDocName(a: Document, b: Document): number {
  return (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
}
function byNoteName(a: LocalNoteFile, b: LocalNoteFile): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/* ============ Right canvas (router) ============ */

const KbCanvas: React.FC<{
  sel: Selection;
  docs: Document[] | null;
  notes: LocalNoteFile[];
  domains: Tag[];
  llmConfigId?: string;
  onDocsChanged: () => void | Promise<void>;
  onNotesChanged: () => void | Promise<void>;
  onSelect: (s: Selection) => void;
  onAddNote: () => void;
}> = ({ sel, docs, notes, domains, onDocsChanged, onNotesChanged, onSelect, onAddNote }) => {
  if (sel.kind === 'memories') return <div className="v2-kb-canvas pad"><MemoriesTab domain={null} /></div>;
  if (sel.kind === 'all') return <KbAllList docs={docs} notes={notes} onSelect={onSelect} onAddNote={onAddNote} />;
  if (sel.kind === 'note') {
    const f = notes.find((n) => n.path === sel.path);
    if (!f) return <div className="v2-kb-canvas"><KbEmpty title="未找到" hint="文件可能已被移动或删除。" /></div>;
    return <LocalNoteCanvas key={f.path} file={f} domains={domains} onChanged={onNotesChanged} onDeleted={() => onSelect({ kind: 'all' })} />;
  }
  // cloud doc
  const doc = (docs || []).find((d) => d.id === sel.id);
  if (!doc) return <div className="v2-kb-canvas"><KbEmpty title="未找到" hint="可能已被删除。" /></div>;
  return <DocCanvas key={doc.id} doc={doc} domains={domains} onChanged={onDocsChanged} onDeleted={() => onSelect({ kind: 'all' })} />;
};

/* ============ All-content flat list (默认落地页) —— 本地笔记 + 云端文档 ============ */

const KbAllList: React.FC<{ docs: Document[] | null; notes: LocalNoteFile[]; onSelect: (s: Selection) => void; onAddNote: () => void }> = ({ docs, notes, onSelect, onAddNote }) => {
  type Row = { key: string; name: string; ts: number; sel: Selection };
  const rows: Row[] = [
    ...notes.map((f) => ({ key: 'n:' + f.path, name: noteTitle(f), ts: f.mtimeMs, sel: { kind: 'note', path: f.path } as Selection })),
    ...(docs || []).filter((d) => !isNote(d)).map((d) => ({
      key: 'd:' + d.id, name: d.name || '未命名',
      ts: Date.parse(d.updated_at || d.created_at) || 0,
      sel: { kind: 'doc', id: d.id } as Selection,
    })),
  ].sort((a, b) => b.ts - a.ts);

  if (docs && rows.length === 0) {
    return (
      <div className="v2-kb-canvas">
        <div className="v2-kb-welcome">
          <h3>这里还空着</h3>
          <p>写下第一篇笔记，或上传一份文档开始构建你的知识库。</p>
          <button className="v2-set-btn primary" onClick={() => onAddNote()}><IconEdit /> 写第一篇笔记</button>
        </div>
      </div>
    );
  }
  return (
    <div className="v2-kb-canvas pad">
      {!docs ? <KbEmpty title="加载中…" /> : (
        <div className="v2-kb-ov-list">
          {rows.map((r) => (
            <button key={r.key} className="v2-kb-ov-item" onClick={() => onSelect(r.sel)}>
              <span className="ic">{r.sel.kind === 'note' ? <IconEdit /> : <IconDoc />}</span>
              <span className="nm">{r.name}</span>
              <span className="mt">{r.ts ? new Date(r.ts).toLocaleDateString('zh-CN') : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ============ Domain (knowledge area) create / edit ============ */

const DomainEditModal: React.FC<{
  tag: Tag | null;
  onClose: () => void;
  onSaved: (name: string | null, removed?: boolean) => void | Promise<void>;
}> = ({ tag, onClose, onSaved }) => {
  const [name, setName] = useState(tag?.name || '');
  const [desc, setDesc] = useState(tag?.description || '');
  const [color, setColor] = useState(domainColor(tag));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    const nm = name.trim();
    if (!nm) { window.alert('域名不能空'); return; }
    setBusy(true);
    try {
      await smartnoteTags.upsert({ name: nm, description: desc.trim(), color, sort_order: tag?.sort_order ?? 0 });
      await onSaved(nm);
    } catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!tag) return;
    if (!window.confirm(`删除知识域「${tag.name}」？\n\n域里的记忆/文档不会被删，只是去掉归属标签。`)) return;
    setBusy(true);
    try { await smartnoteTags.remove(tag.name); await onSaved(tag.name, true); }
    catch (e: any) { window.alert(e?.message || '删除失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tag ? '编辑知识域' : '新建知识域'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">别名（域名）</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：东方玄学" disabled={!!tag}
              title={tag ? '已存在的域名不能改（它是检索标识）；要改名请新建' : ''} />
            <div className="v2-modal-note">这个名字就是聊天里 <code>@{name.trim() || '域名'}</code> 调用时用的标识。</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">说明（可选）</div>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="这个域装什么" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">颜色</div>
            <div className="v2-kb-swatches">
              {DOMAIN_COLORS.map((c) => (
                <button key={c} className={`v2-kb-swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          {tag && <button className="v2-mbtn" style={{ color: 'var(--c-danger)', marginRight: 'auto' }} onClick={() => void remove()} disabled={busy}>删除</button>}
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Memories ============ */

const MemoriesTab: React.FC<{ domain: string | null }> = ({ domain }) => {
  const [list, setList] = useState<Memory[] | null>(null);
  const [kindFilter, setKindFilter] = useState<MemoryKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { limit: 200 };
      if (kindFilter !== 'all') params.kind = kindFilter;
      if (q.trim()) params.q = q.trim();
      if (domain) params.tag = domain; // scope to the active knowledge domain
      const res = await smartnoteMemories.list(params);
      setList(res.memories || []);
    } catch (e) {
      console.warn('[v2] memories.list', e);
      setList([]);
    } finally { setLoading(false); }
  }, [kindFilter, q, domain]);

  useEffect(() => { void load(); }, [load]);

  const onPin = async (m: Memory) => {
    try { await smartnoteMemories.update(m.id, { pinned: !m.pinned }); void load(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };
  const onDelete = async (m: Memory) => {
    if (!window.confirm(`删除这条记忆？\n\n${m.content.slice(0, 80)}…`)) return;
    try { await smartnoteMemories.remove(m.id); void load(); }
    catch (e: any) { window.alert(e?.message || '失败'); }
  };

  return (
    <>
      <div className="v2-kb-toolbar">
        <div className="v2-kb-filters">
          <button className={`v2-kb-pill${kindFilter === 'all' ? ' on' : ''}`} onClick={() => setKindFilter('all')}>全部</button>
          {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
            <button
              key={k}
              className={`v2-kb-pill${kindFilter === k ? ' on' : ''}`}
              onClick={() => setKindFilter(k)}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="v2-kb-search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="过滤记忆…（按 Enter 提交）" onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} />
        </div>
        <button className="v2-set-btn primary" onClick={() => setEditing('new')}>＋ 新记忆</button>
      </div>

      {loading && !list && <KbEmpty title="加载中…" />}
      {list && list.length === 0 && <KbEmpty title="还没有记忆" hint="点右上「＋ 新记忆」加一条，或在文档里 ingest。" />}
      {list && list.length > 0 && (
        <div className="v2-kb-list">
          {list.map((m) => (
            <MemoryRowMemo
              key={m.id}
              m={m}
              onPin={onPin}
              onEdit={setEditing as (m: Memory) => void}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {editing && (
        <MemoryEditModal
          memory={editing === 'new' ? null : editing}
          domain={editing === 'new' ? domain : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </>
  );
};

/** Row receives an `m` plus per-action callbacks that take `m` directly. The
 *  parent no longer creates `() => void onPin(m)` per render; identity stays
 *  stable across re-renders so React.memo actually skips the work for the
 *  98 rows that didn't change when one was pinned. */
interface MemoryRowProps {
  m: Memory;
  onPin: (m: Memory) => void;
  onEdit: (m: Memory) => void;
  onDelete: (m: Memory) => void;
}
const MemoryRow: React.FC<MemoryRowProps> = ({ m, onPin, onEdit, onDelete }) => (
  <div className={`v2-kb-card${m.pinned ? ' pinned' : ''}`}>
    <div className="hd">
      <span className={`v2-pill ${KIND_TONES[m.kind]}`}>{KIND_LABELS[m.kind]}</span>
      {m.scope && m.scope !== 'workspace' && <span className="v2-pill mute">scope: {m.scope}</span>}
      {m.tags?.slice(0, 3).map((t) => <span key={t} className="v2-pill mute">#{t}</span>)}
      {m.tags && m.tags.length > 3 && <span className="v2-pill mute" title={m.tags.slice(3).map((t) => `#${t}`).join(' ')}>+{m.tags.length - 3}</span>}
      <span className="grow" />
      <div className="acts">
        <button className={`iconbtn${m.pinned ? ' on' : ''}`} title={m.pinned ? '取消置顶' : '置顶'} onClick={() => onPin(m)}><IconPin filled={m.pinned} /></button>
        <button className="iconbtn" title="编辑" onClick={() => onEdit(m)}><IconEdit /></button>
        <button className="iconbtn danger" title="删除" onClick={() => onDelete(m)}><IconTrash /></button>
      </div>
    </div>
    <ExpandableBody text={m.content} lines={5} />
    <div className="ft">
      <span>{new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
      <span>by {m.author_agent || 'unknown'}</span>
    </div>
  </div>
);
const MemoryRowMemo = React.memo(MemoryRow);

const MemoryEditModal: React.FC<{
  memory: Memory | null;
  domain?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ memory, domain, onClose, onSaved }) => {
  const [kind, setKind] = useState<MemoryKind>(memory?.kind || 'fact');
  const [content, setContent] = useState(memory?.content || '');
  const [scope, setScope] = useState(memory?.scope || 'workspace');
  // New memory under a domain → seed its tag so it's retrievable via @domain.
  const [tagsStr, setTagsStr] = useState(
    (memory?.tags || (domain ? [domain] : [])).join(', '),
  );
  const [pinned, setPinned] = useState(!!memory?.pinned);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!content.trim()) { window.alert('内容不能空'); return; }
    setBusy(true);
    const tags = tagsStr.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    try {
      if (memory) {
        const patch: MemoryPatch = { content: content.trim(), scope, tags, pinned };
        await smartnoteMemories.update(memory.id, patch);
      } else {
        const body: MemoryCreate = { kind, content: content.trim(), scope, tags, pinned };
        await smartnoteMemories.create(body);
      }
      onSaved();
    } catch (e: any) {
      window.alert(e?.message || '保存失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{memory ? '编辑记忆' : '新记忆'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">类型</div>
            <div className="v2-options">
              {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                <div
                  key={k}
                  className={`v2-opt${kind === k ? ' active' : ''}`}
                  onClick={() => !memory && setKind(k)}
                  style={memory ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                  title={memory ? '已存的记忆不能改类型' : ''}
                >
                  <span>{KIND_LABELS[k]}</span><small>{k.toUpperCase()}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">内容</div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder="写下要记住的事实、偏好、步骤…" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">Scope</div>
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="workspace · agent:<id> · …" />
            <div className="v2-modal-note">默认 workspace（所有 agent 共享）；要私有化用 <code>agent:&lt;agentId&gt;</code></div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">标签</div>
            <input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} placeholder="用逗号或空格分隔" />
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">置顶</div><div className="sub">优先用于检索结果</div></div>
              <button className={`v2-switch${pinned ? ' on' : ''}`} onClick={() => setPinned(!pinned)}><span className="thumb" /></button>
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Documents ============ */

/** Read the domain list a document was filed under (metadata.domains[]). */
function docDomains(d: Document): string[] {
  const md: any = d.metadata || {};
  if (Array.isArray(md.domains)) return md.domains.map((x: any) => String(x));
  if (md.domain) return [String(md.domain)];
  return [];
}

/* ============ Doc canvas — read-only document view ============ */

const DocCanvas: React.FC<{
  doc: Document;
  domains: Tag[];
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
}> = ({ doc, domains, onChanged, onDeleted }) => {
  const [content, setContent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editDomains, setEditDomains] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    let alive = true;
    setContent(null); setConfirmDel(false);
    smartnoteDocuments.get(doc.id).then((d) => { if (alive) setContent(d.content || ''); }).catch(() => { if (alive) setContent(''); });
    return () => { alive = false; };
  }, [doc.id]);

  const onIngest = async () => {
    setBusy(true);
    try { const r = await smartnoteDocuments.ingest(doc.id); window.alert(`已切成 ${r.chunks} 块进库，可在搜索里检索。`); await onChanged(); }
    catch (e: any) { window.alert(e?.message || '入库失败'); }
    finally { setBusy(false); }
  };
  // 两步删除（Electron 禁用 window.confirm）。
  const onDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); window.setTimeout(() => setConfirmDel(false), 2600); return; }
    try { await smartnoteDocuments.remove(doc.id); await onChanged(); onDeleted(); }
    catch (e: any) { window.alert(e?.message || '删除失败'); }
  };

  return (
    <section className="v2-kb-canvas v2-doc-canvas">
      <div className="v2-note-toolbar">
        <span className="v2-note-title" title={doc.name}>{doc.name}</span>
        <span className="v2-pill mute">{formatBytes(doc.byte_size)}</span>
        {doc.ingested_at ? <span className="v2-pill ok">已切块</span> : <span className="v2-pill warn">待切块</span>}
        {docDomains(doc).map((dm) => <span key={dm} className="v2-pill soft">@{dm}</span>)}
        <span className="grow" />
        <button className="v2-kb-pill" onClick={() => setEditDomains(true)}>归属域</button>
        <button className="v2-kb-pill" disabled={busy} onClick={() => void onIngest()}>{busy ? '处理中…' : '入库'}</button>
        <button className={`v2-note-icon danger${confirmDel ? ' confirm' : ''}`} onClick={() => void onDelete()} title={confirmDel ? '再次点击确认删除' : '删除'}>
          {confirmDel ? '确认?' : <IconTrash />}
        </button>
      </div>
      <div className="v2-note-surface">
        {content === null ? <div className="v2-note-empty">打开中…</div> : (
          <div className="v2-note-preview"><MD text={content || '（空文档）'} /></div>
        )}
      </div>
      {editDomains && (
        <DocumentDomainsModal doc={doc} domains={domains} onClose={() => setEditDomains(false)} onSaved={() => { setEditDomains(false); void onChanged(); }} />
      )}
    </section>
  );
};

/** Assign/unassign knowledge domains on an existing document. Patching
 *  metadata.domains re-tags the doc's chunks in place (cloud-side), so an old
 *  already-ingested book becomes reachable via `@域` without re-chunking. */
const DocumentDomainsModal: React.FC<{
  doc: Document;
  domains: Tag[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ doc, domains, onClose, onSaved }) => {
  const [picked, setPicked] = useState<string[]>(docDomains(doc));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (name: string) =>
    setPicked((p) => p.includes(name) ? p.filter((x) => x !== name) : [...p, name]);

  const save = async () => {
    setBusy(true);
    try {
      // metadata REPLACES the stored object → merge, only overriding domains.
      const meta: Record<string, unknown> = { ...(doc.metadata || {}) };
      if (picked.length) meta.domains = picked; else delete meta.domains;
      delete (meta as any).domain; // collapse legacy single-domain field into domains
      await smartnoteDocuments.patch(doc.id, { metadata: meta });
      onSaved();
    } catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>配置知识域</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">文档</div>
            <div className="v2-modal-note" style={{ marginTop: 2 }}>{doc.name}</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">归属域（可多选）</div>
            {domains.length === 0 ? (
              <div className="v2-modal-note">还没有知识域。先在上方「＋ 域」新建一个。</div>
            ) : (
              <div className="v2-kb-domains" style={{ padding: 0, border: 'none' }}>
                {domains.map((d) => (
                  <button
                    key={d.name}
                    className={`v2-kb-dom${picked.includes(d.name) ? ' on' : ''}`}
                    onClick={() => toggle(d.name)}
                  >
                    <span className="dot" style={{ background: domainColor(d) }} />{d.name}
                  </button>
                ))}
              </div>
            )}
            <div className="v2-modal-note">
              {doc.ingested_at
                ? <>保存后，已切块的内容会即时重新打上所选域标签，<code>@域</code> 立即可检索到——无需重新切块。</>
                : <>这份文档还没切块。配置好域后点「切块入库」，切出的块会带上所选域标签。</>}
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

const DocumentCreateModal: React.FC<{ domain: string | null; onClose: () => void; onCreated: () => void }> = ({ domain, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPickFile = async (file: File) => {
    if (!name.trim()) setName(file.name);
    const txt = await file.text();
    setContent(txt);
  };

  const save = async () => {
    if (!name.trim() || !content.trim()) { window.alert('名字和内容都要填'); return; }
    setBusy(true);
    try {
      await smartnoteDocuments.create({
        name: name.trim(),
        content: content.trim(),
        // Filed under the active domain → ingest stamps the chunks with this
        // tag (patched cloud), so @domain retrieval reaches the book content.
        metadata: domain ? { domains: [domain] } : undefined,
      });
      onCreated();
    } catch (e: any) { window.alert(e?.message || '失败'); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>上传 wiki</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">名字</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：产品介绍.md" />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>正文</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => fileRef.current?.click()}>从文件读…</button>
              <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.text,.rst,.org,.html" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); e.target.value = ''; }} />
            </div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} placeholder="贴文本或从文件读…" />
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>取消</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Notes — full open / create / edit / delete ============
   Notes are cloud documents with kind:'note'. Left list + right CM6 editor
   with live markdown preview toggle. Autosave on edit; re-ingest to index
   for search. Domain-scoped: new notes stamp metadata.domains=[domain]. */

function isNote(d: Document): boolean {
  const md = (d.metadata && typeof d.metadata === 'object' ? d.metadata : {}) as Record<string, unknown>;
  return (d.kind === 'note') || (md.smartnote_type === 'note');
}

/* ============ Local note canvas — 本地 .md 文件编辑 + 同步到 sncloud ============
   读写本地文件；保存写盘（本地为主）。「同步」把内容镜像成云端 document（kind:note）
   并切块入库，使其可被搜索/@检索。本地路径 ↔ 云 docId 映射存 localStorage，避免重复。 */

const LocalNoteCanvas: React.FC<{
  file: LocalNoteFile;
  domains: Tag[];
  onChanged: () => void | Promise<void>;
  onDeleted: () => void;
}> = ({ file, onChanged, onDeleted }) => {
  const [content, setContent] = useState<string>('');
  const [title, setTitle] = useState<string>(noteTitle(file));
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<boolean>(!!syncedDocId(file.path));
  const [preview, setPreview] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const editorRef = useRef<NoteEditorHandle | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setPreview(false); setDirty(false); setTitle(noteTitle(file)); setRenaming(false); setConfirmDel(false);
    setSynced(!!syncedDocId(file.path));
    readLocalNote(file.path).then((c) => {
      if (!alive) return;
      setContent(c); editorRef.current?.setContent(c); setLoading(false);
      setTimeout(() => editorRef.current?.focus(), 30);
    }).catch((e) => { if (alive) { window.alert(e?.message || '打开失败'); setLoading(false); } });
    return () => { alive = false; };
  }, [file.path]);

  // 保存 = 写本地文件。
  const doSave = useCallback(async (body: string) => {
    setSaving(true);
    try { await writeLocalNote(file.path, body); setDirty(false); }
    catch (e: any) { window.alert(e?.message || '保存失败'); }
    finally { setSaving(false); }
  }, [file.path]);

  // 内联改名 = 重命名文件。
  const commitRename = async (name: string) => {
    setRenaming(false);
    const v = name.trim();
    if (!v || v === title) return;
    try { await renameLocalNote(file.path, v); setTitle(v); await onChanged(); }
    catch (e: any) { window.alert(e?.message || '改名失败'); }
  };
  // 两步删除（删本地文件，进回收站）。
  const onDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); window.setTimeout(() => setConfirmDel(false), 2600); return; }
    try { await deleteLocalNote(file.path); await onChanged(); onDeleted(); }
    catch (e: any) { window.alert(e?.message || '删除失败'); }
  };

  // 同步到 sncloud：先存盘 → create/patch 云 document(kind:note) → 切块入库 → 记映射。
  const onSync = async () => {
    setSyncing(true);
    try {
      const body = editorRef.current ? editorRef.current.getContent() : content;
      await writeLocalNote(file.path, body); setDirty(false);
      const existing = syncedDocId(file.path);
      let docId = existing;
      if (existing) {
        await smartnoteDocuments.patch(existing, { name: title, content: body });
      } else {
        const d = await smartnoteDocuments.create({
          name: title, content: body, kind: 'note',
          metadata: { domains: [NOTES_DOMAIN], source_path: file.path },
        });
        docId = d.id; mapSync(file.path, d.id);
      }
      if (docId) { try { await smartnoteDocuments.ingest(docId); } catch { /* ingest 失败不阻断 */ } }
      setSynced(true);
      window.alert('已同步到 Smartnote 云并入库，可在搜索里检索。');
    } catch (e: any) { window.alert(e?.message || '同步失败'); }
    finally { setSyncing(false); }
  };

  return (
    <section className="v2-kb-canvas v2-note-edit">
      <div className="v2-note-toolbar">
        {renaming ? (
          <input
            className="v2-note-title-input"
            defaultValue={title}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename((e.target as HTMLInputElement).value); }
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => void commitRename(e.target.value)}
          />
        ) : (
          <button className="v2-note-title" onClick={() => setRenaming(true)} title="点击重命名">{title || '未命名'}</button>
        )}
        <span className="v2-note-status">{saving ? '保存中…' : dirty ? '● 未保存' : '已保存（本地）'}</span>
        <span className={`v2-pill ${synced ? 'ok' : 'mute'}`}>{synced ? '已同步' : '未同步'}</span>
        <span className="grow" />
        <button
          className={`v2-kb-pill${preview ? ' on' : ''}`}
          onClick={() => {
            if (!preview && editorRef.current) setContent(editorRef.current.getContent());
            setPreview((v) => !v);
          }}
        >{preview ? '编辑' : '预览'}</button>
        <button className="v2-kb-pill" disabled={syncing} onClick={() => void onSync()} title="同步到 Smartnote 云并入库（可搜索/@检索）">
          {syncing ? '同步中…' : '同步'}
        </button>
        <button className={`v2-note-icon danger${confirmDel ? ' confirm' : ''}`} onClick={() => void onDelete()} title={confirmDel ? '再次点击确认删除' : '删除'}>
          {confirmDel ? '确认?' : <IconTrash />}
        </button>
      </div>
      <div className="v2-note-surface">
        {loading ? <div className="v2-note-empty">打开中…</div> : preview ? (
          <div className="v2-note-preview"><MD text={content} /></div>
        ) : (
          <NoteEditor ref={editorRef} initial={content} onSave={(body) => void doSave(body)} onDirty={setDirty} />
        )}
      </div>
    </section>
  );
};

/* ============ Search — 6-path chunk search + AI answer ============ */

interface AnswerState { loading: boolean; text: string; error?: string }

/** 一条统一搜索结果：文档/笔记块命中（chunk）或记忆命中（mem）。 */
type SearchHit =
  | { type: 'note' | 'doc'; id: string; chunk: ChunkSearchHit }
  | { type: 'memory'; id: string; mem: RetrievedMemory };

/** What Enter opens in the workspace behind the palette. */
export type SearchOpenTarget = { kind: 'doc'; id: string } | { kind: 'memory' };

const GROUP_LABEL: Record<SearchHit['type'], string> = { note: '笔记', doc: '文档', memory: '记忆' };

/** 命令面板式知识库搜索。
 *  · 输入即搜（250ms 防抖 + 请求序号防竞态）笔记/文档/记忆三源并行
 *  · 单列结果分组 + ↑↓ 键盘选择，右侧实时预览选中项来源
 *  · ↵ 打开并跳转、⌘↵ 让 LLM 生成带引用的答案、esc 关闭（由外层处理） */
const SearchTab: React.FC<{
  domain: string | null;
  llmConfigId?: string;
  noteDocIds: Set<string>;
  onOpen: (t: SearchOpenTarget) => void;
}> = ({ domain, llmConfigId, noteDocIds, onOpen }) => {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ vectorOk?: boolean } | null>(null);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState<ChunkSource | null>(null);
  const [answer, setAnswer] = useState<AnswerState | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const reqRef = useRef(0);
  const previewReqRef = useRef(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const loadHistory = useCallback(async () => {
    try { setHistory((await smartnoteSearchHistory.list(8)) || []); } catch { /* */ }
  }, []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // 输入即搜：防抖 250ms，请求序号丢弃过期响应。三源并行后按 笔记→文档→记忆 排列。
  useEffect(() => {
    const text = q.trim();
    if (!text) {
      reqRef.current++; setHits(null); setBusy(false);
      setAnswer(null); setSearchError(null); setInfo(null); setPreview(null);
      return;
    }
    setBusy(true); setSearchError(null);
    const id = ++reqRef.current;
    const timer = window.setTimeout(async () => {
      try {
        const [c, m] = await Promise.all([
          smartnoteChunks.search(text, { topk: 30, dimension: domain ? `wiki:${domain}` : undefined }),
          smartnoteRetrieve({ query: text, topk: 8, tags: domain ? [domain] : undefined })
            .catch(() => ({ results: [] as RetrievedMemory[], query_embedded: false })),
        ]);
        if (id !== reqRef.current) return;
        const notes: SearchHit[] = []; const docs: SearchHit[] = [];
        for (const h of (c.results || [])) {
          const hit: SearchHit = { type: noteDocIds.has(h.document_id) ? 'note' : 'doc', id: h.id, chunk: h };
          (hit.type === 'note' ? notes : docs).push(hit);
        }
        const mems: SearchHit[] = (m.results || []).map((mm) => ({ type: 'memory', id: mm.id, mem: mm }));
        setHits([...notes, ...docs, ...mems]);
        setInfo({ vectorOk: c.query_embedded });
        setSel(0); setAnswer(null);
        void loadHistory();
      } catch (e: any) {
        if (id !== reqRef.current) return;
        setSearchError(e?.message || '检索失败，请稍后再试。'); setHits([]);
      } finally {
        if (id === reqRef.current) setBusy(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, domain, noteDocIds, loadHistory]);

  const selected = hits && hits.length ? hits[Math.min(sel, hits.length - 1)] : null;

  // 选中项 → 右侧预览：chunk 拉取来源行窗口；记忆直接展示内容（序号防竞态）。
  useEffect(() => {
    if (!selected || selected.type === 'memory') { setPreview(null); return; }
    const id = ++previewReqRef.current;
    setPreview(null);
    smartnoteChunks.source(selected.chunk.id, 6)
      .then((src) => { if (id === previewReqRef.current) setPreview(src); })
      .catch(() => { /* */ });
  }, [selected?.id, selected?.type]);

  // 键盘选中项滚入可视区。
  useEffect(() => { itemRefs.current[sel]?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const openAt = useCallback((i: number) => {
    const h = hits?.[i];
    if (!h) return;
    if (h.type === 'memory') onOpen({ kind: 'memory' });
    else onOpen({ kind: 'doc', id: h.chunk.document_id });
  }, [hits, onOpen]);

  const runAI = useCallback(async () => {
    const text = q.trim();
    const chunks = (hits || []).filter((h): h is Extract<SearchHit, { type: 'note' | 'doc' }> => h.type !== 'memory');
    if (!text || !chunks.length) return;
    setAnswer({ loading: true, text: '' });
    const top = chunks.slice(0, 8).map((h, i) => ({ n: i + 1, document_name: h.chunk.document_name, text: h.chunk.text }));
    try {
      const ans = await kbAnswer(text, top, llmConfigId);
      setAnswer({ loading: false, text: ans });
    } catch (e: any) {
      setAnswer({ loading: false, text: '', error: e?.message || 'AI 回答失败' });
    }
  }, [q, hits, llmConfigId]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (hits?.length) setSel((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (hits?.length) setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) void runAI();
      else if (selected) openAt(Math.min(sel, (hits?.length || 1) - 1));
    }
  };

  // 渲染分组：按 hits 顺序切段（笔记/文档/记忆），保留全局索引用于键盘高亮。
  const groups = useMemo(() => {
    if (!hits) return [];
    const out: Array<{ label: string; items: Array<{ hit: SearchHit; idx: number }> }> = [];
    let cur: { label: string; items: Array<{ hit: SearchHit; idx: number }> } | null = null;
    hits.forEach((hit, idx) => {
      const label = GROUP_LABEL[hit.type];
      if (!cur || cur.label !== label) { cur = { label, items: [] }; out.push(cur); }
      cur.items.push({ hit, idx });
    });
    return out;
  }, [hits]);

  return (
    <div className="v2-cmdk">
      <div className="v2-cmdk-bar">
        <IconSearch />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="搜索笔记、文档、记忆…"
          aria-label="搜索知识库内容"
          autoFocus
        />
        {busy && <span className="v2-cmdk-spin" aria-label="检索中" />}
      </div>

      {searchError && <div className="v2-kb-warn v2-cmdk-error">{searchError}</div>}

      <div className="v2-cmdk-body">
        <div className="v2-cmdk-list">
          {!hits && !busy && (
            history.length > 0 ? (
              <div className="v2-cmdk-recent">
                <div className="v2-cmdk-secthd">最近搜索</div>
                {history.map((h) => (
                  <button key={h.id} className="v2-cmdk-recent-item" onClick={() => setQ(h.query_text)}>
                    <IconSearch />
                    <span className="q">{h.query_text}</span>
                    <span className="n">{h.result_count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <KbEmpty title="搜索知识库" hint="输入即搜笔记、文档与记忆。文档需先「入库」才可被检索。" />
            )
          )}

          {hits && hits.length === 0 && !busy && <KbEmpty title="没有匹配" hint="换个词，或确认文档已入库。" />}

          {groups.map((g) => (
            <div key={g.label} className="v2-cmdk-group">
              <div className="v2-cmdk-secthd">{g.label} <span className="cnt">{g.items.length}</span></div>
              {g.items.map(({ hit, idx }) => (
                <button
                  key={hit.id}
                  ref={(el) => { itemRefs.current[idx] = el; }}
                  className={`v2-cmdk-item${idx === sel ? ' sel' : ''}`}
                  onMouseMove={() => { if (idx !== sel) setSel(idx); }}
                  onClick={() => { setSel(idx); openAt(idx); }}
                >
                  <span className={`tk tk-${hit.type}`} aria-hidden>
                    {hit.type === 'memory' ? <IconModel /> : hit.type === 'note' ? <IconDoc /> : <IconKB />}
                  </span>
                  <span className="main">
                    <span className="snippet">
                      {hit.type === 'memory'
                        ? (hit.mem.content.length > 160 ? hit.mem.content.slice(0, 160) + '…' : hit.mem.content)
                        : (hit.chunk.text.length > 160 ? hit.chunk.text.slice(0, 160) + '…' : hit.chunk.text)}
                    </span>
                    <span className="sub">
                      {hit.type === 'memory'
                        ? <span className="src">{hit.mem.kind || '记忆'}</span>
                        : <span className="src">{hit.chunk.document_name}</span>}
                      <span className="sc">{(hit.type === 'memory' ? hit.mem.score : hit.chunk.score).toFixed(2)}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <aside className="v2-cmdk-preview">
          {answer ? (
            <div className="v2-cmdk-answer">
              <div className="v2-cmdk-secthd answer-hd"><IconModel /> AI 回答
                <button className="v2-cmdk-answer-x" onClick={() => setAnswer(null)} title="关闭">✕</button>
              </div>
              {answer.loading && <div className="v2-cmdk-answer-loading">生成中…</div>}
              {answer.error && <div className="v2-kb-warn">{answer.error}</div>}
              {!answer.loading && answer.text && <div className="v2-cmdk-answer-body"><MD text={answer.text} /></div>}
            </div>
          ) : selected?.type === 'memory' ? (
            <div className="v2-cmdk-prev-mem">
              <div className="v2-cmdk-prev-hd"><span className="src">{selected.mem.kind || '记忆'}</span></div>
              <div className="v2-cmdk-prev-mem-body">{selected.mem.content}</div>
              {selected.mem.tags?.length > 0 && (
                <div className="v2-cmdk-prev-tags">{selected.mem.tags.map((t) => <span key={t}>{t}</span>)}</div>
              )}
            </div>
          ) : selected && preview ? (
            <>
              <div className="v2-cmdk-prev-hd"><span className="src">{preview.document_name}</span><span className="ln">L{preview.line_start}–{preview.line_end}</span></div>
              <pre className="v2-cmdk-prev-body">
                {preview.lines.map((l) => (
                  <div key={l.line} className={`ln${l.highlight ? ' hl' : ''}`}>
                    <span className="no">{l.line}</span>{l.text}
                  </div>
                ))}
              </pre>
            </>
          ) : (
            <div className="v2-cmdk-prev-empty">
              {info && info.vectorOk === false
                ? '向量检索不可用，已回退到关键词。'
                : hits === null ? '输入关键词开始搜索' : '选择一项查看来源'}
            </div>
          )}
        </aside>
      </div>

      <div className="v2-cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>⌘</kbd><kbd>↵</kbd> AI 回答</span>
        <span><kbd>esc</kbd> 关闭</span>
      </div>
    </div>
  );
};

/** Search overlay — slides over the workspace; Esc / mask click closes.
 *  Reuses SearchTab as the inner surface (own bar + results + preview + AI). */
const SearchOverlay: React.FC<{
  domain: string | null;
  llmConfigId?: string;
  noteDocIds: Set<string>;
  onOpen: (t: SearchOpenTarget) => void;
  onClose: () => void;
}> = ({ domain, llmConfigId, noteDocIds, onOpen, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2-kb-search-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-kb-search-panel v2-cmdk-panel" role="dialog" aria-modal="true" aria-labelledby="kb-search-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="kb-search-title" className="v2-sr-only">知识库搜索</h2>
        <SearchTab domain={domain} llmConfigId={llmConfigId} noteDocIds={noteDocIds} onOpen={onOpen} />
      </div>
    </div>
  );
};

/* ============ small bits ============ */

/** Card body that clamps long text to `lines`, fading the cut, and reveals an
 *  inline 展开/收起 only when the content actually overflows. Cards grow to fit
 *  short content, so nothing is hard-cut or pushed past the viewport. */
const ExpandableBody: React.FC<{ text: string; lines?: number }> = ({ text, lines = 5 }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return; // while expanded keep the toggle; remeasure on collapse
    const check = () => setOverflowing(el.scrollHeight - el.clientHeight > 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  const clamped = !expanded;
  return (
    <>
      <div
        className={`v2-kb-body-wrap${clamped ? ' clamped' : ''}${clamped && overflowing ? ' has-more' : ''}`}
        style={{ ['--kb-clamp' as any]: lines }}
      >
        <div ref={ref} className="body">{text}</div>
      </div>
      {overflowing && (
        <button className="v2-kb-expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  );
};

/** Smartnote Cloud 连接状态 —— cloud 图标 + 名称 + 状态文字 + 色点，一眼可读。
 *  tone 类驱动配色（ok 绿 / probing 琥珀 / down 红 / no-key 中性）。 */
const KbConn: React.FC<{ state: ConnState }> = ({ state }) => {
  const tone = state === 'ok' ? 'ok' : state === 'probing' ? 'probing' : state === 'no-key' ? 'nokey' : 'down';
  const label =
    state === 'ok' ? '已连接' :
    state === 'probing' ? '连接中…' :
    state === 'no-key' ? '未配置' : '不可达';
  return (
    <span className={`v2-kb-conn tone-${tone}`} title={`Smartnote 云 · ${label}`}>
      <IconCloud />
      <span className="svc">Smartnote 云</span>
      <span className="dot" />
      <span className="st">{label}</span>
    </span>
  );
};

const KbEmpty: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="v2-kb-empty">
    <div className="t">{title}</div>
    {hint && <div className="h">{hint}</div>}
  </div>
);

const NoKey: React.FC<{ onSaved: () => void | Promise<void> }> = ({ onSaved }) => {
  const [key, setKey] = useState(getSmartnoteApiKey());
  const [base, setBase] = useState(getSmartnoteBaseUrl());
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim()) return;
    setBusy(true);
    setSmartnoteBaseUrl(base.trim());
    setSmartnoteApiKey(key.trim());
    try { await onSaved(); } finally { setBusy(false); }
  };
  return (
    <div className="v2-kb-empty" style={{ paddingTop: 40 }}>
      <div className="t">配置 Smartnote 凭据</div>
      <div className="h">把你的 API Key 填进去，知识库 / 记忆 / RAG 就都能用了。</div>
      <div style={{ maxWidth: 420, margin: '24px auto 0', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--c-ink-3)', marginBottom: 4 }}>API Key</div>
          <input
            type="password" value={key} onChange={(e) => setKey(e.target.value)}
            placeholder="sn_…"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--c-surface)', fontSize: 14, border: '1px solid var(--c-rule)' }}
          />
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--c-ink-3)', marginBottom: 4 }}>Base URL <span style={{ color: 'var(--c-ink-4)' }}>(留空用默认)</span></div>
          <input
            value={base} onChange={(e) => setBase(e.target.value)}
            placeholder="https://api.smartnote.cloud"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 10, background: 'var(--c-surface)', fontSize: 14, border: '1px solid var(--c-rule)' }}
          />
        </div>
        <button
          className="v2-set-btn primary"
          onClick={() => void save()}
          disabled={busy || !key.trim()}
          style={{ marginTop: 6 }}
        >{busy ? '验证中…' : '保存并连接'}</button>
        <div style={{ fontSize: 12, color: 'var(--c-ink-4)', textAlign: 'center', marginTop: 4 }}>
          也能在 设置 · 知识/RAG 里改。
        </div>
      </div>
    </div>
  );
};

const Down: React.FC<{ err: string | null; onRetry: () => void | Promise<void> }> = ({ err, onRetry }) => (
  <div className="v2-kb-empty">
    <div className="t">Smartnote 不可达</div>
    <div className="h">{err || '连不上知识库服务。'}</div>
    <div style={{ marginTop: 12 }}>
      <button className="v2-set-btn primary" onClick={() => void onRetry()}>重试</button>
    </div>
  </div>
);

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default KnowledgeView;
