/* ============================================================
   CronPanel —— 独占右侧检视列的「定时任务」抽屉（provider 无关，类似速记）。
   扫的是操作系统 crontab（macOS/Linux），与任何 CLI 无关——关掉终端 / 重启都照跑。
   - 列出 crontab 任务（受管：按约定建在 ~/.chaya/cron/ + 带标记；外部：既有行，只读偏多）。
   - 立即试跑 / 看日志尾巴 / 删除 / 打开归集目录。
   - 可选「睡眠补跑」：升格成 macOS LaunchAgent（launchd 唤醒后补跑错过触发，crontab 不补）。
   - 「新建」把一段约定化提示词灌进对话框，让任意 provider 的 agent 按约定建 OS crontab。
   纯本地（electron/cron.cjs）。
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { cron, humanizeCron, cronCreatePrompt, type CronJob, type CronEvent } from './services/cron';

const S = (p: React.ReactNode, fill = false, w = 13) => (
  <svg viewBox="0 0 24 24" width={w} height={w} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>
);
const IcoClock = (w = 12) => S(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, false, w);
const IcoPlay = () => S(<path d="M6 4.5v15l13-7.5z" />, true);
const IcoTrash = () => S(<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />);
const IcoChevRight = () => S(<polyline points="9 6 15 12 9 18" />, false, 13);
const IcoPlus = () => S(<path d="M12 5v14M5 12h14" />, false, 13);
const IcoRefresh = () => S(<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></>, false, 12);
const IcoMoon = () => S(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, false, 11);
const IcoDoc = () => S(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>, false, 11);
const IcoFolder = () => S(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, false, 12);
const IcoInfo = () => S(<><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></>, false, 12);
const IcoTerm = () => S(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></>, false, 11);
const IcoX = () => S(<path d="M18 6 6 18M6 6l12 12" />, false, 15);
const IcoCron = (w = 16) => S(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 14l2 2-2 2M13 18h4" /></>, false, w);

/* 单条任务行 */
const JobRow: React.FC<{
  job: CronJob;
  runStatus?: 'running' | 'success' | 'error';
  offlineSupported: boolean;
  onRun: () => void; onDelete: () => void; onToggleOffline: () => void; onOpenLog: () => void; onTail: () => Promise<string>;
}> = ({ job, runStatus, offlineSupported, onRun, onDelete, onToggleOffline, onOpenLog, onTail }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [tail, setTail] = useState<string | null>(null);
  const human = humanizeCron(job.schedule, tr);
  const title = job.name || (job.scriptPath ? job.scriptPath.split('/').pop() : '') || job.command;

  const loadTail = useCallback(() => { onTail().then(setTail); }, [onTail]);
  useEffect(() => { if (open) loadTail(); /* eslint-disable-next-line */ }, [open]);

  return (
    <div className={`v2-auto-task${job.offline ? ' cron-pinned' : ''}${job.managed ? '' : ' cron-ext'}`}>
      <div className="v2-auto-task-hd">
        <button className={`exp${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="toggle"><IcoChevRight /></button>
        <span className="nm" title={title}>{title}</span>
        <span className="trg">{IcoClock()}{human}</span>
        <span className="grow" />
        {job.offline && <span className="v2-cron-badge on" title={tr('cron.offlineOn')}><IcoMoon /></span>}
        {!job.managed && <span className="v2-cron-tag" title={tr('cron.externalHint')}>ext</span>}
        {runStatus && <span className={`dot ${runStatus}`} title={runStatus} />}
        <button className="act run" onClick={onRun} title={tr('cron.runNow')}><IcoPlay /></button>
        <button className="act del" onClick={onDelete} title={tr('common.delete')}><IcoTrash /></button>
      </div>
      {open && (
        <div className="v2-auto-task-bd">
          <div className="meta">
            <span className="chip">{IcoClock(11)}{job.schedule}</span>
            {job.cwd && <span className="chip" title={job.cwd}><IcoFolder />{job.cwd.split('/').pop()}</span>}
            {job.offline && <span className="chip">{tr('cron.offlineChip')}</span>}
          </div>
          <div className="pr">{job.scriptPath || job.command}</div>

          {/* 睡眠补跑：升格 launchd */}
          {job.managed && (
            <div className="v2-cron-offline">
              <div className="tx">
                <b><IcoMoon />{tr('cron.offlineTitle')}</b>
                <span>{job.offline ? tr('cron.offlineOnHint') : tr('cron.offlineOffHint')}</span>
              </div>
              <button
                className={`v2-cron-sw${job.offline ? ' on' : ''}`}
                disabled={!offlineSupported}
                title={!offlineSupported ? tr('cron.macOnly') : (job.offline ? tr('cron.offlineOn') : tr('cron.offlineOff'))}
                onClick={onToggleOffline}
              ><i /></button>
            </div>
          )}

          {/* 日志尾巴 */}
          <div className="v2-cron-logbar">
            <button className="v2-cron-loglink" onClick={loadTail}><IcoTerm />{tr('cron.tail')}</button>
            {job.logPath && <button className="v2-cron-loglink" onClick={onOpenLog}><IcoDoc />{tr('cron.openLog')}</button>}
          </div>
          {tail !== null && (
            tail ? <pre className="v2-cron-log">{tail}</pre> : <div className="v2-cron-log empty">{tr('cron.noLog')}</div>
          )}
        </div>
      )}
    </div>
  );
};

const CronPanel: React.FC<{ onSendToChat?: (text: string) => void }> = ({ onSendToChat }) => {
  const { t: tr } = useI18n();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [harness, setHarness] = useState<CronJob[]>([]);
  const [supported, setSupported] = useState(true);
  const [offlineSupported, setOfflineSupported] = useState(true);
  const [cronDir, setCronDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [runStatus, setRunStatus] = useState<Record<string, 'running' | 'success' | 'error'>>({});
  const [note, setNote] = useState('');

  const reload = useCallback(() => {
    setLoading(true);
    cron.list().then((r) => {
      setSupported(r.supported);
      setOfflineSupported(r.offlineSupported);
      setCronDir(r.cronDir);
      setJobs(r.jobs || []);
      setHarness(r.harness || []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const off = cron.onEvent((data: CronEvent) => {
      if (data.type === 'tasks') reload();
      else if (data.type === 'run') {
        setRunStatus((m) => ({ ...m, [data.id]: data.status }));
        if (data.status !== 'running') setTimeout(reload, 300);
      }
    });
    return off;
  }, [reload]);

  const del = useCallback(async (job: CronJob) => {
    const msg = job.managed ? tr('cron.confirmDelete') : tr('cron.confirmDeleteExt');
    if (!window.confirm(msg)) return;
    const r = await cron.delete(job.id);
    if (!r.ok) setNote(r.error || tr('common.error'));
    reload();
  }, [reload, tr]);

  const toggleOffline = useCallback(async (job: CronJob) => {
    setNote('');
    const r = await cron.offline(job.id, !job.offline);
    if (!r.ok) setNote(r.error || tr('common.error'));
    reload();
  }, [reload, tr]);

  // 「新建」：约定化提示词灌进对话框，让任意 provider 的 agent 按约定建 OS crontab。
  const draftNew = useCallback(() => { onSendToChat?.(cronCreatePrompt(tr)); }, [onSendToChat, tr]);

  if (!cron.available()) return <div className="v2-auto-empty"><p className="t">{tr('cron.noElectron')}</p></div>;

  const empty = jobs.length === 0 && harness.length === 0;

  return (
    <div className="v2-auto v2-cron">
      <div className="v2-auto-hd">
        <span className="cnt">{jobs.length} · {tr('cron.tasks')}</span>
        <span className="grow" />
        <button className="x" onClick={() => cron.openDir()} title={tr('cron.openDir')} aria-label="dir"><IcoFolder /></button>
        <button className="x" onClick={reload} title={tr('common.loading')} aria-label="refresh"><span className={loading ? 'spin' : ''}><IcoRefresh /></span></button>
        {onSendToChat && <button className="v2-auto-add" onClick={draftNew}><IcoPlus />{tr('cron.new')}</button>}
      </div>

      {!supported && <div className="v2-cron-banner"><IcoInfo />{tr('cron.unsupportedBanner')}</div>}
      {note && <div className="v2-editor-note">{note}</div>}

      {empty ? (
        <div className="v2-auto-empty">
          <p className="t">{tr('cron.empty')}</p>
          <p className="h">{tr('cron.emptyHint')}</p>
          {cronDir && <p className="h" style={{ opacity: 0.7 }}><code>{cronDir}</code></p>}
          {onSendToChat && <button className="v2-cron-cta" onClick={draftNew}><IcoPlus />{tr('cron.ctaNew')}</button>}
        </div>
      ) : (
        <div className="v2-auto-list">
          {jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              runStatus={runStatus[j.id]}
              offlineSupported={offlineSupported}
              onRun={() => { setRunStatus((m) => ({ ...m, [j.id]: 'running' })); cron.runNow(j.id); }}
              onDelete={() => del(j)}
              onToggleOffline={() => toggleOffline(j)}
              onOpenLog={() => cron.openLog(j.id)}
              onTail={() => cron.tailLog(j.id, 40).then((r) => (r.ok ? (r.text || '') : ''))}
            />
          ))}
        </div>
      )}

      {/* 次要：harness（Claude 会话级）durable —— 需 Claude 在跑，弱于 OS crontab。 */}
      {harness.length > 0 && (
        <div className="v2-cron-harness">
          <div className="hd"><IcoInfo />{tr('cron.harnessHd')}</div>
          {harness.map((h) => (
            <div key={h.id} className="row">
              <span className="cr">{IcoClock(11)}{humanizeCron(h.schedule, tr)}</span>
              <span className="pr" title={h.prompt}>{(h.prompt || '').slice(0, 60)}</span>
            </div>
          ))}
          <p className="note">{tr('cron.harnessNote')}</p>
        </div>
      )}

      {/* 说明：为什么是 OS crontab，不是 harness cron。 */}
      <div className="v2-cron-explain">
        <div className="hd"><IcoInfo />{tr('cron.explainHd')}</div>
        <p>{tr('cron.explainOs')}</p>
        <p>{tr('cron.explainHarness')}</p>
        <p>{tr('cron.explainSleep')}</p>
      </div>
    </div>
  );
};

/* ---------------- 独立检视抽屉 ----------------
   把 CronPanel 挂进右侧检视列自己的槽 #v2-inspector-cron（与代码改动/wiki/速记 并列），
   由书签栏「定时任务」按钮独立开关。宽度复用 --wiki-w + 同一持久化键。 */
const W_MIN = 360, W_MAX = 760, W_KEY = 'chaya:editorW';

export const CronDrawer: React.FC<{ open: boolean; onClose: () => void; onSendToChat?: (text: string) => void }> = ({ open, onClose, onSendToChat }) => {
  const { t: tr } = useI18n();

  useEffect(() => {
    const root = typeof document !== 'undefined' ? (document.querySelector('.chaya-v2') as HTMLElement | null) : null;
    if (!root) return;
    if (open) {
      const saved = Number(localStorage.getItem(W_KEY));
      if (saved >= W_MIN && saved <= W_MAX) root.style.setProperty('--wiki-w', `${saved}px`);
      root.setAttribute('data-cron-right', 'on');
    } else { root.removeAttribute('data-cron-right'); }
    return () => root.removeAttribute('data-cron-right');
  }, [open]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const root = document.querySelector('.chaya-v2') as HTMLElement | null;
    const appEl = document.querySelector('.chaya-v2 .v2-app') as HTMLElement | null;
    if (!root) return;
    const startX = e.clientX;
    const startW = parseFloat(getComputedStyle(root).getPropertyValue('--wiki-w')) || 440;
    appEl?.classList.add('wiki-dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(W_MIN, Math.min(W_MAX, startW + (startX - ev.clientX)));
      root.style.setProperty('--wiki-w', `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      appEl?.classList.remove('wiki-dragging');
      document.body.style.cursor = '';
      const w = parseFloat(getComputedStyle(root).getPropertyValue('--wiki-w'));
      if (w) localStorage.setItem(W_KEY, String(Math.round(w)));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  if (!open) return null;
  const host: Element = (typeof document !== 'undefined'
    && (document.getElementById('v2-inspector-cron') || document.getElementById('v2-inspector-slot') || document.querySelector('.chaya-v2'))) || document.body;

  return createPortal(
    <aside className="v2-wiki-drawer v2-cron-drawer" role="region" aria-label={tr('cron.tab')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="v2-wiki-grip" onMouseDown={startResize} aria-hidden />
      <div className="v2-wiki-drawer-hd">
        <span className="ic">{IcoCron()}</span>
        <span className="ttl-tx">{tr('cron.tab')}</span>
        <span className="grow" />
        <button className="x" onClick={onClose} title={tr('common.close')} aria-label={tr('common.close')}><IcoX /></button>
      </div>
      <div className="v2-cron-drawer-bd">
        <CronPanel onSendToChat={onSendToChat} />
      </div>
    </aside>,
    host,
  );
};
