/* ============================================================
   NoteEditor — CodeMirror 6 markdown editor for KB notes.
   Theme is bound to Chaya's CSS vars so it matches every theme/mode
   automatically. Autosaves 1.2s after the last edit + on Cmd/Ctrl-S.
   Exposes an imperative handle (getContent / setContent) so the parent
   can re-seed content when switching notes without remounting.
   ============================================================ */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { t } from '../../i18n';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, placeholder as cmPlaceholder,
  type Panel,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import {
  search, searchKeymap, highlightSelectionMatches,
  setSearchQuery, getSearchQuery, SearchQuery, findNext, findPrevious,
  closeSearchPanel, SearchCursor,
} from '@codemirror/search';

/** 跳到第 n 行（1-based，越界 clamp），居中滚入。 */
function gotoLine(view: EditorView, n: number) {
  const ln = Math.max(1, Math.min(n, view.state.doc.lines));
  const line = view.state.doc.line(ln);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
}

/** 计算当前 query 的匹配总数（笔记不大，直接全量数；上限 9999 防卡）。 */
function countMatches(view: EditorView, q: string): number {
  if (!q) return 0;
  let n = 0;
  try {
    const cur = new SearchCursor(view.state.doc, q);
    while (!cur.next().done) { if (++n >= 9999) break; }
  } catch { /* invalid */ }
  return n;
}

/** 自定义顶部查找面板：替换 CM 默认底部条。
 *  支持 `:数字` 跳转行（输入 :42 回车 → 跳到第 42 行）。 */
function makeFindPanel(view: EditorView): Panel {
  const wrap = document.createElement('div');
  wrap.className = 'v2-cm-find';

  const input = document.createElement('input');
  input.className = 'v2-cm-find-input';
  input.placeholder = t('kb.findPlaceholder');
  input.setAttribute('aria-label', t('kb.find'));

  const count = document.createElement('span');
  count.className = 'v2-cm-find-count';

  const mkBtn = (label: string, title: string, on: () => void) => {
    const b = document.createElement('button');
    b.className = 'v2-cm-find-btn'; b.type = 'button'; b.textContent = label; b.title = title;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); on(); });
    return b;
  };
  const prev = mkBtn('‹', t('kb.findPrev'), () => findPrevious(view));
  const next = mkBtn('›', t('kb.findNext'), () => findNext(view));
  const close = mkBtn('✕', t('kb.findClose'), () => closeSearchPanel(view));

  const lineRe = /^:(\d+)$/;
  const refreshCount = () => {
    const v = input.value;
    if (lineRe.test(v)) { count.textContent = t('kb.gotoLine'); return; }
    count.textContent = v ? t('kb.matchCount', { n: countMatches(view, v) }) : '';
  };
  input.addEventListener('input', () => {
    const v = input.value;
    if (lineRe.test(v)) { view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) }); refreshCount(); return; }
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: v })) });
    refreshCount();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const m = lineRe.exec(input.value);
      if (m) { gotoLine(view, parseInt(m[1], 10)); closeSearchPanel(view); return; }
      if (e.shiftKey) findPrevious(view); else findNext(view);
      refreshCount();
    }
  });

  wrap.append(input, count, prev, next, close);
  return {
    dom: wrap,
    top: true,
    mount() {
      const q = getSearchQuery(view.state);
      if (q.search) input.value = q.search;
      refreshCount();
      input.focus(); input.select();
    },
  };
}

export interface NoteEditorHandle {
  getContent: () => string;
  setContent: (v: string) => void;
  focus: () => void;
}

interface Props {
  initial: string;
  /** Fires (debounced 1.2s) + on Cmd-S with the latest content. */
  onSave: (content: string) => void;
  /** Fires whenever dirty-state flips (unsaved edits exist). */
  onDirty?: (dirty: boolean) => void;
  placeholder?: string;
  readOnly?: boolean;
}

/** CM theme reading Chaya tokens. Recreated cheaply; no per-keystroke cost. */
const chayaTheme = EditorView.theme({
  '&': {
    color: 'var(--c-ink)',
    backgroundColor: 'transparent',
    fontSize: '15px',   /* 与 wiki 阅读正文(.v2-note-preview .v2-md)同档，编辑↔预览不跳字号 */
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: 'var(--c-sans)',
    lineHeight: '1.7',
    padding: '4px 0',
  },
  '.cm-content': { caretColor: 'var(--c-accent-strong)', padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--c-ink-4)',
    border: 'none',
    fontFamily: 'var(--c-mono)',
    fontSize: '11px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--c-ink-3)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--c-ink) 3%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--c-accent-strong)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklab, var(--c-accent) 22%, transparent) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklab, var(--c-accent) 16%, transparent)' },
  '.cm-placeholder': { color: 'var(--c-ink-4)', fontStyle: 'italic' },
  '&.cm-editor.cm-focused': { outline: 'none' },
  '.cm-line': { padding: '0 2px' },
}, { dark: false });

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  { initial, onSave, onDirty, placeholder, readOnly }, ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  const onDirtyRef = useRef(onDirty);
  onSaveRef.current = onSave;
  onDirtyRef.current = onDirty;
  const readOnlyComp = useRef(new Compartment());

  // Build the editor once. Content re-seeding goes through the imperative
  // handle (setContent), never a remount — so undo history survives note
  // switches the parent chooses to keep.
  useEffect(() => {
    if (!hostRef.current) return;
    const setClean = () => { if (dirtyRef.current) { dirtyRef.current = false; onDirtyRef.current?.(false); } };
    const flushSave = () => {
      const v = viewRef.current; if (!v) return;
      onSaveRef.current(v.state.doc.toString());
      setClean();
    };
    const scheduleSave = () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushSave, 1200);
    };

    const state = EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        highlightSelectionMatches(),
        // 顶部自定义查找面板（替换默认底部条）；支持 :行号 跳转。
        search({ top: true, createPanel: makeFindPanel }),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        cmPlaceholder(placeholder || t('kb.editorPlaceholder')),
        readOnlyComp.current.of(EditorState.readOnly.of(!!readOnly)),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { flushSave(); return true; } },
          ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab,
        ]),
        chayaTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            if (!dirtyRef.current) { dirtyRef.current = true; onDirtyRef.current?.(true); }
            scheduleSave();
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally build once — `initial` re-seeding is via setContent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to readOnly toggles without rebuild.
  useEffect(() => {
    const v = viewRef.current; if (!v) return;
    v.dispatch({ effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(!!readOnly)) });
  }, [readOnly]);

  useImperativeHandle(ref, () => ({
    getContent: () => viewRef.current?.state.doc.toString() ?? '',
    setContent: (val: string) => {
      const v = viewRef.current; if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: val } });
      dirtyRef.current = false; onDirtyRef.current?.(false);
    },
    focus: () => viewRef.current?.focus(),
  }), []);

  return <div ref={hostRef} className="v2-note-cm" />;
});
