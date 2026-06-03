/**
 * 选区延伸：笔记 + 衍生触发。纯前端、与后端无关。
 *
 *  - useNotes(cwd)：目录唯一笔记（localStorage，按 cwd）。
 *  - <SelectionToolbar>：在会话里选中文字 → 浮出「展开讲讲 / 笔记」工具条。
 *      Portal 到 .chaya-v2 根：fixed 定位必须脱离带 backdrop-filter/transform 的祖先。
 *  - <LocalNotes>：composer 里的笔记 pill（角标计数）+ 上展弹层，锚定 .v2-box。
 *
 * 配色走 theme token（--c-note* / --c-accent*），明暗双主题自动适配。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import { loadNotesByCwd, saveNotesByCwd, type NoteItem, type NoteKind } from './services/localAgent';

const EMPTY_NOTES: NoteItem[] = [];

// Notes captured from the CLI are usually markdown (AI prose, lists, code).
// Render them so they read the way they did in the transcript — links open
// out of the app, wide tables scroll locally instead of bursting the popover.
const NOTE_MD_COMPONENTS = {
  a: ({ node: _n, ...p }: any) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...p }: any) => <div className="v2-note-xscroll"><table {...p} /></div>,
} as React.ComponentProps<typeof ReactMarkdown>['components'];

const NoteMd: React.FC<{ text: string }> = ({ text }) => (
  <div className="tx v2-note-md">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={NOTE_MD_COMPONENTS}>{text}</ReactMarkdown>
  </div>
);

// 线性图标，匹配 app 的 24×24 / 1.6–1.8 stroke 风格（同 LocalAgentView 的本地图标）。
const IconNoteBook = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7z" /><path d="M7 3.5v17" />
    <path d="M10.5 8.5h4.5M10.5 12.5h4.5M10.5 16.5h2.5" />
  </svg>
);
const IconBookmark = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h12v17l-6-4.2-6 4.2z" /></svg>
);
const IconTerminalSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7.5 9.5l3 2.5-3 2.5M13 14.5h4" /></svg>
);
const IconSendSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
const IconCopySm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
);
const IconCheckSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
);
const IconExpandSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4.5H4.5V9M15 4.5h4.5V9M9 19.5H4.5V15M15 19.5h4.5V15" /></svg>
);
const IconTrashSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 7h15M9 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 18 5.5V7M6.5 7l.7 11.5a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4L18.5 7" /></svg>
);
const IconCloseSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);

/** Relative age, reusing the shared local.time.* dictionary (mirrors fmtTime in
 *  LocalAgentView). Takes the live translator so it tracks the language switch. */
function fmtNoteAge(ms: number, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return tr('local.time.justNow');
  if (diff < 3600_000) return tr('local.time.minutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return tr('local.time.hours', { n: Math.floor(diff / 3600_000) });
  if (diff < 30 * 86400_000) return tr('local.time.days', { n: Math.floor(diff / 86400_000) });
  if (diff < 365 * 86400_000) return tr('local.time.months', { n: Math.floor(diff / (30 * 86400_000)) });
  return tr('local.time.years', { n: Math.floor(diff / (365 * 86400_000)) });
}

// In the compact popover, tall notes clamp to a preview; the panel shows them full.
const NOTE_CLAMP_PX = 104;

/** One captured note: kind + age + copy/delete on a quiet top rail. In the
 *  compact popover the markdown clamps to a preview (with a "展开全文" that opens
 *  the full panel); in the panel it renders full at comfortable reading size.
 *  Actions hide until hover (calm). */
const NoteCard: React.FC<{
  note: NoteItem;
  kindLabel: (k: NoteKind) => string;
  onRemove: () => void;
  onOpen?: () => void;          // compact only: open the full notes panel
  variant?: 'compact' | 'full';
}> = ({ note, kindLabel, onRemove, onOpen, variant = 'compact' }) => {
  const { t: tr } = useI18n();
  const full = variant === 'full';
  // Measure the UNCLAMPED inner content, not the clamp box: once the clamp
  // overflows its height pins at the max, so a ResizeObserver on it would miss
  // late reflows (markdown / web-font load) and the affordance would never show.
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (full) return;           // panel never clamps, so no need to measure
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollHeight > NOTE_CLAMP_PX + 6);
    measure();
    const raf = requestAnimationFrame(measure);   // re-measure after first layout pass
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el); }
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [note.text, full]);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(note.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — no-op */ }
  };
  return (
    <div className={`v2-note-item${full ? ' full' : ''}`}>
      <div className="v2-note-meta">
        <span className="kind">{kindLabel(note.kind)}</span>
        {note.at ? <span className="time">{fmtNoteAge(note.at, tr)}</span> : null}
        <span className="grow" />
        <button className="act" title={copied ? tr('local.note.copied') : tr('local.note.copy')} aria-label={tr('local.note.copy')} onClick={copy}>
          {copied ? <IconCheckSm /> : <IconCopySm />}
        </button>
        <button className="act rm" title={tr('local.note.remove')} aria-label={tr('local.note.remove')} onClick={onRemove}>
          <IconTrashSm />
        </button>
      </div>
      {full ? (
        <div className="v2-note-read"><NoteMd text={note.text} /></div>
      ) : (
        <>
          <div className="v2-note-clamp" style={{ maxHeight: overflow ? NOTE_CLAMP_PX : undefined }}>
            <div ref={contentRef}>
              <NoteMd text={note.text} />
            </div>
            {overflow && <span className="v2-note-fade" aria-hidden="true" />}
          </div>
          {overflow && onOpen && (
            <button className="v2-note-more" onClick={onOpen}>
              <span>{tr('local.note.viewFull')}</span>
              <IconExpandSm />
            </button>
          )}
        </>
      )}
    </div>
  );
};

