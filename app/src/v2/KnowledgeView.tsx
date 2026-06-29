import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  defaultNote, getDefaultNotePath, associateDefaultNote, saveDefaultNoteAs, resetDefaultNoteLocation,
  type LocalNoteFile,
} from './services/localNotes';
import { IconPin, IconEdit, IconTrash, IconDoc, IconPlus, IconSearch, IconModel, IconKB, IconCloud, IconEye, IconSync, IconGear } from './icons';
import { NoteEditor, type NoteEditorHandle } from './kb/NoteEditor';
import { CodeBlock, PreBlock, mdRehypePlugins } from './codeBlock';
import { useI18n } from '../i18n';

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

/** Peek（浏览浮层）当前列出的范围。
 *  all=全部 · local=本地笔记 · cloud=云端文档 · domains=知识域管理 · {dom}=某域内文档。 */
type PeekFilter = 'all' | 'local' | 'cloud' | 'memories' | 'domains' | { dom: string };
const samePeekFilter = (a: PeekFilter, b: PeekFilter): boolean =>
  typeof a === 'object' || typeof b === 'object'
    ? typeof a === 'object' && typeof b === 'object' && a.dom === b.dom
    : a === b;

/** 账号入口信息 —— 由 ClientShell 注入，供 KB rail 底部显示账号/设置（侧栏对 kb 收起后
 *  这是 KB 里唯一的账号入口）。null = 不在 app 容器内（如独立预览），不渲染。 */
export interface KbAccount {
  authed: boolean;
  name: string;
  initials: string;
  online: boolean;     // WS 已连接
  onOpen: () => void;  // authed → 设置；游客 → 登录
}
export const KbAccountContext = createContext<KbAccount | null>(null);

/** 停靠列表栏的开合状态 —— 由 ClientShell 持有，使顶栏右上角的折叠按钮（侧栏对 kb
 *  收起后本无作用）能复用为「展开/收起 KB 列表栏」。null = 分屏窗格自管本地状态。 */
export interface KbList { open: boolean; setOpen: (v: boolean | ((p: boolean) => boolean)) => void; }
export const KbListContext = createContext<KbList | null>(null);

