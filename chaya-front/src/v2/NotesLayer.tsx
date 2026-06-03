/**
 * Wiki-notes integration for the CLI (replaces the old per-cwd localStorage notes).
 *
 *  - useWikiNotes(): loads the wiki .md notes, ensures a fixed default 「速记」 note,
 *      and appends captures to it. One source of truth = the knowledge base.
 *  - SelectionToolbar: select text in a CLI transcript → 「展开讲讲」(derive) /
 *      「记一条」(append the selection to 速记). Portaled to .chaya-v2 root.
 *  - WikiNotes: composer pill → browse wiki notes + KB docs and click to wire one
 *      into the prompt (本地笔记/文档 → 路径引用；纯云端文档 → 内容).
 *  - WikiPicker: shared list (search + sections) used by both the pill panel and
 *      the composer's @-mention popover.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import {
  listNotes, defaultNote, appendToNote, noteTitle, isLocalNotesAvailable,
  syncedDocId, readNote, writeNote, associateDefaultNote, getDefaultNotePath,
  resetDefaultNoteLocation, type LocalNoteFile,
} from './services/localNotes';
import { smartnoteDocuments, type Document } from '../services/smartnoteApi';
import type { NoteKind } from './services/localAgent';

// 线性图标，匹配 app 的 24×24 / 1.6–1.8 stroke 风格。带 width/height 兜底尺寸：
// CSS 仍可覆盖，但即便某条 svg 尺寸规则没命中(HMR 旧样式等)也绝不会撑成巨图。
const IconNoteBook = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7z" /><path d="M7 3.5v17" />
    <path d="M10.5 8.5h4.5M10.5 12.5h4.5M10.5 16.5h2.5" />
  </svg>
);
const IconBookmark = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2z" /></svg>
);
const IconTerminalSm = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7.5 9.5l3 2.5-3 2.5M13 14.5h4" /></svg>
);
const IconDocSm = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h7l5 5v12H6z" /><path d="M13 3.5V9h5" /></svg>
);
const IconStar = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none"><path d="M12 3.6l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L3.6 9.3l5.4-.8z" /></svg>
);
const IconXSm = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const IconLink = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1" /><path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5l1-1" /></svg>
);

/* ---- relative age, via the shared local.time.* dictionary ---- */
function fmtAge(ms: number, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return tr('local.time.justNow');
  if (d < 3600_000) return tr('local.time.minutes', { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return tr('local.time.hours', { n: Math.floor(d / 3600_000) });
  if (d < 30 * 86400_000) return tr('local.time.days', { n: Math.floor(d / 86400_000) });
  if (d < 365 * 86400_000) return tr('local.time.months', { n: Math.floor(d / (30 * 86400_000)) });
  return tr('local.time.years', { n: Math.floor(d / (365 * 86400_000)) });
}

/* ================= data hook ================= */

export interface WikiNotesApi {
  notes: LocalNoteFile[];
  docs: Document[];
  defaultPath: string | null;
  available: boolean;
  loading: boolean;
  reload: () => void;
  /** Append a captured snippet to the default 速记 note. Returns the note's title. */
  appendToDefault: (text: string) => Promise<string>;
  /** Associate 速记 with an existing local file (e.g. one in iCloud Drive). */
  associateDefault: () => Promise<string | null>;
  /** Drop the association → back to the auto default location. */
  resetDefault: () => void;
  /** Whether 速记 is currently associated to a user-chosen file. */
  associated: boolean;
}

export function useWikiNotes(active: boolean): WikiNotesApi {
  const available = isLocalNotesAvailable();
  const [notes, setNotes] = useState<LocalNoteFile[]>([]);
  const [docs, setDocs] = useState<Document[]>([]);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    if (!available) return;
    let alive = true;
    setLoading(true);
    // Ensure the default note exists & is registered, then list everything.
    void defaultNote().then((d) => { if (alive && d) setDefaultPath(d.path); }).catch(() => {});
    listNotes().then((ns) => { if (alive) setNotes(ns); }).catch(() => { if (alive) setNotes([]); }).finally(() => { if (alive) setLoading(false); });
    // Cloud docs are best-effort (auth/offline) — they enrich @-mention but never block.
    smartnoteDocuments.list().then((r) => { if (alive) setDocs(r.documents || []); }).catch(() => { if (alive) setDocs([]); });
    return () => { alive = false; };
  }, [available]);

  useEffect(() => { if (active) return reload(); }, [active, reload]);

  const appendToDefault = useCallback(async (text: string): Promise<string> => {
    const t = (text || '').trim();
    if (!t) return '';
    const d = await defaultNote();
    if (!d) throw new Error('unavailable');
    // Block = a divider + the captured text, so 速记 reads as a running log.
    const block = `\n---\n${t}\n`;
    await appendToNote(d.path, block);
    setDefaultPath(d.path);
    reload();
    return noteTitle(d);
  }, [reload]);

  const [associated, setAssociated] = useState<boolean>(() => !!getDefaultNotePath());
  const associateDefault = useCallback(async (): Promise<string | null> => {
    const d = await associateDefaultNote();
    if (d) { setDefaultPath(d.path); setAssociated(true); reload(); }
    return d ? d.path : null;
  }, [reload]);
  const resetDefault = useCallback(() => {
    resetDefaultNoteLocation();
    setAssociated(false);
    void defaultNote().then((d) => { if (d) setDefaultPath(d.path); reload(); });
  }, [reload]);

  return { notes, docs, defaultPath, available, loading, reload, appendToDefault, associateDefault, resetDefault, associated };
}

