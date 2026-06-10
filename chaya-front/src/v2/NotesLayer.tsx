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
const IconSearchSm = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);

/* inspector 拖宽：读写根节点 --wiki-w；持久化到 localStorage。clamp 与原型同量级。 */
const WIKI_W_KEY = 'chaya_wiki_w';
const WIKI_W_MIN = 320;
const WIKI_W_MAX = 680;

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

type DefaultActions = { associated: boolean; onAssociate: () => void; onReset: () => void };
const WikiRow: React.FC<{ it: WikiItem; activeKb: boolean; onPick: () => void; defaultActions?: DefaultActions }> = ({ it, activeKb, onPick, defaultActions }) => {
  const { t: tr } = useI18n();
  return (
    <div className={`v2-wiki-row${activeKb ? ' on' : ''}`} role="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); onPick(); }}>
      <span className="ic">{it.kind === 'note' ? <IconNoteBook /> : <IconDocSm />}</span>
      <span className="nm">{it.title}</span>
      {it.isDefault && <span className="def" title={tr('local.wiki.defaultNote')}><IconStar /></span>}
      {it.mtimeMs ? <span className="tm">{fmtAge(it.mtimeMs, tr)}</span> : null}
      {it.isDefault && defaultActions ? (
        // 速记的本地关联控件直接挂在这一行（不再占底部一条 bar）。
        <span className="v2-wiki-row-act" onMouseDown={(e) => e.stopPropagation()}>
          {defaultActions.associated && (
            <button className="loc reset" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); defaultActions.onReset(); }} title={tr('local.wiki.resetTip')}>{tr('local.wiki.reset')}</button>
          )}
          <button className="loc" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); defaultActions.onAssociate(); }} title={tr('local.wiki.relocateTip')}><IconLink /></button>
        </span>
      ) : (
        <span className="tag">{it.kind === 'note' ? tr('local.wiki.kindNote') : tr('local.wiki.kindDoc')}</span>
      )}
    </div>
  );
};

/** The list body shared by the pill panel and the @-mention popover. */
export const WikiPicker: React.FC<{
  items: WikiItem[];
  loading: boolean;
  activeIdx: number;
  onPick: (it: WikiItem) => void;
  emptyHint: string;
  defaultActions?: DefaultActions;     // 速记行内联的本地关联控件(仅 wiki 抽屉传，@提及不传)
}> = ({ items, loading, activeIdx, onPick, emptyHint, defaultActions }) => {
  return (
    <div className="v2-wiki-list" role="listbox">
      {items.length === 0 ? (
        <div className="v2-wiki-empty">{loading ? '…' : emptyHint}</div>
      ) : (
        items.map((it, i) => <WikiRow key={it.key} it={it} activeKb={i === activeIdx} onPick={() => onPick(it)} defaultActions={it.isDefault ? defaultActions : undefined} />)
      )}
    </div>
  );
};

/* ================= floating peek / editor ================= */

const IconBack = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
);

/** 块文本是可编辑 textarea，没法对子串内联渲染成链接 → 用 Cmd/Ctrl + 点击：按光标位置找出
 *  所在的 http(s) URL token，用系统默认浏览器打开（window.open → main 的 setWindowOpenHandler
 *  → shell.openExternal）。命中返回 true。 */
const NOTE_URL_RE = /https?:\/\/[^\s<>"'`]+/g;
function openUrlAtCaret(el: HTMLTextAreaElement): boolean {
  const pos = el.selectionStart ?? 0;
  const text = el.value;
  NOTE_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTE_URL_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');   // 去掉尾随标点
      try { window.open(url, '_blank', 'noopener'); } catch { /* */ }
      return true;
    }
  }
  return false;
}