// Focus 布局自包含（rail + canvas + peek，都在本视图内），不再 portal 树进主侧栏，
// 故 standalone（分屏 wiki 窗格）与主 KB nav 走同一套布局；standalone 仅作 data 标记。
const KnowledgeView: React.FC<{ standalone?: boolean }> = ({ standalone }) => {
  const { t: tr } = useI18n();
  const [conn, setConn] = useState<ConnState>('probing');
  const [connErr, setConnErr] = useState<string | null>(null);
  const llmConfigId = useMemo(() => readDefaultLLMConfigId(), []);

  const [domains, setDomains] = useState<Tag[]>([]);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [notes, setNotes] = useState<LocalNoteFile[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: 'all' });
  const [domainModal, setDomainModal] = useState<Tag | 'new' | null>(null);
  const [createUnder, setCreateUnder] = useState<string | null | undefined>(undefined); // doc-upload modal; value = preset domain
  const [searchOpen, setSearchOpen] = useState(false);
  const localOk = isLocalNotesAvailable();
  // Focus 布局：60px 图标栏 + 单文档画布 + Peek 浏览浮层（全部自包含在本视图内，
  // 不再 portal 树进主侧栏）。peek.open 时从栏缘滑出密集列表；filter 决定列出范围。
  // 列表栏「开/合」状态：主 KB 走 ClientShell 注入的 KbListContext（让顶栏右上角折叠
  // 按钮也能驱动）；分屏 wiki 窗格无 provider，退回本地状态自管。filter（看哪类）始终本地。
  const kbList = useContext(KbListContext);
  const [filter, setFilter] = useState<PeekFilter>('all');
  const [standaloneOpen, setStandaloneOpen] = useState(true);   // 默认展开左树（CLI 风格常驻两栏）
  const listOpen = standalone ? standaloneOpen : (kbList?.open ?? false);
  const setListOpen = useCallback((v: boolean) => {
    if (standalone) setStandaloneOpen(v); else kbList?.setOpen(v);
  }, [standalone, kbList]);
  const peek = useMemo(() => ({ open: listOpen, filter }), [listOpen, filter]);
  // 点 rail 类目 = 切换停靠列表：同 filter 已开 → 收起；否则展开/换 filter。
  const togglePeek = useCallback((f: PeekFilter) => {
    if (listOpen && samePeekFilter(filter, f)) setListOpen(false);
    else { setFilter(f); setListOpen(true); }
  }, [listOpen, filter, setListOpen]);
  const setPeekFilter = useCallback((f: PeekFilter) => { setFilter(f); setListOpen(true); }, [setListOpen]);
  // 记忆筛选状态（提升到此，供左栏 kind 列表 + 画布卡片共享）。
  const [memKind, setMemKind] = useState<MemoryKind | 'all'>('all');
  const [memQuery, setMemQuery] = useState('');

  const probe = useCallback(async () => {
    setConn('probing'); setConnErr(null);
    if (!getSmartnoteApiKey()) { setConn('no-key'); return; }
    try {
      const r = await smartnoteProbe();
      if (r.ok) setConn('ok');
      else { setConn('down'); setConnErr(r.error || tr('kb.probeFailed')); }
    } catch (e: any) { setConn('down'); setConnErr(e?.message || tr('kb.probeFailed')); }
  }, [tr]);
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

  // ⌘K focuses search · ⌘N new note · Esc closes search overlay · 双击 Shift 也开搜索
  useEffect(() => {
    let lastShift = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void addNote(); }
      else if (e.key === 'Escape') { if (searchOpen) setSearchOpen(false); else if (listOpen) setListOpen(false); }
      else if (e.key === 'Shift' && !e.repeat) {
        const now = e.timeStamp || Date.now();
        if (now - lastShift < 400) { setSearchOpen(true); lastShift = 0; } else lastShift = now;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  // 新建笔记 = 保存对话框选位置（任意目录）→ 建空 .md → 平铺登记 → 打开。
  const addNote = useCallback(async () => {
    if (!localOk) { window.alert(tr('kb.localOnlyDesktop')); return; }
    try {
      const p = await newNoteFile(tr('kb.untitledNoteFile'));
      if (!p) return;
      await loadNotes();
      setSel({ kind: 'note', path: p });
    } catch (e: any) { window.alert(e?.message || tr('kb.createFailed')); }
  }, [localOk, loadNotes, tr]);

  // 导入：从任意目录挑选已有的 .md/.txt 文件，平铺加入。
  const importNote = useCallback(async () => {
    if (!localOk) { window.alert(tr('kb.localOnlyDesktop')); return; }
    try {
      const added = await importNotes();
      if (!added.length) return;
      await loadNotes();
      setSel({ kind: 'note', path: added[0] });
    } catch (e: any) { window.alert(e?.message || tr('kb.importFailed')); }
  }, [localOk, loadNotes, tr]);

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
      {conn === 'no-key' && <div className="v2-kb-body"><NoKey onSaved={probe} /></div>}
      {conn === 'down' && <div className="v2-kb-body"><Down err={connErr} onRetry={probe} /></div>}
      {conn === 'probing' && <div className="v2-kb-body"><KbEmpty title={tr('kb.connecting')} /></div>}

      {conn === 'ok' && (
        <div className="v2-kb-shell" data-list={peek.open ? '1' : undefined} data-standalone={standalone ? '1' : undefined}>
          <KbRail
            conn={conn}
            sel={sel}
            localOk={localOk}
            noteCount={notes.length}
            docCount={(docs || []).filter((d) => !isNote(d)).length}
            peek={peek}
            onSearch={() => setSearchOpen(true)}
            onPeek={togglePeek}
            onMemories={() => { setSel({ kind: 'memories' }); togglePeek('memories'); }}
            onNewNote={addNote}
            onImportNote={importNote}
            onUpload={() => setCreateUnder(null)}
          />
          {/* 停靠列表栏：点 rail 类目展开（推开画布）；KbPeek 常挂，靠列宽 0↔W 过渡显隐。 */}
          <div className="v2-kb-listcol">
            <KbPeek
              open={peek.open}
              filter={peek.filter}
              domains={domains}
              docs={docs}
              notes={notes}
              localOk={localOk}
              sel={sel}
              memKind={memKind}
              memQuery={memQuery}
              onMemKind={setMemKind}
              onMemQuery={setMemQuery}
              onSetFilter={setPeekFilter}
              onSelect={setSel}
              onDeepSearch={() => setSearchOpen(true)}
              onNewNote={addNote}
              onNewDomain={() => setDomainModal('new')}
              onEditDomain={(t) => setDomainModal(t)}
            />
          </div>
          <div className="v2-kb-canvaswrap">
            <KbCanvas
              sel={sel}
              docs={docs}
              notes={notes}
              domains={domains}
              llmConfigId={llmConfigId}
              memKind={memKind}
              memQuery={memQuery}
              onDocsChanged={loadDocs}
              onNotesChanged={loadNotes}
              onSelect={setSel}
              onAddNote={addNote}
            />
          </div>
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

/* ============ Left icon rail —— Focus 布局唯一导航（60px） ============
   搜索 / 本地笔记 / 云端文档 / 记忆 / 知识域 / ＋新建。点类目 → 从栏缘滑出 Peek。 */

const KbRail: React.FC<{
  conn: ConnState;
  sel: Selection;
  localOk: boolean;
  noteCount: number;
  docCount: number;
  peek: { open: boolean; filter: PeekFilter };
  onSearch: () => void;
  onPeek: (f: PeekFilter) => void;
  onMemories: () => void;
  onNewNote: () => void;
  onImportNote: () => void;
  onUpload: () => void;
}> = ({ conn, sel, localOk, noteCount, docCount, peek, onSearch, onPeek, onMemories, onNewNote, onImportNote, onUpload }) => {
  const { t: tr } = useI18n();
  const acct = useContext(KbAccountContext);
  const [plusMenu, setPlusMenu] = useState(false);
  const pf = peek.open ? peek.filter : null;
  const localActive = pf === 'local';
  const cloudActive = pf === 'cloud';
  const domainsActive = pf === 'domains' || (pf !== null && typeof pf === 'object');
  const connTone = conn === 'ok' ? 'ok' : conn === 'probing' ? 'probing' : conn === 'no-key' ? 'nokey' : 'down';
  const connLabel = conn === 'ok' ? tr('kb.connected') : conn === 'probing' ? tr('kb.connecting2') : conn === 'no-key' ? tr('kb.notConfigured') : tr('kb.unreachable');
  return (
    <aside className="v2-kb-rail">
      <button className="v2-kb-rb" data-tip={tr('kb.searchEllipsis')} aria-label={tr('kb.searchEllipsis')} onClick={onSearch}>
        <IconSearch /><span className="kbd">⌘K</span>
      </button>
      <div className="v2-kb-rsep" />
      <button className={`v2-kb-rb note${localActive ? ' active' : ''}`} data-tip={tr('kb.notes')} aria-label={tr('kb.notes')} onClick={() => onPeek('local')}>
        <IconEdit />{noteCount ? <span className="badge">{noteCount > 99 ? '99+' : noteCount}</span> : null}
      </button>
      <button className={`v2-kb-rb${cloudActive ? ' active' : ''}`} data-tip={tr('kb.document')} aria-label={tr('kb.document')} onClick={() => onPeek('cloud')}>
        <IconDoc />{docCount ? <span className="badge">{docCount > 99 ? '99+' : docCount}</span> : null}
      </button>
      <button className={`v2-kb-rb${sel.kind === 'memories' ? ' active' : ''}`} data-tip={tr('kb.memory')} aria-label={tr('kb.memory')} onClick={onMemories}>
        <IconPin />
      </button>
      <div className="v2-kb-rsep" />
      <button className={`v2-kb-rb${domainsActive ? ' active' : ''}`} data-tip={tr('kb.domains')} aria-label={tr('kb.domains')} onClick={() => onPeek('domains')}>
        <IconKB />
      </button>
      <div className="v2-kb-rspace" />
      <div className="v2-kb-rplus">
        <button className={`v2-kb-rb${plusMenu ? ' active' : ''}`} data-tip={tr('kb.newNote')} aria-label={tr('kb.newNote')} onClick={() => setPlusMenu((v) => !v)}>
          <IconPlus />
        </button>
        {plusMenu && (
          <>
            <div className="v2-kb-rplus-scrim" onClick={() => setPlusMenu(false)} />
            <div className="v2-kb-rplus-menu" role="menu">
              <button onClick={() => { setPlusMenu(false); onNewNote(); }} disabled={!localOk}><span className="i"><IconEdit /></span>{tr('kb.newNote')}</button>
              <button onClick={() => { setPlusMenu(false); onImportNote(); }} disabled={!localOk}><span className="i"><IconDoc /></span>{tr('kb.importExistingNote')}</button>
              <button onClick={() => { setPlusMenu(false); onUpload(); }} disabled={conn !== 'ok'}><span className="i"><IconCloud /></span>{tr('kb.uploadWiki')}</button>
            </div>
          </>
        )}
      </div>
      <div className={`v2-kb-rconn tone-${connTone}`} title={connLabel} aria-label={connLabel}><span className="dot" /></div>
      {acct && (
        <button
          className={`v2-kb-racct${acct.authed ? '' : ' guest'}`}
          data-tip={acct.authed ? acct.name : tr('shell.login')}
          aria-label={acct.authed ? acct.name : tr('shell.login')}
          onClick={acct.onOpen}
        >
          <span className={`av${acct.online ? ' online' : ''}`}>{acct.authed ? acct.initials : '·'}</span>
          <span className="gear" aria-hidden><IconGear /></span>
        </button>
      )}
    </aside>
  );
};

/* ============ Peek —— 临时密集浏览浮层（替代常驻树/中列） ============
   从 rail 缘滑出。搜索框 + 类型/域筛选胶囊 + 紧凑行。选中即载画布并收起（浏览→阅读不跳屏）。
   filter='domains' 时切换成「知识域管理」面板（列域、点域→看域内文档、新建/编辑域）。 */

const KbPeek: React.FC<{
  open: boolean;
  filter: PeekFilter;
  domains: Tag[];
  docs: Document[] | null;
  notes: LocalNoteFile[];
  localOk: boolean;
  sel: Selection;
  memKind: MemoryKind | 'all';
  memQuery: string;
  onMemKind: (k: MemoryKind | 'all') => void;
  onMemQuery: (q: string) => void;
  onSetFilter: (f: PeekFilter) => void;
  onSelect: (s: Selection) => void;
  onDeepSearch: () => void;
  onNewNote: () => void;
  onNewDomain: () => void;
  onEditDomain: (t: Tag) => void;
}> = ({ open, filter, domains, docs, notes, localOk, sel, memKind, memQuery, onMemKind, onMemQuery, onSetFilter, onSelect, onDeepSearch, onNewNote, onNewDomain, onEditDomain }) => {
  const { t: tr } = useI18n();
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 展开时聚焦搜索框（常挂组件，靠 open 上升沿触发，而非 autoFocus）。
  useEffect(() => { if (open) { const id = window.setTimeout(() => inputRef.current?.focus(), 60); return () => window.clearTimeout(id); } }, [open]);
  const mirrorIds = useMemo(() => syncedDocIds(), [notes]);
  const others = useMemo(() => domains.filter((t) => t.name !== NOTES_DOMAIN), [domains]);
  const domainsMode = filter === 'domains';
  const memMode = filter === 'memories';

  type Row = { key: string; kind: 'note' | 'doc'; title: string; sub: string; ts: number; sel: Selection };
  const rows = useMemo<Row[]>(() => {
    if (domainsMode) return [];
    const wantDom = typeof filter === 'object' ? filter.dom : null;
    const wantLocal = filter === 'all' || filter === 'local' || wantDom === NOTES_DOMAIN;
    const wantCloud = filter === 'all' || filter === 'cloud' || (wantDom !== null && wantDom !== NOTES_DOMAIN);
    const out: Row[] = [];
    if (wantLocal) {
      for (const f of notes) out.push({ key: 'n:' + f.path, kind: 'note', title: noteTitle(f), sub: NOTES_DOMAIN, ts: f.mtimeMs, sel: { kind: 'note', path: f.path } });
    }
    if (wantCloud) {
      for (const d of docs || []) {
        if (mirrorIds.has(d.id) || isNote(d)) continue;
        const dms = docDomains(d).filter((x) => x !== NOTES_DOMAIN);
        if (wantDom && wantDom !== NOTES_DOMAIN && !dms.includes(wantDom)) continue;
        out.push({ key: 'd:' + d.id, kind: 'doc', title: d.name || tr('kb.untitled'), sub: dms[0] || tr('kb.untagged'), ts: Date.parse(d.updated_at || d.created_at) || 0, sel: { kind: 'doc', id: d.id } });
      }
    }
    const needle = q.trim().toLowerCase();
    const filtered = needle ? out.filter((r) => r.title.toLowerCase().includes(needle)) : out;
    return filtered.sort((a, b) => b.ts - a.ts);
  }, [domainsMode, filter, notes, docs, mirrorIds, q, tr]);

  const docCountByDom = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of docs || []) {
      if (mirrorIds.has(d.id) || isNote(d)) continue;
      for (const dm of docDomains(d)) if (dm !== NOTES_DOMAIN) m.set(dm, (m.get(dm) || 0) + 1);
    }
    return m;
  }, [docs, mirrorIds]);

  const isSel = (s: Selection): boolean =>
    (s.kind === 'note' && sel.kind === 'note' && s.path === sel.path) ||
    (s.kind === 'doc' && sel.kind === 'doc' && s.id === sel.id);

  const chip = (f: PeekFilter, label: string) => (
    <button className={`v2-kb-pk-chip${samePeekFilter(filter, f) ? ' on' : ''}`} onClick={() => { setQ(''); onSetFilter(f); }}>{label}</button>
  );

  return (
      <div className="v2-kb-peek" aria-hidden={!open}>
        <div className="v2-kb-pk-srch">
          <div className="sb">
            <IconSearch />
            {memMode ? (
              <input
                ref={inputRef}
                value={memQuery}
                onChange={(e) => onMemQuery(e.target.value)}
                placeholder={tr('kb.filterMemoryPlaceholder')}
                aria-label={tr('kb.filterMemoryPlaceholder')}
                tabIndex={open ? 0 : -1}
              />
            ) : (
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onDeepSearch(); }}
                placeholder={tr('kb.searchPlaceholder')}
                aria-label={tr('kb.searchPlaceholder')}
                tabIndex={open ? 0 : -1}
              />
            )}
          </div>
        </div>

        {!domainsMode && !memMode && (
          <div className="v2-kb-pk-filters">
            {chip('all', tr('kb.all'))}
            {chip('local', tr('kb.notes'))}
            {chip('cloud', tr('kb.document'))}
            {others.map((t) => (
              <button
                key={t.name}
                className={`v2-kb-pk-chip${samePeekFilter(filter, { dom: t.name }) ? ' on' : ''}`}
                onClick={() => { setQ(''); onSetFilter({ dom: t.name }); }}
              >
                <span className="dot" style={{ background: domainColor(t) }} />{t.name}
              </button>
            ))}
          </div>
        )}

        <div className="v2-kb-pk-list">
          {memMode ? (
            <>
              <div className="v2-kb-pk-sec"><span>{tr('kb.memory')}</span></div>
              {(['all', ...Object.keys(KIND_LABELS)] as Array<MemoryKind | 'all'>).map((k) => (
                <button
                  key={k}
                  className={`v2-kb-pk-kindrow${memKind === k ? ' cur' : ''}`}
                  onClick={() => onMemKind(k)}
                >
                  <span className={`tone tone-${k === 'all' ? 'mute' : KIND_TONES[k as MemoryKind]}`} />
                  <span className="nm">{k === 'all' ? tr('kb.all') : tr('kb.kind.' + k)}</span>
                </button>
              ))}
            </>
          ) : domainsMode ? (
            <>
              <div className="v2-kb-pk-sec">
                <span>{tr('kb.domains')}</span>
                <button className="v2-kb-pk-add" title={tr('kb.newDomain')} onClick={onNewDomain}><IconPlus /></button>
              </div>
              <button className="v2-kb-pk-domrow" onClick={() => onSetFilter({ dom: NOTES_DOMAIN })}>
                <span className="dot" style={{ background: NOTES_DOMAIN_COLOR }} />
                <span className="nm">{tr('kb.notes')}</span>
                <span className="cnt">{notes.length || ''}</span>
              </button>
              {others.length === 0 && <div className="v2-kb-pk-empty">{tr('kb.noOtherDomains')}</div>}
              {others.map((t) => (
                <div key={t.name} className="v2-kb-pk-domrow" role="button" tabIndex={0} onClick={() => onSetFilter({ dom: t.name })}>
                  <span className="dot" style={{ background: domainColor(t) }} />
                  <span className="nm">{t.name}</span>
                  <span className="cnt">{docCountByDom.get(t.name) || ''}</span>
                  <span className="edit" title={tr('kb.editDomain')} onClick={(e) => { e.stopPropagation(); onEditDomain(t); }}><IconEdit /></span>
                </div>
              ))}
            </>
          ) : rows.length === 0 ? (
            <div className="v2-kb-pk-empty">{q.trim() ? tr('kb.noMatches') : tr('kb.empty')}</div>
          ) : (
            rows.map((r) => (
              <button key={r.key} className={`v2-kb-pk-row${isSel(r.sel) ? ' cur' : ''}`} onClick={() => onSelect(r.sel)} title={r.title}>
                <span className={`pi ${r.kind === 'note' ? 'local' : 'cloud'}`}>{r.kind === 'note' ? <IconEdit /> : <IconDoc />}</span>
                <span className="pmain">
                  <span className="pttl">{r.title}</span>
                  <span className="psub">{r.sub}{r.ts ? ' · ' + fmtRelTime(r.ts, tr) : ''}</span>
                </span>
                <span className={`ptype ${r.kind === 'note' ? 'local' : 'cloud'}`}>{r.kind === 'note' ? tr('kb.typeLocal') : tr('kb.typeCloud')}</span>
              </button>
            ))
          )}
        </div>

        {!memMode && !domainsMode && (
          <div className="v2-kb-pk-foot">
            <button className="deep" onClick={onDeepSearch}><IconSearch />{tr('kb.deepSearch')}</button>
            {localOk && <button className="new" onClick={onNewNote}><IconPlus />{tr('kb.newNote')}</button>}
          </div>
        )}
      </div>
  );
};