/* ================= selection toolbar ================= */

export const SelectionToolbar: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  onNote: (text: string) => void;          // 记一条 → append to 速记
  onDerive?: (text: string, range: Range | null) => void;
  onPrewarm?: () => void;
}> = ({ containerRef, onNote, onDerive, onPrewarm }) => {
  const { t: tr } = useI18n();
  const [st, setSt] = useState<{ x: number; y: number; text: string; canDerive: boolean } | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const prewarmRef = useRef(onPrewarm); prewarmRef.current = onPrewarm;
  useEffect(() => {
    const probe = () => {
      const sel = window.getSelection();
      const text = (sel?.toString() || '').trim();
      const node = sel?.anchorNode || null;
      const el = containerRef.current;
      if (!text || text.length < 4 || !el || !node || !el.contains(node)) { setSt(null); return; }
      const range = sel!.getRangeAt(0);
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      if (!last) { setSt(null); return; }
      rangeRef.current = range.cloneRange();
      const anchorEl: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
      const inProse = !!anchorEl?.closest('.v2-la-prose');
      if (inProse) prewarmRef.current?.();
      setSt({ x: Math.min(last.right + 8, window.innerWidth - 200), y: last.bottom - 2, text, canDerive: inProse });
    };
    const onUp = () => window.setTimeout(probe, 0);
    const hide = () => setSt(null);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('scroll', hide, true);
    return () => { document.removeEventListener('mouseup', onUp); window.removeEventListener('scroll', hide, true); };
  }, [containerRef]);

  if (!st) return null;
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-sel-bar show" style={{ left: st.x, top: st.y }} onMouseDown={(e) => e.preventDefault()}>
      {st.canDerive && onDerive && (
        <>
          <button className="v2-sel-act derive" onClick={() => { onDerive(st.text, rangeRef.current); setSt(null); }}>
            <IconTerminalSm /><span>{tr('local.sel.derive')}</span>
          </button>
          <span className="v2-sel-sep" />
        </>
      )}
      <button className="v2-sel-act note" onClick={() => { onNote(st.text); setSt(null); }}>
        <IconBookmark /><span>{tr('local.sel.note')}</span>
      </button>
    </div>,
    host,
  );
};

/* ================= shared picker (pill panel + @-mention) ================= */

export interface WikiItem {
  key: string;
  kind: 'note' | 'doc';
  title: string;
  path?: string;       // local notes / synced docs → absolute path
  docId?: string;      // cloud doc → fetch content on pick
  mtimeMs?: number;
  isDefault?: boolean;
}

/** Merge wiki notes + KB docs into one searchable list, de-duping synced docs
 *  (a note synced to cloud appears once, as its local note). */