/** The notes panel, expanded — a card the width of the reading column, portaled
 *  to the app root, listing every note in full so they read clearly. Esc /
 *  backdrop closes; shares the same add input as the popover. */
const NotesPanel: React.FC<{
  api: NotesApi;
  projectName: string;
  kindLabel: (k: NoteKind) => string;
  onClose: () => void;
}> = ({ api, projectName, kindLabel, onClose }) => {
  const { t: tr } = useI18n();
  const [draft, setDraft] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const submit = () => { if (draft.trim()) { api.add(draft, 'manual'); setDraft(''); } };
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-note-panel" onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="v2-note-panel-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-note-panel-hd">
          <span className="ic"><IconNoteBook /></span>
          <span className="ttl">{tr('local.note.title')} · <b>{projectName}</b></span>
          <span className="cnt">{api.notes.length}</span>
          <span className="grow" />
          <button className="act close" onClick={onClose} title={tr('common.close')} aria-label={tr('common.close')}>
            <IconCloseSm />
          </button>
        </div>
        <div className="v2-note-panel-body">
          {api.notes.length === 0 ? (
            <div className="v2-note-empty">{tr('local.note.empty')}</div>
          ) : (
            <div className="v2-note-panel-list">
              {[...api.notes].reverse().map((n) => (
                <NoteCard key={n.id} note={n} kindLabel={kindLabel} variant="full" onRemove={() => api.remove(n.id)} />
              ))}
            </div>
          )}
        </div>
        <div className="v2-note-add">
          <input
            value={draft}
            placeholder={tr('local.note.addPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          />
          <button title={tr('local.note.add')} onClick={submit}><IconSendSm /></button>
        </div>
      </div>
    </div>,
    host,
  );
};

let _noteSeq = 0;
export function useNotes(cwd: string) {
  const [map, setMap] = useState<Record<string, NoteItem[]>>(() => loadNotesByCwd());
  const notes = map[cwd] ?? EMPTY_NOTES;
  const add = useCallback((text: string, kind: NoteKind) => {
    // Preserve markdown structure: collapse only intra-line whitespace and
    // runaway blank lines — keep newlines so lists / code / paragraphs survive
    // (the old replace(/\s+/g,' ') flattened everything into one line).
    const t = (text || '')
      .replace(/[ \t]+/g, ' ')      // squeeze spaces/tabs within a line
      .replace(/[ \t]+\n/g, '\n')   // drop trailing spaces
      .replace(/\n{3,}/g, '\n\n')   // cap blank-line runs
      .trim();
    if (t.length < 2) return;
    setMap((prev) => {
      const arr = prev[cwd] ?? [];
      const next = { ...prev, [cwd]: [...arr, { id: `n${Date.now()}-${++_noteSeq}`, text: t.slice(0, 2000), kind, at: Date.now() }] };
      saveNotesByCwd(next); return next;
    });
  }, [cwd]);
  const remove = useCallback((id: string) => {
    setMap((prev) => { const next = { ...prev, [cwd]: (prev[cwd] ?? []).filter((n) => n.id !== id) }; saveNotesByCwd(next); return next; });
  }, [cwd]);
  return { notes, add, remove };
}
export type NotesApi = ReturnType<typeof useNotes>;

/* 选区工具条 —— 选中正文/AI 回答末端浮出。 */
export const SelectionToolbar: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  onNote: (text: string, kind: NoteKind) => void;
  onDerive?: (text: string, range: Range | null) => void;
  onPrewarm?: () => void;   // 选中 AI 文本即触发：后台预热一条衍生会话（首 token 更快）
}> = ({ containerRef, onNote, onDerive, onPrewarm }) => {
  const { t: tr } = useI18n();
  const [st, setSt] = useState<{ x: number; y: number; text: string; canDerive: boolean; kind: NoteKind } | null>(null);
  const rangeRef = useRef<Range | null>(null);   // 选区快照（衍生时用于注脚注入）
  const prewarmRef = useRef(onPrewarm); prewarmRef.current = onPrewarm;   // 保持最新，避免 effect 重订阅
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
      const inProse = !!anchorEl?.closest('.v2-la-prose');   // AI 散文 → 可衍生
      if (inProse) prewarmRef.current?.();   // 选中即后台预热衍生会话，点「展开讲讲」时首 token 更快
      setSt({
        x: Math.min(last.right + 8, window.innerWidth - 190),
        y: last.bottom - 2,
        text, canDerive: inProse, kind: inProse ? 'ai' : 'doc',
      });
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
      <button className="v2-sel-act note" onClick={() => { onNote(st.text, st.kind); setSt(null); }}>
        <IconBookmark /><span>{tr('local.sel.note')}</span>
      </button>
    </div>,
    host,
  );
};

