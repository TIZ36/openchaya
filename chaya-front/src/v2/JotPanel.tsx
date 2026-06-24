/* ============================================================
   JotPanel —— code changes 侧栏「速记」tab。
   速记不再往笔记里堆纯文字，而是收进一张张 KV 卡（键名 → 内容）：
   贴标签(tag)便于过滤，一键复制内容。典型用途：存 SQL Gateway 的 SQL、
   对话历史里的 token / 链接。
   纯本地：localStorage 全局存（跨工作目录通用，不绑 cwd）。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

export type Jot = {
  id: string;
  key: string;
  value: string;
  tags: string[];
  glyph: 'SQL' | 'TOKEN' | 'LINK' | 'NOTE';
  ts: number;
};

const STORE_KEY = 'chaya:jots';

function load(): Jot[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function persist(jots: Jot[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(jots)); } catch { /* quota */ }
}

/* 按内容猜类别：SQL / 链接 / token，其余记为 NOTE（仅做视觉标签，不影响存取）。 */
function autoGlyph(v: string): Jot['glyph'] {
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return 'LINK';
  if (/\b(select|insert|update|delete|create|alter|with)\b[\s\S]*\b(from|into|table|values|where)\b/i.test(s) || /^\\[a-z]/i.test(s)) return 'SQL';
  if (/^(sk-|ghp_|gho_|eyJ[A-Za-z0-9_-]+\.)/.test(s) || /^[A-Za-z0-9_-]{28,}$/.test(s)) return 'TOKEN';
  return 'NOTE';
}