export function buildWikiItems(api: WikiNotesApi, query: string): WikiItem[] {
  const q = query.trim().toLowerCase();
  const syncedToLocal = new Set(api.notes.map((n) => syncedDocId(n.path)).filter(Boolean) as string[]);
  const noteItems: WikiItem[] = api.notes.map((n) => ({
    key: 'n:' + n.path, kind: 'note', title: noteTitle(n), path: n.path, mtimeMs: n.mtimeMs,
    isDefault: n.path === api.defaultPath,
  }));
  const docItems: WikiItem[] = api.docs
    .filter((d) => !syncedToLocal.has(d.id))   // skip docs that are mirrors of a local note
    .map((d) => ({ key: 'd:' + d.id, kind: 'doc' as const, title: d.name || '未命名文档', docId: d.id }));
  let all = [...noteItems, ...docItems];
  if (q) all = all.filter((it) => it.title.toLowerCase().includes(q));
  // Default note first, then notes by recency, then docs.
  all.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'note' ? -1 : 1;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });
  return all.slice(0, 40);
}

/** Resolve what gets inserted into the composer for a picked item.
 *  note / synced-doc → its absolute path (agent reads it, cheapest + exact);
 *  cloud-only doc → a fenced content block (capped). */
export async function resolveWikiRef(it: WikiItem): Promise<string> {
  if (it.path) return it.path;
  if (it.docId) {
    try {
      const d = await smartnoteDocuments.get(it.docId);
      const body = (d.content || '').slice(0, 4000);
      return `\n\n> ${it.title}（知识库文档）\n\n${body}\n`;
    } catch { return it.title; }
  }
  return it.title;
}