/* composer 里的笔记 pill + 上展弹层（锚定 .v2-box，向上打开）。 */
export const LocalNotes: React.FC<{ api: NotesApi; projectName: string }> = ({ api, projectName }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // The expanded panel is portaled to the app root (outside this popover), so it
  // lives in LocalNotes state and survives the popover closing. A ref lets the
  // popover's dismiss handlers stand down while the panel owns the foreground.
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef(false);
  panelRef.current = panelOpen;
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (e: MouseEvent) => { if (!panelRef.current && !wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !panelRef.current) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const kindLabel = (k: NoteKind) => k === 'ai' ? tr('local.note.kindAI') : k === 'manual' ? tr('local.note.kindManual') : tr('local.note.kindDoc');
  const submit = () => { if (draft.trim()) { api.add(draft, 'manual'); setDraft(''); } };
  return (
    <div className="v2-note" ref={wrapRef}>
      <button className={`v2-note-pill${open ? ' on' : ''}`} title={tr('local.note.openTitle')} onClick={() => setOpen((o) => !o)}>
        <IconNoteBook /><span>{tr('local.note.pill')}</span>
        {api.notes.length > 0 && <span className="badge">{api.notes.length}</span>}
      </button>
      {open && (
        <div className="v2-note-pop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="v2-note-pop-hd">
            <span className="ic"><IconNoteBook /></span>
            <span className="ttl">{tr('local.note.title')} · <b>{projectName}</b></span>
            <span className="cnt">{api.notes.length}</span>
            <span className="grow" />
            <button className="v2-note-expand" title={tr('local.note.expandPanel')} aria-label={tr('local.note.expandPanel')} onClick={() => setPanelOpen(true)}>
              <IconExpandSm />
            </button>
          </div>
          <div className="v2-note-body">
            {api.notes.length === 0 ? (
              <div className="v2-note-empty">{tr('local.note.empty')}</div>
            ) : (
              <div className="v2-note-list">
                {api.notes.map((n) => (
                  <NoteCard key={n.id} note={n} kindLabel={kindLabel} onRemove={() => api.remove(n.id)} onOpen={() => setPanelOpen(true)} />
                ))}
              </div>
            )}
          </div>
          <div className="v2-note-add">
            <input
              ref={inputRef}
              value={draft}
              placeholder={tr('local.note.addPlaceholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            />
            <button title={tr('local.note.add')} onClick={submit}><IconSendSm /></button>
          </div>
        </div>
      )}
      {panelOpen && (
        <NotesPanel
          api={api}
          projectName={projectName}
          kindLabel={kindLabel}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
};