/** Compact relative age for note rows, via the shared local.time.* dictionary. */
function fmtRelTime(ms: number, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return tr('local.time.justNow');
  if (diff < 3600_000) return tr('local.time.minutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return tr('local.time.hours', { n: Math.floor(diff / 3600_000) });
  if (diff < 30 * 86400_000) return tr('local.time.days', { n: Math.floor(diff / 86400_000) });
  if (diff < 365 * 86400_000) return tr('local.time.months', { n: Math.floor(diff / (30 * 86400_000)) });
  return tr('local.time.years', { n: Math.floor(diff / (365 * 86400_000)) });
}

/* ============ Right canvas (router) ============ */

const KbCanvas: React.FC<{
  sel: Selection;
  docs: Document[] | null;
  notes: LocalNoteFile[];
  domains: Tag[];
  llmConfigId?: string;
  memKind: MemoryKind | 'all';
  memQuery: string;
  onDocsChanged: () => void | Promise<void>;
  onNotesChanged: () => void | Promise<void>;
  onSelect: (s: Selection) => void;
  onAddNote: () => void;
}> = ({ sel, docs, notes, domains, memKind, memQuery, onDocsChanged, onNotesChanged, onSelect, onAddNote }) => {
  const { t: tr } = useI18n();
  if (sel.kind === 'memories') return <div className="v2-kb-canvas pad"><MemoriesTab domain={null} kind={memKind} q={memQuery} controlled /></div>;
  if (sel.kind === 'all') return <KbAllList docs={docs} notes={notes} onSelect={onSelect} onAddNote={onAddNote} />;
  if (sel.kind === 'note') {
    const f = notes.find((n) => n.path === sel.path);
    if (!f) return <div className="v2-kb-canvas"><KbEmpty title={tr('kb.notFound')} hint={tr('kb.noteMaybeMoved')} /></div>;
    return <LocalNoteCanvas key={f.path} file={f} domains={domains} onChanged={onNotesChanged} onDeleted={() => onSelect({ kind: 'all' })} />;
  }
  // cloud doc
  const doc = (docs || []).find((d) => d.id === sel.id);
  if (!doc) return <div className="v2-kb-canvas"><KbEmpty title={tr('kb.notFound')} hint={tr('kb.maybeDeleted')} /></div>;
  return <DocCanvas key={doc.id} doc={doc} domains={domains} onChanged={onDocsChanged} onDeleted={() => onSelect({ kind: 'all' })} />;
};

/* ============ All-content flat list (默认落地页) —— 本地笔记 + 云端文档 ============ */

const KbAllList: React.FC<{ docs: Document[] | null; notes: LocalNoteFile[]; onSelect: (s: Selection) => void; onAddNote: () => void }> = ({ docs, notes, onSelect, onAddNote }) => {
  const { t: tr } = useI18n();
  type Row = { key: string; name: string; ts: number; sel: Selection };
  const rows: Row[] = [
    ...notes.map((f) => ({ key: 'n:' + f.path, name: noteTitle(f), ts: f.mtimeMs, sel: { kind: 'note', path: f.path } as Selection })),
    ...(docs || []).filter((d) => !isNote(d)).map((d) => ({
      key: 'd:' + d.id, name: d.name || tr('kb.untitled'),
      ts: Date.parse(d.updated_at || d.created_at) || 0,
      sel: { kind: 'doc', id: d.id } as Selection,
    })),
  ].sort((a, b) => b.ts - a.ts);

  if (docs && rows.length === 0) {
    return (
      <div className="v2-kb-canvas">
        <div className="v2-kb-welcome">
          <h3>{tr('kb.welcomeEmptyTitle')}</h3>
          <p>{tr('kb.welcomeEmptyDesc')}</p>
          <button className="v2-set-btn primary" onClick={() => onAddNote()}><IconEdit /> {tr('kb.writeFirstNote')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="v2-kb-canvas pad">
      {!docs ? <KbEmpty title={tr('kb.loading')} /> : (
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
  const { t: tr } = useI18n();
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
    if (!nm) { window.alert(tr('kb.domainNameEmpty')); return; }
    setBusy(true);
    try {
      await smartnoteTags.upsert({ name: nm, description: desc.trim(), color, sort_order: tag?.sort_order ?? 0 });
      await onSaved(nm);
    } catch (e: any) { window.alert(e?.message || tr('kb.saveFailed')); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!tag) return;
    if (!window.confirm(tr('kb.deleteDomainConfirm', { name: tag.name }))) return;
    setBusy(true);
    try { await smartnoteTags.remove(tag.name); await onSaved(tag.name, true); }
    catch (e: any) { window.alert(e?.message || tr('kb.deleteFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tag ? tr('kb.editDomainTitle') : tr('kb.newDomainTitle')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.aliasDomainName')}</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('kb.domainNamePlaceholder')} disabled={!!tag}
              title={tag ? tr('kb.domainNameLocked') : ''} />
            <div className="v2-modal-note">{tr('kb.domainMentionNotePre')} <code>@{name.trim() || tr('kb.domainNameWord')}</code> {tr('kb.domainMentionNotePost')}</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.descOptional')}</div>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tr('kb.descPlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.color')}</div>
            <div className="v2-kb-swatches">
              {DOMAIN_COLORS.map((c) => (
                <button key={c} className={`v2-kb-swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          {tag && <button className="v2-mbtn" style={{ color: 'var(--c-danger)', marginRight: 'auto' }} onClick={() => void remove()} disabled={busy}>{tr('common.delete')}</button>}
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('kb.saving') : tr('common.save')}</button>
        </div>
      </div>
    </div>
  );
};

/* ============ Memories ============ */

/** controlled：kind/q 由外部（KB 左栏）驱动，画布内不再渲染筛选 tab/搜索，只留卡片 + 新建。 */
const MemoriesTab: React.FC<{ domain: string | null; kind?: MemoryKind | 'all'; q?: string; controlled?: boolean }> = ({ domain, kind: kindProp, q: qProp, controlled }) => {
  const { t: tr } = useI18n();
  const [list, setList] = useState<Memory[] | null>(null);
  const [kindFilterLocal, setKindFilter] = useState<MemoryKind | 'all'>('all');
  const [qLocal, setQ] = useState('');
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [loading, setLoading] = useState(false);
  const kindFilter = controlled ? (kindProp ?? 'all') : kindFilterLocal;
  const q = controlled ? (qProp ?? '') : qLocal;

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
    catch (e: any) { window.alert(e?.message || tr('kb.failed')); }
  };
  const onDelete = async (m: Memory) => {
    if (!window.confirm(tr('kb.deleteMemoryConfirm', { snippet: m.content.slice(0, 80) }))) return;
    try { await smartnoteMemories.remove(m.id); void load(); }
    catch (e: any) { window.alert(e?.message || tr('kb.failed')); }
  };

  return (
    <>
      {controlled ? (
        <div className="v2-kb-toolbar slim">
          <span className="grow" />
          <button className="v2-set-btn primary" onClick={() => setEditing('new')}>＋ {tr('kb.newMemory')}</button>
        </div>
      ) : (
        <div className="v2-kb-toolbar">
          <div className="v2-kb-filters">
            <button className={`v2-kb-pill${kindFilter === 'all' ? ' on' : ''}`} onClick={() => setKindFilter('all')}>{tr('kb.all')}</button>
            {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
              <button
                key={k}
                className={`v2-kb-pill${kindFilter === k ? ' on' : ''}`}
                onClick={() => setKindFilter(k)}
              >
                {tr('kb.kind.' + k)}
              </button>
            ))}
          </div>
          <div className="v2-kb-search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('kb.filterMemoryPlaceholder')} onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} />
          </div>
          <button className="v2-set-btn primary" onClick={() => setEditing('new')}>＋ {tr('kb.newMemory')}</button>
        </div>
      )}

      {loading && !list && <KbEmpty title={tr('kb.loading')} />}
      {list && list.length === 0 && <KbEmpty title={tr('kb.noMemories')} hint={tr('kb.noMemoriesHint')} />}
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
const MemoryRow: React.FC<MemoryRowProps> = ({ m, onPin, onEdit, onDelete }) => {
  const { t: tr } = useI18n();
  return (
  <div className={`v2-kb-card${m.pinned ? ' pinned' : ''}`}>
    <div className="hd">
      <span className={`v2-pill ${KIND_TONES[m.kind]}`}>{tr('kb.kind.' + m.kind)}</span>
      {m.scope && m.scope !== 'workspace' && <span className="v2-pill mute">scope: {m.scope}</span>}
      {m.tags?.slice(0, 3).map((t) => <span key={t} className="v2-pill mute">#{t}</span>)}
      {m.tags && m.tags.length > 3 && <span className="v2-pill mute" title={m.tags.slice(3).map((t) => `#${t}`).join(' ')}>+{m.tags.length - 3}</span>}
      <span className="grow" />
      <div className="acts">
        <button className={`iconbtn${m.pinned ? ' on' : ''}`} title={m.pinned ? tr('kb.unpin') : tr('kb.pin')} onClick={() => onPin(m)}><IconPin filled={m.pinned} /></button>
        <button className="iconbtn" title={tr('kb.edit')} onClick={() => onEdit(m)}><IconEdit /></button>
        <button className="iconbtn danger" title={tr('common.delete')} onClick={() => onDelete(m)}><IconTrash /></button>
      </div>
    </div>
    <ExpandableBody text={m.content} lines={5} />
    <div className="ft">
      <span>{new Date(m.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
      <span>by {m.author_agent || 'unknown'}</span>
    </div>
  </div>
  );
};
const MemoryRowMemo = React.memo(MemoryRow);

const MemoryEditModal: React.FC<{
  memory: Memory | null;
  domain?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ memory, domain, onClose, onSaved }) => {
  const { t: tr } = useI18n();
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
    if (!content.trim()) { window.alert(tr('kb.contentEmpty')); return; }
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
      window.alert(e?.message || tr('kb.saveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{memory ? tr('kb.editMemoryTitle') : tr('kb.newMemory')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.type')}</div>
            <div className="v2-options">
              {(Object.keys(KIND_LABELS) as MemoryKind[]).map((k) => (
                <div
                  key={k}
                  className={`v2-opt${kind === k ? ' active' : ''}`}
                  onClick={() => !memory && setKind(k)}
                  style={memory ? { opacity: 0.6, cursor: 'not-allowed' } : undefined}
                  title={memory ? tr('kb.kindLocked') : ''}
                >
                  <span>{tr('kb.kind.' + k)}</span><small>{k.toUpperCase()}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.content')}</div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} placeholder={tr('kb.memoryContentPlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="lab">Scope</div>
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="workspace · agent:<id> · …" />
            <div className="v2-modal-note">{tr('kb.scopeNotePre')} <code>agent:&lt;agentId&gt;</code></div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.tags')}</div>
            <input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} placeholder={tr('kb.tagsPlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="v2-set-row" style={{ padding: 0 }}>
              <div className="v2-set-row-l"><div className="lab">{tr('kb.pin')}</div><div className="sub">{tr('kb.pinSub')}</div></div>
              <button className={`v2-switch${pinned ? ' on' : ''}`} onClick={() => setPinned(!pinned)}><span className="thumb" /></button>
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('kb.saving') : tr('common.save')}</button>
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
  const { t: tr } = useI18n();
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
    try { const r = await smartnoteDocuments.ingest(doc.id); window.alert(tr('kb.ingestedChunks', { count: r.chunks })); await onChanged(); }
    catch (e: any) { window.alert(e?.message || tr('kb.ingestFailed')); }
    finally { setBusy(false); }
  };
  // 两步删除（Electron 禁用 window.confirm）。
  const onDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); window.setTimeout(() => setConfirmDel(false), 2600); return; }
    try { await smartnoteDocuments.remove(doc.id); await onChanged(); onDeleted(); }
    catch (e: any) { window.alert(e?.message || tr('kb.deleteFailed')); }
  };

  return (
    <section className="v2-kb-canvas v2-doc-canvas">
      <div className="v2-note-toolbar">
        <span className="v2-note-title" title={doc.name}>{doc.name}</span>
        <span className="v2-kb-typechip cloud"><span className="dotg" />{tr('kb.typeCloud')}</span>
        <span className="v2-pill mute">{formatBytes(doc.byte_size)}</span>
        {doc.ingested_at ? <span className="v2-pill ok">{tr('kb.chunked')}</span> : <span className="v2-pill warn">{tr('kb.pendingChunk')}</span>}
        {docDomains(doc).map((dm) => <span key={dm} className="v2-pill soft">@{dm}</span>)}
        <span className="grow" />
        <button className="v2-kb-pill" onClick={() => setEditDomains(true)}>{tr('kb.domainsAssign')}</button>
        <button className="v2-kb-pill" disabled={busy} onClick={() => void onIngest()}>{busy ? tr('kb.processing') : tr('kb.ingest')}</button>
        <button className={`v2-note-icon danger${confirmDel ? ' confirm' : ''}`} onClick={() => void onDelete()} title={confirmDel ? tr('kb.clickAgainToDelete') : tr('common.delete')}>
          {confirmDel ? tr('kb.confirmQ') : <IconTrash />}
        </button>
      </div>
      <div className="v2-note-surface">
        {content === null ? <div className="v2-note-empty">{tr('kb.opening')}</div> : (
          <div className="v2-note-preview"><MD text={content || tr('kb.emptyDocument')} /></div>
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
  const { t: tr } = useI18n();
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
    } catch (e: any) { window.alert(e?.message || tr('kb.saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tr('kb.configDomains')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.document')}</div>
            <div className="v2-modal-note" style={{ marginTop: 2 }}>{doc.name}</div>
          </div>
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.domainsMulti')}</div>
            {domains.length === 0 ? (
              <div className="v2-modal-note">{tr('kb.noDomainsYet')}</div>
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
                ? <>{tr('kb.domainsNoteIngestedPre')}<code>@{tr('kb.domainNameWord')}</code>{tr('kb.domainsNoteIngestedPost')}</>
                : <>{tr('kb.domainsNotePending')}</>}
            </div>
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('kb.saving') : tr('common.save')}</button>
        </div>
      </div>
    </div>
  );
};

const DocumentCreateModal: React.FC<{ domain: string | null; onClose: () => void; onCreated: () => void }> = ({ domain, onClose, onCreated }) => {
  const { t: tr } = useI18n();
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
    if (!name.trim() || !content.trim()) { window.alert(tr('kb.nameAndContentRequired')); return; }
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
    } catch (e: any) { window.alert(e?.message || tr('kb.failed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tr('kb.uploadWiki')}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="v2-modal-body">
          <div className="v2-modal-sec">
            <div className="lab">{tr('kb.name')}</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('kb.docNamePlaceholder')} />
          </div>
          <div className="v2-modal-sec">
            <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{tr('kb.body')}</span>
              <button className="v2-set-btn" style={{ marginLeft: 'auto' }} onClick={() => fileRef.current?.click()}>{tr('kb.readFromFile')}</button>
              <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.text,.rst,.org,.html" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); e.target.value = ''; }} />
            </div>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} placeholder={tr('kb.bodyPlaceholder')} />
          </div>
        </div>
        <div className="v2-modal-foot">
          <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button className="v2-mbtn primary" onClick={() => void save()} disabled={busy}>{busy ? tr('kb.saving') : tr('common.save')}</button>
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
  const { t: tr } = useI18n();
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
  const [defPath, setDefPath] = useState<string | null>(null);   // 当前默认速记路径
  const [assocMenu, setAssocMenu] = useState(false);
  const editorRef = useRef<NoteEditorHandle | null>(null);
  const isDefault = !!defPath && defPath === file.path;
  const associated = !!getDefaultNotePath();

  // 解析当前默认速记路径（用于判断本笔记是不是速记 + 关联操作）。
  useEffect(() => { let alive = true; void defaultNote().then((d) => { if (alive) setDefPath(d?.path ?? null); }); return () => { alive = false; }; }, [file.path]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setPreview(false); setDirty(false); setTitle(noteTitle(file)); setRenaming(false); setConfirmDel(false); setAssocMenu(false);
    setSynced(!!syncedDocId(file.path));
    readLocalNote(file.path).then((c) => {
      if (!alive) return;
      setContent(c); editorRef.current?.setContent(c); setLoading(false);
      setTimeout(() => editorRef.current?.focus(), 30);
    }).catch((e) => { if (alive) { window.alert(e?.message || tr('kb.openFailed')); setLoading(false); } });
    return () => { alive = false; };
  }, [file.path]);

  // 保存 = 写本地文件。
  const doSave = useCallback(async (body: string) => {
    setSaving(true);
    try { await writeLocalNote(file.path, body); setDirty(false); }
    catch (e: any) { window.alert(e?.message || tr('kb.saveFailed')); }
    finally { setSaving(false); }
  }, [file.path, tr]);

  // 内联改名 = 重命名文件。
  const commitRename = async (name: string) => {
    setRenaming(false);
    const v = name.trim();
    if (!v || v === title) return;
    try { await renameLocalNote(file.path, v); setTitle(v); await onChanged(); }
    catch (e: any) { window.alert(e?.message || tr('kb.renameFailed')); }
  };
  // 两步删除（删本地文件，进回收站）。
  const onDelete = async () => {
    if (!confirmDel) { setConfirmDel(true); window.setTimeout(() => setConfirmDel(false), 2600); return; }
    try { await deleteLocalNote(file.path); await onChanged(); onDeleted(); }
    catch (e: any) { window.alert(e?.message || tr('kb.deleteFailed')); }
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
      window.alert(tr('kb.syncedToCloud'));
    } catch (e: any) {
      // 本地此时已写盘(上面 writeLocalNote)。区分「网络连不上」与其它错误，给可操作提示。
      const msg = String(e?.message || e || '');
      if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
        window.alert(tr('kb.syncUnreachable', { base: getSmartnoteBaseUrl() }));
      } else {
        window.alert(msg || tr('kb.syncFailed'));
      }
    }
    finally { setSyncing(false); }
  };

  // 速记关联：重新关联到已有本地文件 / 另存到新位置并关联 / 取消关联。改完刷新默认路径 + 树。
  const refreshDefault = useCallback(() => { void defaultNote().then((d) => setDefPath(d?.path ?? null)); void onChanged(); }, [onChanged]);
  const doAssociate = async () => { setAssocMenu(false); try { const d = await associateDefaultNote(); if (d) refreshDefault(); } catch (e: any) { window.alert(e?.message || tr('local.notes.saveFailed')); } };
  const doSaveAs = async () => { setAssocMenu(false); try { const body = editorRef.current ? editorRef.current.getContent() : content; const d = await saveDefaultNoteAs(body); if (d) refreshDefault(); } catch (e: any) { window.alert(e?.message || tr('local.notes.saveFailed')); } };
  const doUnlink = () => { setAssocMenu(false); resetDefaultNoteLocation(); refreshDefault(); };

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
          <button className="v2-note-title" onClick={() => setRenaming(true)} title={tr('kb.clickToRename')}>{title || tr('kb.untitled')}</button>
        )}
        <span className="v2-kb-typechip local" title={file.path}><IconEdit />{tr('kb.typeLocal')}</span>
        <span className="v2-note-status">{saving ? tr('kb.saving') : dirty ? tr('kb.unsaved') : tr('kb.savedLocal')}</span>
        <span className={`v2-pill ${synced ? 'ok' : 'mute'}`}>{synced ? tr('kb.synced') : tr('kb.notSynced')}</span>
        {isDefault && (
          <div className="v2-note-assoc">
            <button className={`v2-pill assoc${assocMenu ? ' on' : ''}`} onClick={() => setAssocMenu((v) => !v)} title={tr('kb.assoc.title')}>
              ★ {associated ? tr('kb.assoc.linked') : tr('kb.assoc.default')}
            </button>
            {assocMenu && (
              <>
                <div className="v2-note-assoc-scrim" onClick={() => setAssocMenu(false)} />
                <div className="v2-note-assoc-menu">
                  <div className="hd">{tr('kb.assoc.title')}</div>
                  <button onClick={() => void doAssociate()}>{tr('kb.assoc.pick')}</button>
                  <button onClick={() => void doSaveAs()}>{tr('kb.assoc.saveAs')}</button>
                  {associated && <button className="reset" onClick={doUnlink}>{tr('kb.assoc.unlink')}</button>}
                  {associated && <div className="path" title={file.path}>{file.path}</div>}
                </div>
              </>
            )}
          </div>
        )}
        <span className="grow" />
        <button
          className={`v2-note-icon${preview ? ' on' : ''}`}
          onClick={() => {
            if (!preview && editorRef.current) setContent(editorRef.current.getContent());
            setPreview((v) => !v);
          }}
          title={preview ? tr('kb.backToEdit') : tr('kb.preview')}
        >{preview ? <IconEdit /> : <IconEye />}</button>
        <button
          className={`v2-note-icon${syncing ? ' busy' : ''}`}
          disabled={syncing}
          onClick={() => void onSync()}
          title={syncing ? tr('kb.syncing') : tr('kb.syncTip')}
        ><IconSync /></button>
        <button className={`v2-note-icon danger${confirmDel ? ' confirm' : ''}`} onClick={() => void onDelete()} title={confirmDel ? tr('kb.clickAgainToDelete') : tr('common.delete')}>
          {confirmDel ? tr('kb.confirmQ') : <IconTrash />}
        </button>
      </div>
      <div className="v2-note-surface">
        {loading ? <div className="v2-note-empty">{tr('kb.opening')}</div> : preview ? (
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
  const { t: tr } = useI18n();
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
        setSearchError(e?.message || tr('kb.searchFailed')); setHits([]);
      } finally {
        if (id === reqRef.current) setBusy(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, domain, noteDocIds, loadHistory, tr]);

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
      setAnswer({ loading: false, text: '', error: e?.message || tr('kb.aiAnswerFailed') });
    }
  }, [q, hits, llmConfigId, tr]);

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
    const out: Array<{ type: SearchHit['type']; items: Array<{ hit: SearchHit; idx: number }> }> = [];
    let cur: { type: SearchHit['type']; items: Array<{ hit: SearchHit; idx: number }> } | null = null;
    hits.forEach((hit, idx) => {
      if (!cur || cur.type !== hit.type) { cur = { type: hit.type, items: [] }; out.push(cur); }
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
          placeholder={tr('kb.searchPlaceholder')}
          aria-label={tr('kb.searchAria')}
          autoFocus
        />
        {busy && <span className="v2-cmdk-spin" aria-label={tr('kb.searching')} />}
      </div>

      {searchError && <div className="v2-kb-warn v2-cmdk-error">{searchError}</div>}

      <div className="v2-cmdk-body">
        <div className="v2-cmdk-list">
          {!hits && !busy && (
            history.length > 0 ? (
              <div className="v2-cmdk-recent">
                <div className="v2-cmdk-secthd">{tr('kb.recentSearches')}</div>
                {history.map((h) => (
                  <button key={h.id} className="v2-cmdk-recent-item" onClick={() => setQ(h.query_text)}>
                    <IconSearch />
                    <span className="q">{h.query_text}</span>
                    <span className="n">{h.result_count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <KbEmpty title={tr('kb.searchKbTitle')} hint={tr('kb.searchKbHint')} />
            )
          )}

          {hits && hits.length === 0 && !busy && <KbEmpty title={tr('kb.noMatches')} hint={tr('kb.noMatchesHint')} />}

          {groups.map((g) => (
            <div key={g.type} className="v2-cmdk-group">
              <div className="v2-cmdk-secthd">{tr('kb.group.' + g.type)} <span className="cnt">{g.items.length}</span></div>
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
                        ? <span className="src">{hit.mem.kind || tr('kb.memory')}</span>
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
              <div className="v2-cmdk-secthd answer-hd"><IconModel /> {tr('kb.aiAnswer')}
                <button className="v2-cmdk-answer-x" onClick={() => setAnswer(null)} title={tr('common.close')}>✕</button>
              </div>
              {answer.loading && <div className="v2-cmdk-answer-loading">{tr('kb.generating')}</div>}
              {answer.error && <div className="v2-kb-warn">{answer.error}</div>}
              {!answer.loading && answer.text && <div className="v2-cmdk-answer-body"><MD text={answer.text} /></div>}
            </div>
          ) : selected?.type === 'memory' ? (
            <div className="v2-cmdk-prev-mem">
              <div className="v2-cmdk-prev-hd"><span className="src">{selected.mem.kind || tr('kb.memory')}</span></div>
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
                ? tr('kb.vectorFallback')
                : hits === null ? tr('kb.enterKeywordToSearch') : tr('kb.selectToViewSource')}
            </div>
          )}
        </aside>
      </div>

      <div className="v2-cmdk-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> {tr('kb.kbdSelect')}</span>
        <span><kbd>↵</kbd> {tr('kb.kbdOpen')}</span>
        <span><kbd>⌘</kbd><kbd>↵</kbd> {tr('kb.aiAnswer')}</span>
        <span><kbd>esc</kbd> {tr('common.close')}</span>
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
  const { t: tr } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2-kb-search-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-kb-search-panel v2-cmdk-panel" role="dialog" aria-modal="true" aria-labelledby="kb-search-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="kb-search-title" className="v2-sr-only">{tr('kb.searchKbTitle')}</h2>
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
  const { t: tr } = useI18n();
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
          {expanded ? tr('kb.collapse') : tr('kb.expand')}
        </button>
      )}
    </>
  );
};

const KbEmpty: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="v2-kb-empty">
    <div className="t">{title}</div>
    {hint && <div className="h">{hint}</div>}
  </div>
);

const NoKey: React.FC<{ onSaved: () => void | Promise<void> }> = ({ onSaved }) => {
  const { t: tr } = useI18n();
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
      <div className="t">{tr('kb.configSmartnoteCreds')}</div>
      <div className="h">{tr('kb.configSmartnoteDesc')}</div>
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
          <div style={{ fontSize: 11.5, color: 'var(--c-ink-3)', marginBottom: 4 }}>Base URL <span style={{ color: 'var(--c-ink-4)' }}>{tr('kb.blankForDefault')}</span></div>
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
        >{busy ? tr('kb.verifying') : tr('kb.saveAndConnect')}</button>
        <div style={{ fontSize: 12, color: 'var(--c-ink-4)', textAlign: 'center', marginTop: 4 }}>
          {tr('kb.alsoChangeInSettings')}
        </div>
      </div>
    </div>
  );
};

const Down: React.FC<{ err: string | null; onRetry: () => void | Promise<void> }> = ({ err, onRetry }) => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-kb-empty">
    <div className="t">{tr('kb.smartnoteUnreachable')}</div>
    <div className="h">{err || tr('kb.cantReachKb')}</div>
    <div style={{ marginTop: 12 }}>
      <button className="v2-set-btn primary" onClick={() => void onRetry()}>{tr('kb.retry')}</button>
    </div>
  </div>
  );
};

function formatBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default KnowledgeView;