const WikiRow: React.FC<{ it: WikiItem; activeKb: boolean; onPick: () => void }> = ({ it, activeKb, onPick }) => {
  const { t: tr } = useI18n();
  return (
    <button className={`v2-wiki-row${activeKb ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); onPick(); }}>
      <span className="ic">{it.kind === 'note' ? <IconNoteBook /> : <IconDocSm />}</span>
      <span className="nm">{it.title}</span>
      {it.isDefault && <span className="def" title={tr('local.wiki.defaultNote')}><IconStar /></span>}
      {it.mtimeMs ? <span className="tm">{fmtAge(it.mtimeMs, tr)}</span> : null}
      <span className="tag">{it.kind === 'note' ? tr('local.wiki.kindNote') : tr('local.wiki.kindDoc')}</span>
    </button>
  );
};

/** The list body shared by the pill panel and the @-mention popover. */
export const WikiPicker: React.FC<{
  items: WikiItem[];
  loading: boolean;
  activeIdx: number;
  onPick: (it: WikiItem) => void;
  emptyHint: string;
}> = ({ items, loading, activeIdx, onPick, emptyHint }) => {
  return (
    <div className="v2-wiki-list" role="listbox">
      {items.length === 0 ? (
        <div className="v2-wiki-empty">{loading ? '…' : emptyHint}</div>
      ) : (
        items.map((it, i) => <WikiRow key={it.key} it={it} activeKb={i === activeIdx} onPick={() => onPick(it)} />)
      )}
    </div>
  );
};

/* ================= floating peek / editor ================= */

/** 点击 wiki 条目 → 浮窗查看/编辑其文字。笔记可改并保存(写盘)；云端文档可改并 patch。
 *  顶部「引用」把它接进输入框；Esc / 点遮罩关闭。 */
const WikiPeek: React.FC<{ item: WikiItem; onClose: () => void; onInsertRef: () => void }> = ({ item, onClose, onInsertRef }) => {
  const { t: tr } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (item.path) { const c = await readNote(item.path); if (alive) setContent(c); }
        else if (item.docId) { const d = await smartnoteDocuments.get(item.docId); if (alive) setContent(d.content || ''); }
        else if (alive) setContent('');
      } catch { if (alive) setContent(''); }
      if (alive) requestAnimationFrame(() => taRef.current?.focus());
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => { alive = false; window.removeEventListener('keydown', onKey); };
  }, [item, onClose]);
  const save = useCallback(async () => {
    if (content == null) return;
    setSaving(true);
    try {
      if (item.path) await writeNote(item.path, content);
      else if (item.docId) await smartnoteDocuments.patch(item.docId, { content });
      setDirty(false);
    } catch { /* surfaced via the unsaved dot */ } finally { setSaving(false); }
  }, [content, item]);
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-wiki-peek" onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="v2-wiki-peek-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-wiki-peek-hd">
          <span className="ic">{item.kind === 'note' ? <IconNoteBook /> : <IconDocSm />}</span>
          <span className="ttl">{item.title}</span>
          {item.isDefault && <span className="def" title={tr('local.wiki.defaultNote')}><IconStar /></span>}
          {dirty && <span className="dot" title={tr('kb.unsaved')} aria-hidden />}
          <span className="grow" />
          <button className="act" onClick={onInsertRef} title={tr('local.wiki.insertRef')}><IconLink /><span>{tr('local.wiki.insertRef')}</span></button>
          <button className="act primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '…' : tr('kb.save')}</button>
          <button className="act close" onClick={onClose} title={tr('common.close')} aria-label={tr('common.close')}><IconXSm /></button>
        </div>
        <textarea
          ref={taRef}
          className="v2-wiki-peek-body"
          value={content ?? ''}
          placeholder={content == null ? '…' : tr('local.wiki.peekEmpty')}
          spellCheck={false}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); } }}
        />
      </div>
    </div>,
    host,
  );
};

/* ================= composer pill ================= */

export const WikiNotes: React.FC<{
  wiki: WikiNotesApi;
  onInsert: (text: string) => void;     // insert a wiki ref into the composer
}> = ({ wiki, onInsert }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [peek, setPeek] = useState<WikiItem | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const peekRef = useRef<WikiItem | null>(null); peekRef.current = peek;
  useEffect(() => {
    if (!open) return;
    wiki.reload();
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (e: MouseEvent) => { if (!peekRef.current && !wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !peekRef.current) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const items = useMemo(() => buildWikiItems(wiki, q), [wiki, q, wiki.notes, wiki.docs, wiki.defaultPath]);
  // 点条目 → 浮窗查看/编辑（而非直接插入）；浮窗里的「引用」才插入。@ 提及仍是直接插入。
  const openPeek = useCallback((it: WikiItem) => setPeek(it), []);
  const insertFromPeek = useCallback(async (it: WikiItem) => {
    setPeek(null); setOpen(false);
    onInsert(await resolveWikiRef(it));
  }, [onInsert]);
  if (!wiki.available) return null;
  return (
    <div className="v2-note" ref={wrapRef}>
      <button className={`v2-note-pill${open ? ' on' : ''}`} title={tr('local.wiki.openTitle')} onClick={() => setOpen((o) => !o)}>
        <IconNoteBook /><span>{tr('local.wiki.pill')}</span>
        {wiki.notes.length > 0 && <span className="badge">{wiki.notes.length}</span>}
      </button>
      {open && (
        <div className="v2-wiki-pop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="v2-wiki-pop-hd">
            <span className="ic"><IconNoteBook /></span>
            <input
              ref={inputRef}
              className="v2-wiki-search"
              value={q}
              placeholder={tr('local.wiki.searchPlaceholder')}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <WikiPicker items={items} loading={wiki.loading} activeIdx={-1} onPick={openPeek} emptyHint={tr('local.wiki.empty')} />
          <div className="v2-wiki-pop-ft">
            <span className="hint">{wiki.associated ? tr('local.wiki.assocOn') : tr('local.wiki.footHint')}</span>
            {wiki.associated && (
              <button className="loc reset" onClick={() => wiki.resetDefault()} title={tr('local.wiki.resetTip')}>{tr('local.wiki.reset')}</button>
            )}
            <button className="loc" onClick={() => void wiki.associateDefault()} title={tr('local.wiki.relocateTip')}>
              <IconLink /><span>{tr('local.wiki.relocate')}</span>
            </button>
          </div>
        </div>
      )}
      {peek && <WikiPeek item={peek} onClose={() => setPeek(null)} onInsertRef={() => void insertFromPeek(peek)} />}
    </div>
  );
};

export type { NoteKind };
