/* ============================================================
   AutomationPanel —— code changes 侧栏「自动化」tab。
   按当前工作目录(cwd)列出自动化任务：新增/编辑/删除、启用开关、立即运行、
   运行历史 + 结果查看。链路(DAG)摘要 + 环检测提示。
   纯本地（electron/automation.cjs）。调度仅在 App 运行期间生效。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  automation, type AutomationTask, type AutomationRun, type AutomationGraph,
  type AutoTriggerKind, type AutoChainEdge,
} from './services/automation';
import { localAgent, type SessionSummary, type ProviderId } from './services/localAgent';
import { ProviderLogo, PROVIDER_LABELS } from './LocalAgentView';
import { ChainGraphView } from './ChainGraphView';

const PROVIDERS = ['claude', 'cursor', 'codex', 'gemini', 'copilot'];

/* 线性 SVG 图标（不用 emoji）。 */
const S = (p: React.ReactNode, fill = false, w = 13) => (
  <svg viewBox="0 0 24 24" width={w} height={w} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>
);
const IcoPlus = () => S(<path d="M12 5v14M5 12h14" />, false, 13);
const IcoChevDown = () => S(<polyline points="6 9 12 15 18 9" />, false, 11);
const IcoChevRight = () => S(<polyline points="9 6 15 12 9 18" />, false, 13);
const IcoPlay = () => S(<path d="M6 4.5v15l13-7.5z" />, true);
const IcoStop = () => S(<rect x="6" y="6" width="12" height="12" rx="1.5" />, true);
const IcoEdit = () => S(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
const IcoTrash = () => S(<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>);
const IcoX = () => S(<path d="M18 6 6 18M6 6l12 12" />, false, 12);
const IcoLink = () => S(<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />, false, 12);
const IcoRepeat = () => S(<><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>, false, 11);
const IcoCron = () => S(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 14l2 2-2 2M12 18h4" /></>, false, 11);
const IcoHand = () => S(<path d="M9 11V6a1.5 1.5 0 0 1 3 0v5M12 11V5a1.5 1.5 0 0 1 3 0v6M15 11V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-2a5 5 0 0 1-3.5-1.5L4 15a1.6 1.6 0 0 1 2.3-2.2L8 14.5V8a1.5 1.5 0 0 1 3 0" />, false, 11);
const IcoBranch = () => S(<><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="8" r="2.4" /><path d="M6 8.4v7.2M18 10.4c0 3-3 3.6-6 3.6" /></>, false, 11);
const IcoTarget = () => S(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" /></>, false, 11);
const IcoAlert = () => S(<><path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, false, 12);
const IcoExpand = () => S(<><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></>, false, 12);
const TrigIcon: React.FC<{ kind?: string }> = ({ kind }) => kind === 'interval' ? <IcoRepeat /> : kind === 'cron' ? <IcoCron /> : <IcoHand />;

/* 起手模板：把原型里传达的典型用法（测试 / 构建 / 发布）做成一键起草。 */
const TEMPLATES: { key: string; trigger: AutomationTask['trigger'] }[] = [
  { key: 'test', trigger: { kind: 'interval', everyMs: 60 * 60000 } },
  { key: 'build', trigger: { kind: 'cron', cron: '0 9 * * *' } },
  { key: 'release', trigger: { kind: 'manual' } },
];

/* engine 选择器：框上显示 provider 真实 logo + 名字 + 下拉（仿 CLI 选择器）。 */
const EngineSelect: React.FC<{ value: string; onChange: (id: string) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="v2-auto-engine" ref={ref}>
      <button type="button" className="v2-auto-engine-btn" onClick={() => setOpen((o) => !o)}>
        <ProviderLogo id={value} /><span className="lb">{PROVIDER_LABELS[value] || value}</span>
        <span className="chev"><IcoChevDown /></span>
      </button>
      {open && (
        <div className="v2-auto-engine-menu">
          {PROVIDERS.map((p) => (
            <button key={p} type="button" className={`it${p === value ? ' on' : ''}`} onClick={() => { onChange(p); setOpen(false); }}>
              <ProviderLogo id={p} /><span>{PROVIDER_LABELS[p] || p}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

function relTime(ms: number | null | undefined, tr: (k: string, v?: any) => string): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return tr('local.time.justNow');
  if (d < 3600_000) return tr('local.time.minutes', { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return tr('local.time.hours', { n: Math.floor(d / 3600_000) });
  return tr('local.time.days', { n: Math.floor(d / 86400_000) });
}

function triggerLabel(t: AutomationTask, tr: (k: string, v?: any) => string): string {
  const k = t.trigger?.kind;
  if (k === 'interval') {
    const ms = t.trigger.everyMs || 0;
    const min = Math.round(ms / 60000);
    return min % 60 === 0 && min >= 60 ? tr('auto.everyHours', { n: min / 60 }) : tr('auto.everyMins', { n: min });
  }
  if (k === 'cron') return `cron · ${t.trigger.cron || ''}`;
  return tr('auto.manual');
}

/* ---------------- 任务编辑表单 ---------------- */
const TaskForm: React.FC<{
  cwd: string;
  activeSessionId: string | null;
  defaultProvider: string;
  all: AutomationTask[];
  init: Partial<AutomationTask> | null;
  onSave: (t: Partial<AutomationTask>) => void;
  onCancel: () => void;
}> = ({ cwd, activeSessionId, defaultProvider, all, init, onSave, onCancel }) => {
  const { t: tr } = useI18n();
  const [name, setName] = useState(init?.name || '');
  const [prompt, setPrompt] = useState(init?.prompt || '');
  const [provider, setProvider] = useState(init?.provider || defaultProvider || 'claude');
  const [trigKind, setTrigKind] = useState<AutoTriggerKind>(init?.trigger?.kind || 'manual');
  const [everyMin, setEveryMin] = useState(init?.trigger?.everyMs ? Math.round(init.trigger.everyMs / 60000) : 60);
  const [cron, setCron] = useState(init?.trigger?.cron || '0 9 * * *');
  const [targetKind, setTargetKind] = useState<'new' | 'bind'>(init?.target?.kind || 'new');
  const [bindSid, setBindSid] = useState(init?.target?.sessionId || activeSessionId || '');
  const [overlap, setOverlap] = useState<'skip' | 'parallel'>(init?.overlap || 'skip');
  const [edges, setEdges] = useState<AutoChainEdge[]>(init?.onComplete?.next || []);
  const [branch, setBranch] = useState(init?.branch || '');
  const [branches, setBranches] = useState<string[]>([]);
  const [isRepo, setIsRepo] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  // 分支列表（基于此分支隔离执行）；新建任务默认落到当前分支。
  useEffect(() => {
    automation.branches(cwd).then((r) => {
      setIsRepo(!!r.repo);
      setBranches(r.branches || []);
      if (!init?.branch && r.current) setBranch(r.current);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);
  // 绑定会话：拉该目录的会话列表，给用户看名字（存的仍是 sessionId）。
  useEffect(() => {
    if (targetKind !== 'bind') return;
    localAgent.listSessions(provider as ProviderId, cwd).then((ss) => setSessions(ss || []));
  }, [targetKind, provider, cwd]);

  const sessionLabel = (s: SessionSummary) => s.title || (s.preview ? s.preview.slice(0, 36) : '') || `session ${s.sessionId.slice(0, 8)}`;
  const others = all.filter((t) => t.id !== init?.id);
  const addEdge = (taskId: string) => { if (taskId && !edges.some((e) => e.taskId === taskId)) setEdges([...edges, { taskId, passOutput: true, onlyIfSuccess: true }]); };

  const submit = () => {
    if (!name.trim()) return;
    const task: Partial<AutomationTask> = {
      id: init?.id, cwd, name: name.trim(), prompt,
      provider, permMode: init?.permMode || 'bypassPermissions',
      enabled: init?.enabled ?? true,
      branch: targetKind === 'bind' ? undefined : (branch || undefined),
      target: targetKind === 'bind' ? { kind: 'bind', sessionId: bindSid || null } : { kind: 'new' },
      trigger: trigKind === 'interval' ? { kind: 'interval', everyMs: Math.max(1, everyMin) * 60000 }
        : trigKind === 'cron' ? { kind: 'cron', cron: cron.trim() }
          : { kind: 'manual' },
      onComplete: { next: edges },
      overlap,
    };
    onSave(task);
  };

  return (
    <div className="v2-auto-form">
      <label className="fld"><span>{tr('auto.name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('auto.namePh')} autoFocus />
      </label>
      <label className="fld"><span>{tr('auto.prompt')}</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder={tr('auto.promptPh')} />
      </label>
      <div className="fld-row">
        <label className="fld"><span>{tr('auto.trigger')}</span>
          <select value={trigKind} onChange={(e) => setTrigKind(e.target.value as AutoTriggerKind)}>
            <option value="manual">{tr('auto.manual')}</option>
            <option value="interval">{tr('auto.interval')}</option>
            <option value="cron">cron</option>
          </select>
        </label>
        {trigKind === 'interval' && (
          <label className="fld"><span>{tr('auto.everyMinLabel')}</span>
            <input type="number" min={1} value={everyMin} onChange={(e) => setEveryMin(Number(e.target.value) || 1)} />
          </label>
        )}
        {trigKind === 'cron' && (
          <label className="fld grow"><span>cron (min hour dom mon dow)</span>
            <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
          </label>
        )}
      </div>
      <div className="fld-row">
        <label className="fld"><span>{tr('auto.target')}</span>
          <select value={targetKind} onChange={(e) => setTargetKind(e.target.value as 'new' | 'bind')}>
            <option value="new">{tr('auto.targetNew')}</option>
            <option value="bind">{tr('auto.targetBind')}</option>
          </select>
        </label>
        {targetKind === 'new' && (
          <label className="fld grow"><span>{tr('auto.branch')}</span>
            {isRepo ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)}>
                {!branches.includes(branch) && branch && <option value={branch}>{branch}</option>}
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={tr('auto.notRepo')} disabled />}
          </label>
        )}
        {targetKind === 'bind' && (
          <label className="fld grow"><span>{tr('auto.bindSession')}</span>
            <select value={bindSid} onChange={(e) => setBindSid(e.target.value)}>
              <option value="">{tr('auto.pickSession')}</option>
              {sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{sessionLabel(s)}</option>)}
              {bindSid && !sessions.some((s) => s.sessionId === bindSid) && <option value={bindSid}>{bindSid.slice(0, 12)}…</option>}
            </select>
          </label>
        )}
      </div>
      <div className="fld-row">
        <label className="fld"><span>{tr('auto.provider')}</span>
          <EngineSelect value={provider} onChange={setProvider} />
        </label>
        <label className="fld grow"><span>{tr('auto.overlap')}</span>
          <select value={overlap} onChange={(e) => setOverlap(e.target.value as 'skip' | 'parallel')}>
            <option value="skip">{tr('auto.overlapSkip')}</option>
            <option value="parallel">{tr('auto.overlapParallel')}</option>
          </select>
          <span className="hint">{tr('auto.overlapHint')}</span>
        </label>
      </div>
      {targetKind === 'new' && isRepo && <div className="v2-auto-branchnote"><IcoBranch />{tr('auto.branchNote')}</div>}

      {/* 链路：完成后触发下游任务（输出当 prompt 传入） */}
      <div className="fld">
        <span>{tr('auto.chainNext')}</span>
        <div className="v2-auto-edges">
          {edges.map((e) => {
            const target = all.find((t) => t.id === e.taskId);
            return (
              <div key={e.taskId} className="edge">
                <span className="enm">{target?.name || e.taskId}{target && target.cwd !== cwd && <em className="xdir"> · {target.cwd.split('/').pop()}</em>}</span>
                <label className="chk"><input type="checkbox" checked={e.passOutput} onChange={(ev) => setEdges(edges.map((x) => x.taskId === e.taskId ? { ...x, passOutput: ev.target.checked } : x))} />{tr('auto.passOutput')}</label>
                <label className="chk"><input type="checkbox" checked={e.onlyIfSuccess} onChange={(ev) => setEdges(edges.map((x) => x.taskId === e.taskId ? { ...x, onlyIfSuccess: ev.target.checked } : x))} />{tr('auto.onlyIfSuccess')}</label>
                <button className="rm" onClick={() => setEdges(edges.filter((x) => x.taskId !== e.taskId))}><IcoX /></button>
              </div>
            );
          })}
          {others.length > 0 && (
            <select className="add-edge" value="" onChange={(e) => addEdge(e.target.value)}>
              <option value="">{tr('auto.addNext')}</option>
              {others.filter((t) => !edges.some((e) => e.taskId === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}{t.cwd !== cwd ? ` · ${t.cwd.split('/').pop()}` : ''}</option>)}
            </select>
          )}
        </div>
      </div>

      <div className="v2-auto-form-ft">
        <button className="ghost" onClick={onCancel}>{tr('common.cancel')}</button>
        <button className="prim" disabled={!name.trim()} onClick={submit}>{tr('common.save')}</button>
      </div>
    </div>
  );
};

/* ---------------- 单个任务行 ---------------- */
const TaskRow: React.FC<{
  task: AutomationTask;
  runs: AutomationRun[];
  inCycle: boolean;
  onRun: () => void; onCancel: () => void; onEdit: () => void; onDelete: () => void; onToggle: () => void;
  onLoadRuns: () => void;
}> = ({ task, runs, inCycle, onRun, onCancel, onEdit, onDelete, onToggle, onLoadRuns }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [runOpen, setRunOpen] = useState<string | null>(null);
  const last = runs[0];
  const isRunning = last?.status === 'running';
  useEffect(() => { if (open) onLoadRuns(); /* eslint-disable-next-line */ }, [open]);

  return (
    <div className={`v2-auto-task${task.enabled ? '' : ' off'}${inCycle ? ' cyc' : ''}`}>
      <div className="v2-auto-task-hd">
        <button className={`exp${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="toggle"><IcoChevRight /></button>
        <button className={`sw${task.enabled ? ' on' : ''}`} onClick={onToggle} title={task.enabled ? tr('auto.enabled') : tr('auto.disabled')} aria-label="enable"><i /></button>
        <span className="nm" title={task.name}>{task.name}</span>
        <span className="trg"><TrigIcon kind={task.trigger?.kind} />{triggerLabel(task, tr)}</span>
        <span className="grow" />
        {last && <span className={`dot ${last.status}`} title={last.status} />}
        {isRunning
          ? <button className="act stop" onClick={onCancel} title={tr('auto.cancel')}><IcoStop /></button>
          : <button className="act run" onClick={onRun} title={tr('auto.runNow')}><IcoPlay /></button>}
        <button className="act" onClick={onEdit} title={tr('common.edit')}><IcoEdit /></button>
        <button className="act del" onClick={onDelete} title={tr('common.delete')}><IcoTrash /></button>
      </div>
      {inCycle && <div className="v2-auto-cyc-tag"><IcoAlert />{tr('auto.inCycle')}</div>}
      {open && (
        <div className="v2-auto-task-bd">
          <div className="meta">
            {task.target?.kind === 'bind'
              ? <span className="chip"><IcoTarget />{tr('auto.targetBind')}</span>
              : <span className="chip"><IcoBranch />{task.branch || tr('auto.targetNew')}</span>}
            <span className="chip"><ProviderLogo id={task.provider || 'claude'} />{PROVIDER_LABELS[task.provider || 'claude'] || task.provider}</span>
          </div>
          {task.prompt && <div className="pr">{task.prompt}</div>}
          <div className="runs-hd">{tr('auto.runs')}</div>
          {runs.length === 0 ? <div className="empty">{tr('auto.noRuns')}</div> : runs.slice(0, 12).map((r) => (
            <div key={r.id} className="run">
              <button className="run-hd" onClick={() => setRunOpen((x) => x === r.id ? null : r.id)}>
                <span className={`dot ${r.status}`} />
                <span className="st">{tr(`auto.status.${r.status}`)}</span>
                <span className="by">{tr(`auto.by.${r.triggeredBy}`)}</span>
                <span className="grow" />
                <span className="tm">{relTime(r.startedAt, tr)}</span>
              </button>
              {runOpen === r.id && (
                <div className="run-bd">
                  {r.error && <div className="err">{r.error}</div>}
                  {r.output ? <pre className="out">{r.output}</pre> : <div className="empty">{tr('auto.noOutput')}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------------- 主面板 ---------------- */
export const AutomationPanel: React.FC<{ cwd: string | null; activeSessionId: string | null; provider?: string }> = ({ cwd, activeSessionId, provider = 'claude' }) => {
  const { t: tr } = useI18n();
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [runsByTask, setRunsByTask] = useState<Record<string, AutomationRun[]>>({});
  const [graph, setGraph] = useState<AutomationGraph>({ edges: [], inCycle: [], chains: [] });
  const [editing, setEditing] = useState<AutomationTask | Partial<AutomationTask> | 'new' | null>(null);
  const [graphChain, setGraphChain] = useState<string[] | null>(null);   // 点链路 → n8n 式画布

  const reload = useCallback(() => {
    if (!cwd) { setTasks([]); return; }
    automation.list(cwd).then((r) => setTasks(r.tasks || []));
    automation.graph().then((r) => setGraph(r.graph || { edges: [], inCycle: [], chains: [] }));
  }, [cwd]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const off = automation.onEvent((data) => {
      if (data.type === 'tasks') reload();
      else if (data.type === 'run' && data.run) {
        const run = data.run;
        setRunsByTask((m) => { const arr = [run, ...(m[run.taskId] || []).filter((x) => x.id !== run.id)]; return { ...m, [run.taskId]: arr.slice(0, 50) }; });
      }
    });
    return off;
  }, [reload]);

  const loadRuns = useCallback((id: string) => { automation.runs(id).then((r) => setRunsByTask((m) => ({ ...m, [id]: r.runs || [] }))); }, []);

  const inCycleSet = useMemo(() => new Set(graph.inCycle), [graph]);
  const cyclicChains = graph.chains.filter((c) => c.hasCycle);
  // 跨目录任务（链路里指向别的 cwd 的目标）也列进来，方便管理整条链。
  const allTasksForEdit = tasks;   // Phase 1：编辑链路时从当前 cwd 任务里选；跨目录在链路视图(后续)统管

  const save = useCallback((task: Partial<AutomationTask>) => {
    automation.save(task).then(() => { setEditing(null); reload(); });
  }, [reload]);

  if (!cwd) return <div className="v2-auto-empty"><p className="t">{tr('auto.noDir')}</p></div>;

  return (
    <div className="v2-auto">
      {cyclicChains.length > 0 && (
        <div className="v2-auto-cycwarn"><IcoAlert />{tr('auto.cycleWarn', { n: cyclicChains.length })}</div>
      )}
      <div className="v2-auto-hd">
        <span className="cnt">{tasks.length} · {tr('auto.tasks')}</span>
        <span className="grow" />
        <button className="v2-auto-add" onClick={() => setEditing('new')}><IcoPlus />{tr('auto.new')}</button>
      </div>

      {editing && (
        <TaskForm
          cwd={cwd}
          activeSessionId={activeSessionId}
          defaultProvider={provider}
          all={allTasksForEdit}
          init={editing === 'new' ? null : editing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {tasks.length === 0 && !editing ? (
        <div className="v2-auto-empty">
          <p className="t">{tr('auto.empty')}</p>
          <p className="h">{tr('auto.emptyHint')}</p>
          <div className="v2-auto-tpls">
            <div className="tpl-hd">{tr('auto.tplHd')}</div>
            {TEMPLATES.map((tpl) => (
              <button key={tpl.key} className="v2-auto-tpl" onClick={() => setEditing({ name: tr(`auto.tpl.${tpl.key}.name`), prompt: tr(`auto.tpl.${tpl.key}.prompt`), trigger: tpl.trigger, target: { kind: 'new' } })}>
                <span className="ic"><TrigIcon kind={tpl.trigger.kind} /></span>
                <span className="tx"><b>{tr(`auto.tpl.${tpl.key}.name`)}</b><span>{tr(`auto.tpl.${tpl.key}.desc`)}</span></span>
                <span className="go"><IcoChevRight /></span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="v2-auto-list">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              runs={runsByTask[t.id] || []}
              inCycle={inCycleSet.has(t.id)}
              onRun={() => automation.runNow(t.id)}
              onCancel={() => automation.cancel(t.id)}
              onEdit={() => setEditing(t)}
              onDelete={() => { if (confirm(tr('auto.confirmDelete', { name: t.name }))) automation.delete(t.id).then(reload); }}
              onToggle={() => automation.setEnabled(t.id, !t.enabled).then(reload)}
              onLoadRuns={() => loadRuns(t.id)}
            />
          ))}
        </div>
      )}

      {/* 链路摘要：把成链的任务按连通分量分组，列出涉及的工作目录 + 环提示。 */}
      {graph.chains.length > 0 && (
        <div className="v2-auto-chains">
          <div className="hd"><IcoLink />{tr('auto.chains')}</div>
          {graph.chains.map((c, i) => (
            <button key={i} className={`chain${c.hasCycle ? ' cyc' : ''}`} onClick={() => setGraphChain(c.tasks)} title={tr('auto.openChainView')}>
              {c.nodes && c.nodes.length ? (
                <span className="flow">
                  {c.nodes.map((n, j) => (
                    <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {j > 0 && <span className="arr"><IcoChevRight /></span>}
                      <span className={`node${n.cyc ? ' cyc' : ''}`} title={n.cwd}>{n.name}</span>
                    </span>
                  ))}
                </span>
              ) : <span className="n">{tr('auto.chainNodes', { n: c.tasks.length })}</span>}
              {c.hasCycle && <span className="badge"><IcoAlert />{tr('auto.hasCycle')}</span>}
              <span className="open"><IcoExpand /></span>
            </button>
          ))}
        </div>
      )}

      {graphChain && <ChainGraphView graph={graph} chainTasks={graphChain} onClose={() => setGraphChain(null)} />}
    </div>
  );
};
