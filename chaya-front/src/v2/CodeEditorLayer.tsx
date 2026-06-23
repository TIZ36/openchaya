/* ============================================================
   CodeEditorLayer — 「代码改动」右侧检视列（仿 wiki 抽屉，复用 inspector-slot）。

   事实来源 = 本地 git 工作区（vs 上次提交），不是某个 session 的 transcript 自述：
   同一目录可并行跑多个 session（也可能用户手改 / git 操作），都反映在工作区 diff 里。
   - repo：git status 列改动文件 + 懒取单文件 unified diff（PatchView 渲染）；
     本会话 agent 碰过的文件额外打「本会话」标。
   - 非 repo：退化到本会话 transcript 聚合（collectFileChanges）。

   读写本地文件交给本机 VSCode / Cursor —— 头部按钮把会话工作目录当工程打开。
   与 wiki 抽屉互斥（共用 grid 第二列）：开一个自动关另一个，靠 window 事件总线。
   ============================================================ */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { localAgent, basename, type TranscriptMessage, type GitFile, type ModelInfo } from './services/localAgent';
import { CodePreview, langOf } from './LocalAgentView';
import { AutomationPanel } from './AutomationPanel';
import { ReviewPanel } from './ReviewPanel';

const IconCode = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
);
const IconXSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
);
const IconChev = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden><polyline points="9 18 15 12 9 6" /></svg>
);
const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg>
);
const IconChevDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="11" height="11" aria-hidden><polyline points="6 9 12 15 18 9" /></svg>
);
const IconRevertSm = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" aria-hidden><path d="M3 3v5h5" /><path d="M3 8a9 9 0 1 0 2.2-3.1L3 8" /></svg>
);
// 编辑器品牌 logo（simple-icons 官方 path）。
const IconVscode = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="#007ACC" aria-hidden><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" /></svg>
);
const IconCursor = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" /></svg>
);

const EDITOR_W_KEY = 'chaya:editorW';
const W_MIN = 360, W_MAX = 760;
const PATCH_MAX_LINES = 2000;

/* ================= transcript → 本会话碰过的文件（仅作标记/非 repo 兜底） ================= */
type EditOp =
  | { kind: 'diff'; hunks: { old: string; neu: string }[] }
  | { kind: 'write'; content: string };
export interface FileChange { path: string; name: string; ops: EditOp[]; adds: number; dels: number; }

const lineCount = (s: string) => (s ? s.split('\n').length : 0);
const stripSlash = (p: string) => p.replace(/\/+$/, '');
/** transcript 里的 file_path → 绝对路径（claude 多给绝对路径；相对则拼 cwd）。 */
function toAbs(p: string, cwd: string | null): string {
  if (!p) return '';
  if (p.startsWith('/')) return stripSlash(p);
  if (!cwd) return p;
  return stripSlash(`${stripSlash(cwd)}/${p.replace(/^\.\//, '')}`);
}

export function collectFileChanges(msgs: TranscriptMessage[]): FileChange[] {
  const order: string[] = [];
  const byPath = new Map<string, FileChange>();
  const ensure = (p: string): FileChange => {
    let fc = byPath.get(p);
    if (!fc) { fc = { path: p, name: basename(p) || p, ops: [], adds: 0, dels: 0 }; byPath.set(p, fc); order.push(p); }
    return fc;
  };
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.kind !== 'tool_use') continue;
      const lower = (part.name || '').toLowerCase();
      const input = part.input || {};
      const file = input.file_path || input.notebook_path;
      if (!file) continue;
      if (lower === 'edit') {
        const old = String(input.old_string ?? ''), neu = String(input.new_string ?? '');
        if (!old && !neu) continue;
        const fc = ensure(file); fc.ops.push({ kind: 'diff', hunks: [{ old, neu }] });
        fc.adds += lineCount(neu); fc.dels += lineCount(old);
      } else if (lower === 'multiedit') {
        const hunks = (Array.isArray(input.edits) ? input.edits : []).map((e: any) => ({ old: String(e.old_string ?? ''), neu: String(e.new_string ?? '') }));
        if (!hunks.length) continue;
        const fc = ensure(file); fc.ops.push({ kind: 'diff', hunks });
        for (const h of hunks) { fc.adds += lineCount(h.neu); fc.dels += lineCount(h.old); }
      } else if (lower === 'write') {
        const content = String(input.content ?? '');
        const fc = ensure(file); fc.ops.push({ kind: 'write', content }); fc.adds += lineCount(content);
      } else if (lower === 'notebookedit') {
        const content = String(input.new_string ?? input.content ?? '');
        if (!content) continue;
        const fc = ensure(file); fc.ops.push({ kind: 'write', content }); fc.adds += lineCount(content);
      }
    }
  }
  return order.map((p) => byPath.get(p)!).reverse();
}