const newId = () => `j_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function relTime(ms: number, tr: (k: string, v?: any) => string): string {
  const d = Date.now() - ms;
  if (d < 60_000) return tr('local.time.justNow');
  if (d < 3600_000) return tr('local.time.minutes', { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return tr('local.time.hours', { n: Math.floor(d / 3600_000) });
  return tr('local.time.days', { n: Math.floor(d / 86400_000) });
}

const S = (p: React.ReactNode, w = 13) => (
  <svg viewBox="0 0 24 24" width={w} height={w} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>
);
const IcoSearch = () => S(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>, 13);
const IcoPlus = () => S(<path d="M12 5v14M5 12h14" />, 14);
const IcoCopy = () => S(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 13);
const IcoCheck = () => S(<polyline points="20 6 9 17 4 12" />, 13);
const IcoEdit = () => S(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>, 13);
const IcoTrash = () => S(<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />, 13);
const IcoSend = () => S(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />, 13);

/* ---------------- 单张 KV 卡 ---------------- */
const JotCard: React.FC<{
  jot: Jot;
  canSend: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSendToChat: () => void;
  onTag: (t: string) => void;
}> = ({ jot, canSend, onCopy, onEdit, onDelete, onSendToChat, onTag }) => {
  const { t: tr } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const long = jot.value.length > 140 || jot.value.split('\n').length > 5;
  const copy = () => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return (
    <div className="v2-jot-card">
      <div className="v2-jot-card-hd">
        <span className={`v2-jot-glyph g-${jot.glyph.toLowerCase()}`}>{jot.glyph}</span>
        <span className="k" title={jot.key}>{jot.key}</span>
        <span className="grow" />
        <div className="acts">
          {canSend && <button className="act" onClick={onSendToChat} title={tr('jot.sendToChat')}><IcoSend /></button>}
          <button className="act" onClick={onEdit} title={tr('jot.edit')}><IcoEdit /></button>
          <button className="act del" onClick={onDelete} title={tr('common.delete')}><IcoTrash /></button>
        </div>
      </div>
      <div
        className={`v2-jot-val${long && !expanded ? ' clamped' : ''}`}
        onClick={() => long && setExpanded((e) => !e)}
        title={long ? (expanded ? tr('jot.collapse') : tr('jot.expand')) : undefined}
      >{jot.value}</div>
      <div className="v2-jot-card-ft">
        <div className="tags">
          {jot.tags.map((t) => (
            <button key={t} className="tag" onClick={() => onTag(t)} title={tr('jot.filterBy', { t })}>{t}</button>
          ))}
          <span className="tm">{relTime(jot.ts, tr)}</span>
        </div>
        <button className={`v2-jot-copy${copied ? ' done' : ''}`} onClick={copy}>
          {copied ? <IcoCheck /> : <IcoCopy />}<span>{copied ? tr('jot.copied') : tr('jot.copy')}</span>
        </button>
      </div>
    </div>
  );
};

/* ---------------- 主面板 ---------------- */
export const JotPanel: React.FC<{ onSendToChat?: (text: string) => void }> = ({ onSendToChat }) => {
  const { t: tr } = useI18n();
  const [jots, setJots] = useState<Jot[]>(() => load());
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // composer：null=收起；{}=新增；{id}=编辑
  const [editing, setEditing] = useState<{ id?: string; key: string; value: string; tags: string } | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  // 跨标签页/窗口同步（另一处改了 localStorage 时跟上）。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === STORE_KEY) setJots(load()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const commit = useCallback((next: Jot[]) => { setJots(next); persist(next); }, []);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    jots.forEach((j) => j.tags.forEach((t) => m.set(t, (m.get(t) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [jots]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jots.filter((j) => {
      if (activeTag && !j.tags.includes(activeTag)) return false;
      if (!q) return true;
      if (q.startsWith('#')) return j.tags.some((t) => t.toLowerCase().includes(q.slice(1)));
      return `${j.key} ${j.value} ${j.tags.join(' ')}`.toLowerCase().includes(q);
    });
  }, [jots, query, activeTag]);

  const openAdd = () => { setEditing({ key: '', value: '', tags: '' }); setTimeout(() => keyRef.current?.focus(), 0); };
  const openEdit = (j: Jot) => { setEditing({ id: j.id, key: j.key, value: j.value, tags: j.tags.map((t) => `#${t}`).join(' ') }); setTimeout(() => keyRef.current?.focus(), 0); };
  const closeEditor = () => setEditing(null);

  const save = () => {
    if (!editing) return;
    const key = editing.key.trim();
    const value = editing.value.trim();
    if (!key || !value) { keyRef.current?.focus(); return; }
    const tags = [...new Set((editing.tags.match(/#?[^\s#]+/g) || []).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
    const glyph = autoGlyph(value);
    if (editing.id) {
      commit(jots.map((j) => (j.id === editing.id ? { ...j, key, value, tags, glyph, ts: Date.now() } : j)));
    } else {
      commit([{ id: newId(), key, value, tags, glyph, ts: Date.now() }, ...jots]);
    }
    closeEditor();
  };

  const remove = (id: string) => commit(jots.filter((j) => j.id !== id));
  const copy = (v: string) => { navigator.clipboard?.writeText(v).catch(() => {}); };

  return (
    <div className="v2-jot">
      {/* 行动栏：搜索 ···· 记一条 */}
      <div className="v2-jot-bar">
        <label className="v2-jot-search">
          <IcoSearch />
          <input value={query} spellCheck={false} placeholder={tr('jot.searchPh')} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="clr" onClick={() => setQuery('')} aria-label={tr('common.close')}>×</button>}
        </label>
        <button className="v2-jot-add" onClick={openAdd}><IcoPlus />{tr('jot.add')}</button>
      </div>

      {/* 标签过滤栏 */}
      {allTags.length > 0 && (
        <div className="v2-jot-tags">
          <button className={`t${!activeTag ? ' on' : ''}`} onClick={() => setActiveTag(null)}>{tr('jot.all')}<span className="n">{jots.length}</span></button>
          {allTags.map(([t, n]) => (
            <button key={t} className={`t${activeTag === t ? ' on' : ''}`} onClick={() => setActiveTag((cur) => (cur === t ? null : t))}>{t}<span className="n">{n}</span></button>
          ))}
        </div>
      )}

      {/* 新增 / 编辑表单 */}
      {editing && (
        <div className="v2-jot-form" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); if (e.key === 'Escape') closeEditor(); }}>
          <div className="row">
            <input ref={keyRef} className="key" value={editing.key} placeholder={tr('jot.keyPh')} onChange={(e) => setEditing((s) => s && { ...s, key: e.target.value })} />
            <input className="tg" value={editing.tags} spellCheck={false} placeholder={tr('jot.tagsPh')} onChange={(e) => setEditing((s) => s && { ...s, tags: e.target.value })} />
          </div>
          <textarea className="val" value={editing.value} spellCheck={false} rows={4} placeholder={tr('jot.valPh')} onChange={(e) => setEditing((s) => s && { ...s, value: e.target.value })} />
          <div className="ft">
            <span className="hint">{tr('jot.saveHint')}</span>
            <div className="btns">
              <button className="btn" onClick={closeEditor}>{tr('jot.cancel')}</button>
              <button className="btn prim" onClick={save}>{tr('jot.save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 卡片列表 / 空态 */}
      {filtered.length === 0 ? (
        <div className="v2-jot-empty">
          <p className="t">{query || activeTag ? tr('jot.emptyFilter') : tr('jot.empty')}</p>
          {!(query || activeTag) && <p className="h">{tr('jot.emptyHint')}</p>}
        </div>
      ) : (
        <div className="v2-jot-list">
          {filtered.map((j) => (
            <JotCard
              key={j.id}
              jot={j}
              canSend={!!onSendToChat}
              onCopy={() => copy(j.value)}
              onEdit={() => openEdit(j)}
              onDelete={() => remove(j.id)}
              onSendToChat={() => onSendToChat?.(j.value)}
              onTag={(t) => setActiveTag((cur) => (cur === t ? null : t))}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------------- 独立检视抽屉 ----------------
   把 JotPanel 挂进右侧检视列自己的槽 #v2-inspector-jot（与代码改动/wiki 并列），
   由书签栏「速记」按钮独立开关。宽度与其它检视面板共用 --wiki-w + 同一持久化键。 */
const W_MIN = 360, W_MAX = 760, W_KEY = 'chaya:editorW';
const IcoNote = () => S(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><path d="M9 7h7M9 11h5" /></>, 16);
const IcoX = () => S(<path d="M18 6 6 18M6 6l12 12" />, 15);

export const JotDrawer: React.FC<{ open: boolean; onClose: () => void; onSendToChat?: (text: string) => void }> = ({ open, onClose, onSendToChat }) => {
  const { t: tr } = useI18n();

  // 根节点 data-jot-right → CSS 展开 grid 第二列（复用 --insp-w 机制）。
  useEffect(() => {
    const root = typeof document !== 'undefined' ? (document.querySelector('.chaya-v2') as HTMLElement | null) : null;
    if (!root) return;
    if (open) {
      const saved = Number(localStorage.getItem(W_KEY));
      if (saved >= W_MIN && saved <= W_MAX) root.style.setProperty('--wiki-w', `${saved}px`);
      root.setAttribute('data-jot-right', 'on');
    } else { root.removeAttribute('data-jot-right'); }
    return () => root.removeAttribute('data-jot-right');
  }, [open]);

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
      const w = Math.max(W_MIN, Math.min(W_MAX, startW + (startX - ev.clientX)));
      root.style.setProperty('--wiki-w', `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      app?.classList.remove('wiki-dragging');
      document.body.style.cursor = '';
      const w = parseFloat(getComputedStyle(root).getPropertyValue('--wiki-w'));
      if (w) localStorage.setItem(W_KEY, String(Math.round(w)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  if (!open) return null;
  const host: Element = (typeof document !== 'undefined'
    && (document.getElementById('v2-inspector-jot') || document.getElementById('v2-inspector-slot') || document.querySelector('.chaya-v2'))) || document.body;

  return createPortal(
    <aside className="v2-wiki-drawer v2-jot-drawer" role="region" aria-label={tr('jot.tab')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="v2-wiki-grip" onMouseDown={startResize} aria-hidden />
      <div className="v2-wiki-drawer-hd">
        <span className="ic"><IcoNote /></span>
        <span className="ttl-tx">{tr('jot.tab')}</span>
        <span className="grow" />
        <button className="x" onClick={onClose} title={tr('common.close')} aria-label={tr('common.close')}><IcoX /></button>
      </div>
      <div className="v2-jot-drawer-bd">
        <JotPanel onSendToChat={onSendToChat} />
      </div>
    </aside>,
    host,
  );
};