/** 外链图标（URL hover 时浮现在链接右侧，点了用默认浏览器打开）。 */
const IconExtLink = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" width="11" height="11" aria-hidden>
    <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
  </svg>
);
function noteHasUrl(text: string): boolean { NOTE_URL_RE.lastIndex = 0; return NOTE_URL_RE.test(text); }
/** 把纯文本切成「文字 + 链接」节点：链接加下划线、hover 显外链图标，点击打开默认浏览器。 */
function linkifyNote(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  NOTE_URL_RE.lastIndex = 0;
  let last = 0; let k = 0; let m: RegExpExecArray | null;
  while ((m = NOTE_URL_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) out.push(text.slice(last, start));
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const trail = m[0].slice(url.length);
    out.push(
      <a key={`u${k++}`} className="note-url" href={url}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); try { window.open(url, '_blank', 'noopener'); } catch { /* */ } }}
      >{url}<span className="note-url-go" aria-hidden><IconExtLink /></span></a>,
    );
    if (trail) out.push(trail);
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 抽屉内联文档视图：读/编辑/保存/引用。笔记写盘；云端文档 patch。无遮罩/portal —— 直接铺在
 *  右侧抽屉里(替代旧的居中浮窗)，看完点返回回到列表。 */
/* ---- Notion 式块编辑器：blocks 数组模型，序列化为 markdown
   (文本/标题/待办/项目符号/引用/分割线/图片/表格/代码) ---- */
type Pri = 'today' | 'normal';
type Block =
  | { id: string; type: 'text' | 'h1' | 'h2' | 'h3' | 'quote' | 'bullet'; text: string }
  | { id: string; type: 'todo'; text: string; done: boolean; pri: Pri }
  | { id: string; type: 'divider' }
  | { id: string; type: 'image'; src: string; alt: string }
  | { id: string; type: 'code'; lang: string; text: string }
  | { id: string; type: 'table'; rows: string[][] };
type BType = Block['type'];
let __bid = 0;
const newId = () => `b${++__bid}`;
const TEXTLIKE = new Set<BType>(['text', 'h1', 'h2', 'h3', 'quote', 'bullet', 'todo']);
const blkText = (b: Block): string => ('text' in b ? b.text : '');

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function parseSingle(line: string): Block {
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return { id: newId(), type: 'divider' };
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^(#{1,3})\s+(.*)$/))) return { id: newId(), type: (m[1].length === 1 ? 'h1' : m[1].length === 2 ? 'h2' : 'h3'), text: m[2] };
  if ((m = line.match(/^\s*- \[([ xX])\]\s?(.*)$/))) { let text = m[2]; let pri: Pri = 'normal'; const pm = text.match(/\s*@today\s*$/); if (pm) { pri = 'today'; text = text.slice(0, pm.index); } return { id: newId(), type: 'todo', text, done: m[1].toLowerCase() === 'x', pri }; }
  if ((m = line.match(/^\s*[-*]\s+(.*)$/))) return { id: newId(), type: 'bullet', text: m[1] };
  if ((m = line.match(/^>\s?(.*)$/))) return { id: newId(), type: 'quote', text: m[1] };
  return { id: newId(), type: 'text', text: line };
}
function parseMd(md: string): Block[] {
  const ls = md.split('\n'); const out: Block[] = []; let i = 0;
  while (i < ls.length) {
    const line = ls[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) { const lang = fence[1] || ''; const buf: string[] = []; i++; while (i < ls.length && !/^```\s*$/.test(ls[i])) { buf.push(ls[i]); i++; } i++; out.push({ id: newId(), type: 'code', lang, text: buf.join('\n') }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { const tl: string[] = []; while (i < ls.length && /^\s*\|.*\|\s*$/.test(ls[i])) { tl.push(ls[i]); i++; } const rows = tl.map(splitRow).filter((r) => !r.every((c) => /^:?-+:?$/.test(c))); out.push({ id: newId(), type: 'table', rows: rows.length ? rows : [['', ''], ['', '']] }); continue; }
    const im = line.match(/^!\[([^\]]*)\]\(([^)]*)\)\s*$/);
    if (im) { out.push({ id: newId(), type: 'image', alt: im[1], src: im[2] }); i++; continue; }
    out.push(parseSingle(line)); i++;
  }
  if (!out.length) out.push({ id: newId(), type: 'text', text: '' });
  return out;
}
function fmtSingle(b: Block): string {
  switch (b.type) {
    case 'divider': return '---';
    case 'h1': return `# ${b.text}`;
    case 'h2': return `## ${b.text}`;
    case 'h3': return `### ${b.text}`;
    case 'quote': return `> ${b.text}`;
    case 'bullet': return `- ${b.text}`;
    case 'todo': return `- [${b.done ? 'x' : ' '}] ${b.text}${b.pri === 'today' ? ' @today' : ''}`;
    default: return blkText(b);
  }
}
function serialize(blocks: Block[]): string {
  return blocks.map((b) => {
    if (b.type === 'image') return `![${b.alt}](${b.src})`;
    if (b.type === 'code') return '```' + b.lang + '\n' + b.text + '\n```';
    if (b.type === 'table') {
      const rows = b.rows.length ? b.rows : [['', '']];
      const head = rows[0]; const sep = head.map(() => '---');
      return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
    }
    return fmtSingle(b);
  }).join('\n');
}

const BLOCK_MENU: { type: BType; key: string; glyph: string }[] = [
  { type: 'text', key: 'local.wiki.block.text', glyph: 'Aa' },
  { type: 'h1', key: 'local.wiki.block.h1', glyph: 'H1' },
  { type: 'h2', key: 'local.wiki.block.h2', glyph: 'H2' },
  { type: 'h3', key: 'local.wiki.block.h3', glyph: 'H3' },
  { type: 'todo', key: 'local.wiki.block.todo', glyph: '☑' },
  { type: 'bullet', key: 'local.wiki.block.bullet', glyph: '•' },
  { type: 'quote', key: 'local.wiki.block.quote', glyph: '❝' },
  { type: 'image', key: 'local.wiki.block.image', glyph: 'IMG' },
  { type: 'table', key: 'local.wiki.block.table', glyph: '▦' },
  { type: 'code', key: 'local.wiki.block.code', glyph: '</>' },
  { type: 'divider', key: 'local.wiki.block.divider', glyph: '—' },
];
const IconCheck = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.2 3.2L13 4.5" /></svg>
);
const IconPlusSm = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3.5v9M3.5 8h9" /></svg>
);
const IconGrip = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="6" cy="4" r="1.1" /><circle cx="10" cy="4" r="1.1" /><circle cx="6" cy="8" r="1.1" /><circle cx="10" cy="8" r="1.1" /><circle cx="6" cy="12" r="1.1" /><circle cx="10" cy="12" r="1.1" /></svg>
);