/** 本会话 agent 碰过的文件绝对路径集合（给 git 视图打「本会话」标）。 */
function sessionTouchedAbs(msgs: TranscriptMessage[], cwd: string | null): Set<string> {
  const set = new Set<string>();
  for (const m of msgs) {
    for (const part of m.parts) {
      if (part.kind !== 'tool_use') continue;
      const lower = (part.name || '').toLowerCase();
      if (!['edit', 'write', 'multiedit', 'notebookedit'].includes(lower)) continue;
      const file = (part.input || {}).file_path || (part.input || {}).notebook_path;
      if (file) set.add(toAbs(String(file), cwd));
    }
  }
  return set;
}

/* ================= unified diff（git）→ 行级补丁视图 ================= */
type PatchRow = { type: 'ctx' | 'add' | 'del' | 'hunk'; text: string; oldLn?: number; newLn?: number };
function parsePatch(diff: string): { rows: PatchRow[]; truncated: boolean } {
  const rows: PatchRow[] = [];
  let oldLn = 0, newLn = 0, truncated = false;
  for (const line of diff.split('\n')) {
    if (rows.length >= PATCH_MAX_LINES) { truncated = true; break; }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')
      || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('old mode') || line.startsWith('new mode')
      || line.startsWith('similarity ') || line.startsWith('rename ') || line.startsWith('copy ') || line.startsWith('\\ No newline')) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); rows.push({ type: 'hunk', text: line }); continue; }
    if (line.startsWith('+')) { rows.push({ type: 'add', text: line.slice(1), newLn }); newLn++; }
    else if (line.startsWith('-')) { rows.push({ type: 'del', text: line.slice(1), oldLn }); oldLn++; }
    else { const t = line.startsWith(' ') ? line.slice(1) : line; rows.push({ type: 'ctx', text: t, oldLn, newLn }); oldLn++; newLn++; }
  }
  return { rows, truncated };
}

const PatchView: React.FC<{ diff: string }> = ({ diff }) => {
  const { t: tr } = useI18n();
  const { rows, truncated } = useMemo(() => parsePatch(diff), [diff]);
  return (
    <div className="v2-patch">
      {rows.map((r, i) => (
        r.type === 'hunk'
          ? <div key={i} className="v2-patch-hunk">{r.text}</div>
          : (
            <div key={i} className={`v2-patch-row ${r.type}`}>
              <span className="no">{r.type === 'add' ? '' : (r.oldLn ?? '')}</span>
              <span className="no">{r.type === 'del' ? '' : (r.newLn ?? '')}</span>
              <span className="sign">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ''}</span>
              <code className="tx">{r.text || ' '}</code>
            </div>
          )
      ))}
      {truncated && <div className="v2-patch-trunc">{tr('local.editor.truncated', { n: PATCH_MAX_LINES })}</div>}
    </div>
  );
};

/* ================= git 改动文件行（懒取 diff） ================= */
function statusChar(f: GitFile): string {
  if (f.untracked) return 'U';
  const c = (f.x !== ' ' && f.x !== '?') ? f.x : f.y;
  return c || 'M';
}
const STATUS_CLASS: Record<string, string> = { M: 'mod', A: 'add', D: 'del', R: 'ren', U: 'new', C: 'add' };

const GitFileRow: React.FC<{ f: GitFile; cwd: string; mine: boolean; defaultOpen?: boolean; onReverted?: () => void }> = ({ f, cwd, mine, defaultOpen, onReverted }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(!!defaultOpen);
  const [state, setState] = useState<{ loading: boolean; diff?: string; content?: string; err?: string }>({ loading: false });
  const [reverting, setReverting] = useState(false);
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const sc = statusChar(f);

  const doRevert = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reverting) return;
    const isNew = f.untracked || sc === 'U' || (f.x === 'A');
    const msg = isNew ? tr('local.editor.revertNewConfirm', { name: basename(f.path) || f.path })
                      : tr('local.editor.revertConfirm', { name: basename(f.path) || f.path });
    if (!window.confirm(msg)) return;
    setReverting(true);
    const r = await localAgent.gitRevertFile(cwd, f.path, f.untracked);
    setReverting(false);
    if (r.ok) onReverted?.();
    else window.alert(r.error || tr('local.editor.revertFailed'));
  };

  useEffect(() => {
    if (!open || state.diff !== undefined || state.content !== undefined || state.loading) return;
    setState({ loading: true });
    localAgent.gitDiffFile(cwd, f.path, f.untracked).then((r) => {
      if (!r.ok) setState({ loading: false, err: r.error || 'error' });
      else if (r.untracked) setState({ loading: false, content: r.content || '' });
      else setState({ loading: false, diff: r.diff || '' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className={`v2-editor-file${open ? ' open' : ''}`}>
      <button className="v2-editor-file-hd" onClick={() => setOpen((o) => !o)}>
        <span className={`chev${open ? ' open' : ''}`} aria-hidden><IconChev /></span>
        <span className={`st ${STATUS_CLASS[sc] || 'mod'}`} title={`${f.x}${f.y}`}>{sc}</span>
        <span className="fn" title={f.path}>{basename(f.path) || f.path}</span>
        {dir && <span className="dir" title={f.path}>{dir}</span>}
        <span className="grow" />
        {mine && <span className="mine" title={tr('local.editor.thisSession')}>{tr('local.editor.thisSession')}</span>}
        {f.binary ? <span className="ops">bin</span> : (<>
          {f.adds > 0 && <span className="stat add">+{f.adds}</span>}
          {f.dels > 0 && <span className="stat del">−{f.dels}</span>}
        </>)}
        <span
          role="button" tabIndex={0}
          className={`v2-editor-revert${reverting ? ' busy' : ''}`}
          title={tr('local.editor.revert')}
          aria-label={tr('local.editor.revert')}
          onClick={doRevert}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') doRevert(e as any); }}
        ><IconRevertSm /></span>
      </button>
      {open && (
        <div className="v2-editor-file-bd">
          {state.loading && <div className="v2-editor-diffmsg">{tr('local.editor.loadingDiff')}</div>}
          {f.binary && !state.loading && <div className="v2-editor-diffmsg">{tr('local.editor.binary')}</div>}
          {state.err && <div className="v2-editor-diffmsg err">{state.err}</div>}
          {state.content !== undefined && (
            <div className="v2-editor-write"><span className="tag">{tr('local.editor.untracked')}</span><CodePreview code={state.content} lang={langOf(f.path)} /></div>
          )}
          {state.diff !== undefined && state.diff.trim() !== '' && <PatchView diff={state.diff} />}
        </div>
      )}
    </div>
  );
};


const CodeEditorLayerInner: React.FC<{
  open: boolean;
  onClose: () => void;
  messages: TranscriptMessage[];
  cwd: string | null;   // 会话工作目录（绝对路径）；null = 无活动会话
  activeSessionId?: string | null;   // 绑定 session 的自动化任务用
  provider?: string;                 // 当前本地 agent 引擎（自动化默认引擎）
  modelOptions?: ModelInfo[];        // 活动会话引擎的可选模型（评审 model 选择器用）
  activeProvider?: string;           // 活动会话当前引擎（modelOptions 属于它）
  onSendToChat?: (text: string) => void;   // 评审结果「发送到对话」：灌进当前会话输入框
}> = ({ open, onClose, messages, cwd, activeSessionId = null, provider = 'claude', modelOptions, activeProvider, onSendToChat }) => {
  const { t: tr } = useI18n();
  const [editors, setEditors] = useState<{ vscode: boolean; cursor: boolean }>({ vscode: false, cursor: false });
  const [menuOpen, setMenuOpen] = useState(false);   // 「在编辑器打开」下拉
  const [editorPick, setEditorPick] = useState<'vscode' | 'cursor'>(() => ((typeof localStorage !== 'undefined' && localStorage.getItem('chaya:editorPick')) as 'vscode' | 'cursor') || 'vscode');
  const [note, setNote] = useState('');
  const [git, setGit] = useState<{ loading: boolean; repo: boolean; gitMissing: boolean; files: GitFile[]; branch: string; ahead: number; behind: number; hasUpstream: boolean }>({ loading: false, repo: false, gitMissing: false, files: [], branch: '', ahead: 0, behind: 0, hasUpstream: false });
  const [mode, setMode] = useState<'git' | 'review' | 'auto'>('git');   // 工作区事实 / 评审 / 自动化
  // 手动提交 / 推送
  const [commitMsg, setCommitMsg] = useState('');
  const [gitBusy, setGitBusy] = useState<'commit' | 'push' | null>(null);

  // 只看「已落库」的 messages，不混 liveMsgs —— liveMsgs 每个 token 都换新数组引用，一旦纳入
  // 这个 memo 就会在流式期每个字重算一遍 sessionTouchedAbs（遍历全部消息），是输入卡顿的主因。
  // 用途：在工作区文件上标「本会话」徽标。改为「整轮结束(messages 落库)后」更新即可，无需逐字跟。
  const mineSet = useMemo(() => sessionTouchedAbs(messages, cwd), [messages, cwd]);

  // 拉 git 工作区状态（文件夹事实）。手动刷新 / 打开 / cwd 变 / 本会话推进 都会调。
  const refresh = useCallback(() => {
    if (!cwd) { setGit({ loading: false, repo: false, gitMissing: false, files: [], branch: '', ahead: 0, behind: 0, hasUpstream: false }); return; }
    setGit((g) => ({ ...g, loading: true }));
    localAgent.gitStatus(cwd).then((r) => {
      setGit({ loading: false, repo: !!r.repo, gitMissing: !!r.gitMissing, files: r.files || [], branch: r.branch || '', ahead: r.ahead || 0, behind: r.behind || 0, hasUpstream: !!r.hasUpstream });
    }).catch(() => setGit({ loading: false, repo: false, gitMissing: false, files: [], branch: '', ahead: 0, behind: 0, hasUpstream: false }));
  }, [cwd]);

  const pickMode = useCallback((m: 'git' | 'review' | 'auto') => setMode(m), []);

  // 一键还原整个工作区（破坏性，二次确认）：已跟踪 reset --hard，未跟踪移回收站。
  const [revertingAll, setRevertingAll] = useState(false);
  const revertAll = useCallback(async () => {
    if (!cwd || revertingAll) return;
    if (!window.confirm(tr('local.editor.revertAllConfirm', { n: git.files.length }))) return;
    setRevertingAll(true);
    const r = await localAgent.gitRevertAll(cwd);
    setRevertingAll(false);
    if (r.ok) refresh();
    else window.alert(r.error || tr('local.editor.revertFailed'));
  }, [cwd, revertingAll, git.files.length, refresh, tr]);

  const doCommit = useCallback(async () => {
    if (!cwd || gitBusy) return;
    const msg = commitMsg.trim();
    if (!msg) return;
    setGitBusy('commit'); setNote('');
    const r = await localAgent.gitCommit(cwd, msg);
    setGitBusy(null);
    if (r.ok) { setCommitMsg(''); refresh(); }
    else setNote(r.error || tr('local.editor.commitFailed'));
  }, [cwd, gitBusy, commitMsg, refresh, tr]);
  const doPush = useCallback(async () => {
    if (!cwd || gitBusy) return;
    setGitBusy('push'); setNote('');
    const r = await localAgent.gitPush(cwd);
    setGitBusy(null);
    if (r.ok) { setNote(tr('local.editor.pushDone')); refresh(); }
    else setNote(r.error || tr('local.editor.pushFailed'));
  }, [cwd, gitBusy, refresh, tr]);

  // 打开时：检测编辑器 + 拉 git；Esc 关闭。（与笔记列改为「上下分屏」共存，不再互斥让位。）
  useEffect(() => {
    if (!open) return;
    void localAgent.detectEditors().then(setEditors);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, cwd]);

  // git 工作区刷新：打开 / cwd 变即拉一次，之后每 30s 自动刷 + 顶栏按钮手动刷。
  // 不再随 agent 每条消息（更别说每个 token）刷新 —— 流式期高频 git status IPC 是输入卡顿来源。
  useEffect(() => {
    if (!open) return;
    refresh();
    const id = setInterval(refresh, 30000);
    return () => clearInterval(id);
  }, [open, refresh]);

  // 根节点 data-editor-right → CSS 展开 grid 第二列。
  useEffect(() => {
    const root = typeof document !== 'undefined' ? (document.querySelector('.chaya-v2') as HTMLElement | null) : null;
    if (!root) return;
    if (open) {
      const saved = Number(localStorage.getItem(EDITOR_W_KEY));
      if (saved >= W_MIN && saved <= W_MAX) root.style.setProperty('--wiki-w', `${saved}px`);
      root.setAttribute('data-editor-right', 'on');
    } else { root.removeAttribute('data-editor-right'); }
    return () => root.removeAttribute('data-editor-right');
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
      if (w) localStorage.setItem(EDITOR_W_KEY, String(Math.round(w)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const openIn = useCallback(async (editor: 'vscode' | 'cursor') => {
    setMenuOpen(false);
    if (!cwd) { setNote(tr('local.editor.noDir')); return; }
    setNote('');
    const r = await localAgent.openInEditor(editor, cwd);
    if (!r.ok) setNote(tr('local.editor.openFailed', { err: r.error || '' }));
  }, [cwd, tr]);

  // 下拉开着时：外点 / Esc 关闭。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.('.v2-editor-launch')) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const editorList = [
    { id: 'vscode' as const, label: 'VS Code', icon: <IconVscode /> },
    { id: 'cursor' as const, label: 'Cursor', icon: <IconCursor /> },
  ].filter((e) => editors[e.id]);
  // 选中项落到检测到的第一个（持久化的选择若已不可用则纠偏）。
  useEffect(() => {
    if (editorList.length && !editorList.some((e) => e.id === editorPick)) setEditorPick(editorList[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editors.vscode, editors.cursor]);
  const selMeta = editorList.find((e) => e.id === editorPick) || editorList[0];
  const chooseEditor = useCallback((id: 'vscode' | 'cursor') => {
    setEditorPick(id);
    try { localStorage.setItem('chaya:editorPick', id); } catch { /* */ }
    void openIn(id);
  }, [openIn]);

  if (!open) return null;
  const host: Element = (typeof document !== 'undefined'
    && (document.getElementById('v2-inspector-editor') || document.getElementById('v2-inspector-slot') || document.querySelector('.chaya-v2'))) || document.body;


  return createPortal(
    <aside className="v2-wiki-drawer v2-editor-drawer" role="region" aria-label={tr('local.editor.title')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="v2-wiki-grip" onMouseDown={startResize} aria-hidden />
      <div className="v2-wiki-drawer-hd">
        <span className="ic"><IconCode /></span>
        <span className="ttl-tx">{tr('local.editor.title')}</span>
        <span className="grow" />
        {editorList.length > 0 && selMeta && (
          <div className="v2-editor-launch">
            <button className={`v2-editor-pick-btn${menuOpen ? ' on' : ''}`} disabled={!cwd} onClick={() => setMenuOpen((o) => !o)} title={tr('local.editor.openInEditor')} aria-haspopup="menu" aria-expanded={menuOpen}>
              <span className="logo">{selMeta.icon}</span>
              <span className="lb">{selMeta.label}</span>
              <span className="chev"><IconChevDown /></span>
            </button>
            {menuOpen && (
              <div className="v2-editor-menu" role="menu">
                <div className="v2-editor-menu-hd">{tr('local.editor.openInEditor')}</div>
                {editorList.map((e) => (
                  <button key={e.id} role="menuitem" className={`v2-editor-menu-item${e.id === editorPick ? ' on' : ''}`} onClick={() => chooseEditor(e.id)}>
                    <span className="logo">{e.icon}</span><span className="lb">{e.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button className={`x${git.loading ? ' spin' : ''}`} onClick={refresh} title={tr('local.editor.refresh')} aria-label={tr('local.editor.refresh')}><IconRefresh /></button>
        <button className="x" onClick={onClose} title={tr('common.close')} aria-label={tr('common.close')}><IconXSm /></button>
      </div>

      {/* 口径切换：工作区事实(git) / 本会话改动 / 自动化任务。 */}
      <div className="v2-editor-tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'git'} className={`v2-editor-tab${mode === 'git' ? ' on' : ''}`} onClick={() => pickMode('git')}>
          {tr('local.editor.tabGit')}{git.repo && git.files.length > 0 && <span className="n">{git.files.length}</span>}
        </button>
        <button role="tab" aria-selected={mode === 'review'} className={`v2-editor-tab${mode === 'review' ? ' on' : ''}`} onClick={() => pickMode('review')}>{tr('review.tab')}</button>
        <button role="tab" aria-selected={mode === 'auto'} className={`v2-editor-tab${mode === 'auto' ? ' on' : ''}`} onClick={() => pickMode('auto')}>{tr('auto.tab')}</button>
      </div>

      {note && <div className="v2-editor-note">{note}</div>}

      {mode === 'auto' ? (
        <div className="v2-editor-changes"><AutomationPanel cwd={cwd} activeSessionId={activeSessionId} provider={provider} /></div>
      ) : mode === 'review' ? (
        <div className="v2-editor-changes"><ReviewPanel cwd={cwd} provider={provider} modelOptions={modelOptions} activeProvider={activeProvider} onSendToChat={onSendToChat} /></div>
      ) : (
      <div className="v2-editor-changes">
        {/* worktree 顶栏：当前分支名 + 手动 commit / push。 */}
        {git.repo && (
          <div className="v2-editor-gitbar">
            <div className="branchrow">
              <svg className="bic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="8" r="2.4" /><path d="M6 8.4v7.2M18 10.4a6 6 0 0 1-6 6H8.4" /></svg>
              <span className="branch" title={git.branch}>{git.branch || 'HEAD'}</span>
              {git.hasUpstream && (git.ahead > 0 || git.behind > 0) && (
                <span className="ab">{git.ahead > 0 ? `↑${git.ahead}` : ''}{git.behind > 0 ? ` ↓${git.behind}` : ''}</span>
              )}
              <span className="grow" />
              <button className={`push${gitBusy === 'push' ? ' busy' : ''}`} onClick={doPush} disabled={!!gitBusy || !cwd} title={tr('local.editor.push')}>
                {gitBusy === 'push' ? tr('local.editor.pushing') : tr('local.editor.push')}{git.ahead > 0 ? ` ${git.ahead}` : ''}
              </button>
            </div>
            {git.files.length > 0 && (
              <div className="commitrow">
                <input
                  className="msg" value={commitMsg}
                  placeholder={tr('local.editor.commitPlaceholder')}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doCommit(); } }}
                />
                <button className={`commit${gitBusy === 'commit' ? ' busy' : ''}`} onClick={doCommit} disabled={!commitMsg.trim() || !!gitBusy}>
                  {gitBusy === 'commit' ? tr('local.editor.committing') : tr('local.editor.commit')}
                </button>
              </div>
            )}
          </div>
        )}
        {!git.repo ? (
          <div className="v2-editor-empty">
            <p className="t">{!cwd ? tr('local.editor.modeChanges') : git.gitMissing ? tr('local.editor.gitMissing') : tr('local.editor.notRepo')}</p>
            {!git.gitMissing && cwd && <p className="h">{tr('local.editor.emptyHint')}</p>}
          </div>
        ) : git.files.length === 0 ? (
          <div className="v2-editor-empty"><p className="t">{tr('local.editor.clean')}</p></div>
        ) : (
          <>
            <div className="v2-editor-count">
              <span>{tr('local.editor.modeGit')} · {tr('local.editor.fileCount', { n: git.files.length })}</span>
              <button className={`v2-editor-revertall${revertingAll ? ' busy' : ''}`} onClick={revertAll} disabled={revertingAll} title={tr('local.editor.revertAll')}>
                <IconRevertSm /> {tr('local.editor.revertAll')}
              </button>
            </div>
            {git.files.map((f, i) => (
              <GitFileRow key={f.path} f={f} cwd={cwd!} mine={mineSet.has(stripSlash(f.abs))} defaultOpen={git.files.length <= 3 && i === 0} onReverted={refresh} />
            ))}
          </>
        )}
      </div>
      )}
    </aside>,
    host,
  );
};

// memo：父级(ClientShell)在每个 stream chunk 都会重渲染，但本面板的入参（messages/cwd/open…）
// 在流式期是稳定的（messages 仅落库时换引用），memo 后流式 token 不再触发本面板重渲染。
// 注意：onClose 须由父级 useCallback 固定引用，否则 memo 形同虚设。
export const CodeEditorLayer = memo(CodeEditorLayerInner);