const WikiDocView: React.FC<{ item: WikiItem; onBack: () => void; onInsertRef: () => void }> = ({ item, onBack, onInsertRef }) => {
  const { t: tr } = useI18n();
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState<{ i: number; mode: 'turn' | 'slash'; x: number; y: number; q: string; active: number } | null>(null);
  const [overI, setOverI] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const menuItems = (q: string) => BLOCK_MENU.filter((bt) => { const s = q.toLowerCase(); return !s || tr(bt.key).toLowerCase().includes(s) || bt.type.includes(s); });
  const refs = useRef<Map<string, HTMLTextAreaElement | null>>(new Map());
  const dragRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendImg = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let md = '';
      try {
        if (item.path) md = await readNote(item.path);
        else if (item.docId) { const d = await smartnoteDocuments.get(item.docId); md = d.content || ''; }
      } catch { /* */ }
      if (!alive) return;
      const parsed = parseMd(md);
      // 类 Notion：开头总留一个空块，方便随手在最上面插入内容(幂等:已是空块就不再加;
      // 不标记 dirty —— 没真用就不污染文件)。
      if (!(parsed[0] && parsed[0].type === 'text' && parsed[0].text === '')) parsed.unshift({ id: newId(), type: 'text', text: '' });
      setBlocks(parsed);
      requestAnimationFrame(() => refs.current.get(parsed[0]?.id)?.focus());
    })();
    return () => { alive = false; };
  }, [item]);
  const save = useCallback(async () => {
    if (!blocks) return; setSaving(true);
    const md = serialize(blocks);
    try {
      if (item.path) await writeNote(item.path, md);
      else if (item.docId) await smartnoteDocuments.patch(item.docId, { content: md });
      setDirty(false);
    } catch { /* unsaved dot */ } finally { setSaving(false); }
  }, [blocks, item]);

  const focusAt = (id: string, caret?: number) => requestAnimationFrame(() => { const el = refs.current.get(id); if (el) { el.focus(); if (caret != null) { try { el.setSelectionRange(caret, caret); } catch { /* */ } } } });
  const replace = (i: number, nb: Block, focus = false, caret?: number) => { setBlocks((p) => { if (!p) return p; const a = [...p]; a[i] = nb; return a; }); setDirty(true); if (focus) focusAt(nb.id, caret); };
  const patch = (i: number, fields: Partial<Block>) => setBlocks((p) => { if (!p) return p; const a = [...p]; a[i] = { ...a[i], ...fields } as Block; return a; });
  const insertAfter = (i: number, nb: Block) => { setBlocks((p) => { const a = [...(p || [])]; a.splice(i + 1, 0, nb); return a; }); setDirty(true); focusAt(nb.id, 0); };
  const removeAt = (i: number) => { setBlocks((p) => { if (!p) return p; const a = [...p]; a.splice(i, 1); if (!a.length) a.push({ id: newId(), type: 'text', text: '' }); return a; }); setDirty(true); };
  const move = (from: number, to: number) => { setBlocks((p) => { if (!p || from === to) return p; const a = [...p]; const [m] = a.splice(from, 1); a.splice(from < to ? to - 1 : to, 0, m); return a; }); setDirty(true); };

  const openMenu = (e: { currentTarget: EventTarget | null }, i: number, mode: 'turn' | 'slash') => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu({ i, mode, x: r.left, y: r.bottom + 4, q: '', active: 0 }); };
  const pickType = (type: BType) => {
    if (!menu) return; const { i, mode } = menu; setMenu(null);
    setBlocks((p) => {
      if (!p) return p; const a = [...p]; const cur = a[i]; const id = cur.id; const keep = mode === 'turn' ? blkText(cur) : '';
      let nb: Block;
      switch (type) {
        case 'divider': nb = { id, type: 'divider' }; break;
        case 'image': nb = { id, type: 'image', src: '', alt: '' }; pendImg.current = id; break;
        case 'table': nb = { id, type: 'table', rows: [['', ''], ['', '']] }; break;
        case 'code': nb = { id, type: 'code', lang: '', text: keep }; break;
        case 'todo': nb = { id, type: 'todo', text: keep, done: false, pri: 'normal' }; break;
        default: nb = { id, type, text: keep } as Block;
      }
      a[i] = nb; return a;
    });
    setDirty(true);
    if (type === 'image') requestAnimationFrame(() => fileRef.current?.click());
    else if (type !== 'divider' && type !== 'table') { const b = blocks?.[i]; if (b) focusAt(b.id, 0); }
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; const id = pendImg.current; pendImg.current = null;
    if (!f || !id) return;
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result || ''); setBlocks((p) => p ? p.map((bl) => (bl.id === id && bl.type === 'image') ? { ...bl, src: url } : bl) : p); setDirty(true); };
    reader.readAsDataURL(f);
  };
  const editCell = (i: number, r: number, c: number, val: string) => setBlocks((p) => { if (!p) return p; const a = [...p]; const t = a[i]; if (t.type !== 'table') return p; const rows = t.rows.map((row) => [...row]); rows[r][c] = val; a[i] = { ...t, rows }; return a; });
  const addRow = (i: number) => { setBlocks((p) => { if (!p) return p; const a = [...p]; const t = a[i]; if (t.type !== 'table') return p; const cols = (t.rows[0] || ['']).length; a[i] = { ...t, rows: [...t.rows, Array(cols).fill('')] }; return a; }); setDirty(true); };
  const addCol = (i: number) => { setBlocks((p) => { if (!p) return p; const a = [...p]; const t = a[i]; if (t.type !== 'table') return p; a[i] = { ...t, rows: t.rows.map((row) => [...row, '']) }; return a; }); setDirty(true); };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>, i: number) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); return; }
    // slash 菜单打开时：上下选、回车确认、Esc 关闭(其余按键照常输入 → 实时筛选)。
    if (menu && menu.mode === 'slash' && menu.i === i) {
      const filt = menuItems(menu.q);
      if (e.key === 'ArrowDown') { e.preventDefault(); setMenu((m) => m ? { ...m, active: Math.min(m.active + 1, Math.max(0, filt.length - 1)) } : m); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMenu((m) => m ? { ...m, active: Math.max(0, m.active - 1) } : m); return; }
      if (e.key === 'Enter') { e.preventDefault(); const pk = filt[menu.active] || filt[0]; if (pk) pickType(pk.type); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if (!blocks) return; const b = blocks[i]; if (!TEXTLIKE.has(b.type)) return;
    const ta = e.currentTarget; const text = blkText(b);
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const caret = ta.selectionStart ?? text.length;
      if ((b.type === 'todo' || b.type === 'bullet') && !text) { replace(i, { id: b.id, type: 'text', text: '' }, true, 0); return; }
      const before = text.slice(0, caret), after = text.slice(caret);
      const contType: BType = (b.type === 'todo' || b.type === 'bullet' || b.type === 'quote') ? b.type : 'text';
      patch(i, { text: before } as Partial<Block>);
      const nb: Block = contType === 'todo' ? { id: newId(), type: 'todo', text: after, done: false, pri: (b as any).pri || 'normal' } : { id: newId(), type: contType, text: after } as Block;
      insertAfter(i, nb);
    } else if (e.key === 'Backspace' && (ta.selectionStart ?? 0) === 0 && (ta.selectionEnd ?? 0) === 0) {
      if (b.type !== 'text') { e.preventDefault(); replace(i, { id: b.id, type: 'text', text }, true, 0); return; }
      if (i > 0) {
        const prev = blocks[i - 1];
        e.preventDefault();
        if (!TEXTLIKE.has(prev.type)) { removeAt(i - 1); return; }
        const j = blkText(prev).length;
        setBlocks((p) => { if (!p) return p; const a = [...p]; a[i - 1] = { ...a[i - 1], text: blkText(prev) + text } as Block; a.splice(i, 1); return a; });
        setDirty(true); focusAt(prev.id, j);
      }
    }
  };

  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return (
    <div className="v2-wiki-doc">
      <div className="v2-wiki-doc-hd">
        <button className="back" onClick={onBack} title={tr('common.back')} aria-label={tr('common.back')}><IconBack /></button>
        <span className="ic">{item.kind === 'note' ? <IconNoteBook /> : <IconDocSm />}</span>
        <span className="ttl">{item.title}</span>
        {item.isDefault && <span className="def" title={tr('local.wiki.defaultNote')}><IconStar /></span>}
        {dirty && <span className="dot" title={tr('kb.unsaved')} aria-hidden />}
        <span className="grow" />
        <button className="act" onClick={onInsertRef} title={tr('local.wiki.insertRef')}><IconLink /></button>
        <button className="act primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? '…' : tr('kb.save')}</button>
      </div>
      {blocks == null ? (
        <div className="v2-wiki-doc-body v2-blocks"><div className="blk t-text"><span className="blk-body" style={{ color: 'var(--c-ink-4)' }}>{'…'}</span></div></div>
      ) : (
        <div className="v2-wiki-doc-body v2-blocks" onDragOver={(e) => e.preventDefault()}>
          {blocks.map((b, i) => (
            <div
              className={`blk t-${b.type}${(b as any).done ? ' done' : ''}${overI === i ? ' over' : ''}`} key={b.id}
              onDragOver={(e) => { e.preventDefault(); if (dragRef.current != null) setOverI(i); }}
              onDrop={() => { if (dragRef.current != null) move(dragRef.current, i); dragRef.current = null; setOverI(null); }}
            >
              <div className="blk-ctl">
                <button className="blk-add" onClick={() => insertAfter(i, { id: newId(), type: 'text', text: '' })} title={tr('local.wiki.block.add')} aria-label={tr('local.wiki.block.add')}><IconPlusSm /></button>
                <button className="blk-grip" draggable title={tr('local.wiki.block.menu')} aria-label={tr('local.wiki.block.menu')}
                  onDragStart={(e) => { dragRef.current = i; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch { /* */ } }}
                  onDragEnd={() => { dragRef.current = null; setOverI(null); }}
                  onClick={(e) => openMenu(e, i, 'turn')}><IconGrip /></button>
              </div>
              {b.type === 'divider' ? (
                <div className="blk-main"><hr className="blk-hr" /></div>
              ) : b.type === 'image' ? (
                <div className="blk-main blk-imgwrap">
                  {b.src ? (
                    <figure className="blk-img">
                      <img src={b.src} alt={b.alt} />
                      <input className="cap" value={b.alt} placeholder={tr('local.wiki.block.caption')} onChange={(e) => patch(i, { alt: e.target.value } as Partial<Block>)} />
                    </figure>
                  ) : (
                    <button className="blk-img-empty" onClick={() => { pendImg.current = b.id; fileRef.current?.click(); }}>{tr('local.wiki.block.addImage')}</button>
                  )}
                </div>
              ) : b.type === 'table' ? (
                <div className="blk-main blk-tblwrap">
                  <table className="blk-tbl"><tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r} className={r === 0 ? 'hd' : ''}>
                        {row.map((cell, c) => (
                          <td key={c}><input value={cell} placeholder={r === 0 ? tr('local.wiki.block.colHd') : ''} onChange={(e) => editCell(i, r, c, e.target.value)} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody></table>
                  <div className="blk-tbl-acts">
                    <button onClick={() => addRow(i)} title={tr('local.wiki.block.addRow')}>+ {tr('local.wiki.block.row')}</button>
                    <button onClick={() => addCol(i)} title={tr('local.wiki.block.addCol')}>+ {tr('local.wiki.block.col')}</button>
                  </div>
                </div>
              ) : b.type === 'code' ? (
                <div className="blk-main blk-codewrap">
                  <textarea ref={(el) => { refs.current.set(b.id, el); }} className="blk-code-body" rows={2} spellCheck={false} value={b.text}
                    placeholder={tr('local.wiki.block.codePh')}
                    onChange={(e) => patch(i, { text: e.target.value } as Partial<Block>)}
                    onClick={(e) => { if ((e.metaKey || e.ctrlKey) && openUrlAtCaret(e.currentTarget)) e.preventDefault(); }}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); } }} />
                </div>
              ) : (
                <div className="blk-main">
                  {b.type === 'todo' && (
                    <button className="blk-check" onClick={() => patch(i, { done: !b.done } as Partial<Block>)} title={tr('local.wiki.todo.toggle')} aria-label={tr('local.wiki.todo.toggle')}>{b.done ? <IconCheck /> : null}</button>
                  )}
                  {b.type === 'bullet' && <span className="blk-bul" aria-hidden>{'•'}</span>}
                  {/* 始终包一层 .blk-textwrap（textarea 位置固定，编辑中输入/删除 URL 不丢焦点）；
                      含 URL 时再叠一层可读 backdrop（下划线 + hover 外链图标），textarea 文字转透明只留光标。 */}
                  {(() => {
                    const urlMode = noteHasUrl(blkText(b));
                    return (
                      <div className="blk-textwrap">
                        {urlMode && <div key="back" className="blk-body blk-back" aria-hidden>{linkifyNote(blkText(b))}</div>}
                        <textarea key="ta" ref={(el) => { refs.current.set(b.id, el); }} className={`blk-body${urlMode ? ' blk-fore' : ''}`} rows={1} spellCheck={false}
                          value={blkText(b)}
                          placeholder={(focusId === b.id || blocks.length === 1) && !blkText(b) ? tr('local.wiki.blockPlaceholder') : ''}
                          onFocus={() => setFocusId(b.id)}
                          onBlur={() => setFocusId((f) => (f === b.id ? null : f))}
                          onClick={(e) => { if ((e.metaKey || e.ctrlKey) && openUrlAtCaret(e.currentTarget)) e.preventDefault(); }}
                          onChange={(e) => {
                            const v = e.target.value; patch(i, { text: v } as Partial<Block>); setDirty(true);
                            if (b.type === 'text' && v.startsWith('/')) { const r = e.currentTarget.getBoundingClientRect(); setMenu({ i, mode: 'slash', x: r.left, y: r.bottom + 4, q: v.slice(1), active: 0 }); }
                            else setMenu((m) => (m && m.mode === 'slash' && m.i === i) ? null : m);
                          }}
                          onKeyDown={(e) => onKey(e, i)} />
                      </div>
                    );
                  })()}
                  {b.type === 'todo' && (
                    <button className={`blk-pri pri-${b.pri}`} onClick={() => patch(i, { pri: b.pri === 'today' ? 'normal' : 'today' } as Partial<Block>)} title={tr('local.wiki.todo.priTip')}>{b.pri === 'today' ? tr('local.wiki.todo.today') : tr('local.wiki.todo.normal')}</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      {menu && createPortal(
        <>
          <div className="blk-menu-mask" onMouseDown={() => setMenu(null)} />
          <div className="blk-menu" style={{ left: Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 220), top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            {(() => { const its = menuItems(menu.q); return its.length ? its.map((bt, mi) => (
              <button key={bt.type} className={`blk-menu-item${mi === menu.active ? ' active' : ''}`} onMouseEnter={() => setMenu((m) => m ? { ...m, active: mi } : m)} onClick={() => pickType(bt.type)}>
                <span className="g">{bt.glyph}</span><span className="l">{tr(bt.key)}</span>
              </button>
            )) : <div className="blk-menu-empty">{tr('local.wiki.empty')}</div>; })()}
            {menu.mode === 'turn' && (
              <button className="blk-menu-item del" onClick={() => removeAt(menu.i)}><span className="g">{'✕'}</span><span className="l">{tr('common.delete')}</span></button>
            )}
          </div>
        </>,
        host,
      )}
    </div>
  );
};


/* ================= composer pill ================= */

export const WikiNotes: React.FC<{
  wiki: WikiNotesApi;
  onInsert: (text: string) => void;     // insert a wiki ref into the composer
  isActive?: boolean;                   // 是否当前激活的窗格：只有它响应顶栏的 wiki 开关
}> = ({ wiki, onInsert, isActive = true }) => {
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
    // 与代码改动列改为「上下分屏」共存，不再互斥让位。只管 Esc：先退文档视图，再关抽屉。
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (peekRef.current) setPeek(null); else setOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // wiki 开关已移到顶栏右上角（与代码列同区）：只有激活窗格响应。detail.open 显式设值，否则翻转。
  useEffect(() => {
    if (!isActive || !wiki.available) return;
    const onToggle = (e: Event) => {
      const v = (e as CustomEvent).detail?.open;
      setOpen((o) => (typeof v === 'boolean' ? v : !o));
    };
    window.addEventListener('chaya:wiki-toggle', onToggle as EventListener);
    return () => window.removeEventListener('chaya:wiki-toggle', onToggle as EventListener);
  }, [isActive, wiki.available]);
  // 切走该窗格 → 关掉它的 wiki（避免非激活窗格的抽屉残留在 inspector 列里叠加）。
  useEffect(() => { if (!isActive) setOpen(false); }, [isActive]);
  // 把开合状态回报给外壳（顶栏按钮高亮）：仅激活窗格的状态可信。
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('chaya:wiki-open', { detail: { open, active: isActive } }));
  }, [open, isActive]);
  // 打开时给根节点打 data-wiki-right：CSS 据此把 grid 第三列(--insp-w)展开到 --wiki-w
  // （main 1fr 自动让位，侧栏保持可见）。同时回填上次拖出的宽度。
  useEffect(() => {
    const root = typeof document !== 'undefined' ? (document.querySelector('.chaya-v2') as HTMLElement | null) : null;
    if (!root) return;
    if (open) {
      const saved = Number(localStorage.getItem(WIKI_W_KEY));
      if (saved >= WIKI_W_MIN && saved <= WIKI_W_MAX) root.style.setProperty('--wiki-w', `${saved}px`);
      root.setAttribute('data-wiki-right', 'on');
    } else {
      root.removeAttribute('data-wiki-right');
    }
    return () => root.removeAttribute('data-wiki-right');
  }, [open]);
  // 左缘拖宽：mousemove 改根节点 --wiki-w（同时驱动 grid --insp-w），拖动期间关列宽过渡跟手。
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const root = document.querySelector('.chaya-v2') as HTMLElement | null;
    const app = document.querySelector('.chaya-v2 .v2-app') as HTMLElement | null;
    if (!root) return;
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(root).getPropertyValue('--wiki-w')) || 440;
    app?.classList.add('wiki-dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      // 向左拖 → 更宽（抽屉贴右缘）。
      const w = Math.max(WIKI_W_MIN, Math.min(WIKI_W_MAX, startW + (startX - ev.clientX)));
      root.style.setProperty('--wiki-w', `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      app?.classList.remove('wiki-dragging');
      document.body.style.cursor = '';
      const w = parseFloat(getComputedStyle(root).getPropertyValue('--wiki-w'));
      if (w) localStorage.setItem(WIKI_W_KEY, String(Math.round(w)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  const items = useMemo(() => buildWikiItems(wiki, q), [wiki, q, wiki.notes, wiki.docs, wiki.defaultPath]);
  // 点条目 → 在抽屉内联打开查看/编辑；其「引用」才插入。@ 提及仍是直接插入。
  const openPeek = useCallback((it: WikiItem) => setPeek(it), []);
  const insertFromPeek = useCallback(async (it: WikiItem) => {
    setPeek(null); setOpen(false);
    onInsert(await resolveWikiRef(it));
  }, [onInsert]);
  if (!wiki.available) return null;
  // 检视列下半槽（与代码改动上半分屏）。退化到整列 / 根 / body。
  const host: Element = (typeof document !== 'undefined'
    && (document.getElementById('v2-inspector-note') || document.getElementById('v2-inspector-slot') || document.querySelector('.chaya-v2'))) || document.body;
  return (
    <div className="v2-note" ref={wrapRef}>
      {/* 触发按钮已移到顶栏右上角（ClientShell），这里只保留 portal 出来的右侧抽屉。 */}
      {open && createPortal(
        <>
          {/* wiki 作为右侧检视栏(grid 第三列)，与主界面平行（非浮层遮罩）：侧栏保持可见，
              main 1fr 让位，边用边看；左缘可拖宽。与全屏库同形（标题 + 模式标签 + 搜索）。 */}
          <aside className="v2-wiki-drawer" role="region" aria-label={tr('local.wiki.pill')} onMouseDown={(e) => e.stopPropagation()}>
            <div className="v2-wiki-grip" onMouseDown={startResize} title="" aria-hidden />
            <div className="v2-wiki-drawer-hd">
              <span className="ic"><IconNoteBook /></span>
              <span className="ttl-tx">{tr('local.wiki.pill')}</span>
              <span className="mode-tag">{tr('local.wiki.modeQuote')}</span>
              <span className="grow" />
              <button className="x" onClick={() => setOpen(false)} title={tr('common.close')} aria-label={tr('common.close')}><IconXSm /></button>
            </div>
            <div className="v2-wiki-search-row">
              <span className="ic"><IconSearchSm /></span>
              <input
                ref={inputRef}
                className="v2-wiki-search"
                value={q}
                placeholder={tr('local.wiki.searchPlaceholder')}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            {peek ? (
              <WikiDocView item={peek} onBack={() => setPeek(null)} onInsertRef={() => void insertFromPeek(peek)} />
            ) : (
              <div className="v2-wiki-drawer-list">
                <WikiPicker
                  items={items} loading={wiki.loading} activeIdx={-1} onPick={openPeek}
                  emptyHint={tr('local.wiki.empty')}
                  defaultActions={{ associated: wiki.associated, onAssociate: () => void wiki.associateDefault(), onReset: () => wiki.resetDefault() }}
                />
              </div>
            )}
          </aside>
        </>,
        host,
      )}
    </div>
  );
};

export type { NoteKind };
