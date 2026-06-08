/* ============================================================
   ReviewPanel —— code changes 侧栏「评审」tab。
   按当前工作目录(cwd)：抓 git 工作区改动(vs HEAD，含未跟踪) → 自由选 provider →
   跑一条只读评审 → 落库留历史。同一份 diff 可交叉跑多个 AI 对比。
   纯本地（electron/review.cjs）。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { review, type ReviewRun, type ReviewPreview } from './services/review';
import { localAgent, type DetectedProvider, type ProviderId, type ModelInfo } from './services/localAgent';
import { ProviderLogo, PROVIDER_LABELS, MD } from './LocalAgentView';

const PROVIDERS: ProviderId[] = ['claude', 'codex', 'gemini', 'cursor', 'copilot'];

/* 各引擎可靠的模型别名（作为建议；权威列表用活动会话的 modelOptions，其它一律支持自由输入）。 */
const MODEL_SUGGEST: Record<string, string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

const S = (p: React.ReactNode, fill = false, w = 13) => (
  <svg viewBox="0 0 24 24" width={w} height={w} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>
);
const IcoPlay = () => S(<path d="M6 4.5v15l13-7.5z" />, true);
const IcoStop = () => S(<rect x="6" y="6" width="12" height="12" rx="1.5" />, true);
const IcoChevDown = () => S(<polyline points="6 9 12 15 18 9" />, false, 11);
const IcoChevRight = () => S(<polyline points="9 6 15 12 9 18" />, false, 13);
const IcoTrash = () => S(<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />);
// 提示词 icon：消息气泡 + 文字行（= 发给 AI 的评审指引）。
const IcoPrompt = () => S(<><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M7 9h10M7 12.5h6" /></>, false, 13);
// 发送到对话：纸飞机。
const IcoSendChat = () => S(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />, false, 13);
// 续用会话 / 新会话：循环箭头。
const IcoReuse = () => S(<><path d="M3 11V9a4 4 0 0 1 4-4h10M21 13v2a4 4 0 0 1-4 4H7" /><path d="M17 1l4 4-4 4M7 23l-4-4 4-4" /></>, false, 11);
// 在此会话继续评审：圈内播放。
const IcoContinue = () => S(<><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l5-3.5z" /></>, false, 13);

function relTime(ms: number | null | undefined, tr: (k: string, v?: any) => string): string {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return tr('local.time.justNow');
  if (d < 3600_000) return tr('local.time.minutes', { n: Math.floor(d / 60_000) });
  if (d < 86400_000) return tr('local.time.hours', { n: Math.floor(d / 3600_000) });
  return tr('local.time.days', { n: Math.floor(d / 86400_000) });
}

/* provider 选择器：显示真实 logo + 名字 + 下拉（未安装的标灰但仍可选——交叉覆盖时按需安装）。 */
const ProviderPick: React.FC<{ value: string; detected: DetectedProvider[]; onChange: (id: string) => void }> = ({ value, detected, onChange }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const ready = (id: string) => detected.find((d) => d.id === id)?.installed ?? true;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="v2-rev-engine" ref={ref}>
      <button type="button" className="v2-rev-engine-btn" onClick={() => setOpen((o) => !o)}>
        <ProviderLogo id={value} /><span className="lb">{PROVIDER_LABELS[value] || value}</span>
        <span className="chev"><IcoChevDown /></span>
      </button>
      {open && (
        <div className="v2-rev-engine-menu" role="listbox">
          {PROVIDERS.map((p) => (
            <button key={p} type="button" role="option" aria-selected={p === value} className={`it${p === value ? ' on' : ''}${ready(p) ? '' : ' off'}`} onClick={() => { onChange(p); setOpen(false); }}>
              <ProviderLogo id={p} className={ready(p) ? '' : 'off'} />
              <span className="nm">{PROVIDER_LABELS[p] || p}</span>
              {!ready(p) && <span className="st">{tr('review.notInstalled')}</span>}
              {p === value && <span className="ck" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* 模型选择器：可选已知模型或自由输入任意模型 id（空 = 引擎默认模型）。 */
const ModelPick: React.FC<{ value: string; suggestions: ModelInfo[]; onChange: (v: string) => void }> = ({ value, suggestions, onChange }) => {
  const { t: tr } = useI18n();
  const listId = 'v2-rev-models';
  return (
    <div className="v2-rev-model">
      <input
        list={listId}
        value={value}
        spellCheck={false}
        placeholder={tr('review.modelDefault')}
        onChange={(e) => onChange(e.target.value)}
        title={tr('review.model')}
      />
      <datalist id={listId}>
        {suggestions.map((m) => <option key={m.value} value={m.value}>{m.displayName || m.value}</option>)}
      </datalist>
      {value && <button className="clr" onClick={() => onChange('')} title={tr('review.modelDefault')} aria-label="clear">×</button>}
    </div>
  );
};

/* 一条评审结果的短摘要（取输出首行；没有则退到改动文件数）。 */
function runSummary(run: ReviewRun, tr: (k: string, v?: any) => string): string {
  const first = (run.output || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  if (first) return first.length > 38 ? `${first.slice(0, 38)}…` : first;
  return tr('review.nFiles', { n: run.fileCount });
}

/* 续用目标选择器：可选「新会话」或某条历史评审结果（= 在那个会话里继续）。 */
const SessionPick: React.FC<{ value: string | null; options: ReviewRun[]; onPick: (sid: string | null) => void }> = ({ value, options, onPick }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const sel = value ? options.find((o) => o.sessionId === value) : null;
  return (
    <div className="v2-rev-sess" ref={ref}>
      <button type="button" className={`v2-rev-sess-btn${value ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title={value ? tr('review.continueIn') : tr('review.targetNew')}>
        <IcoReuse />
        <span className="lb">{sel ? runSummary(sel, tr) : tr('review.targetNew')}</span>
        <span className="chev"><IcoChevDown /></span>
      </button>
      {open && (
        <div className="v2-rev-sess-menu" role="listbox">
          <button type="button" role="option" aria-selected={!value} className={`it${!value ? ' on' : ''}`} onClick={() => { onPick(null); setOpen(false); }}>
            <span className="nm">{tr('review.targetNew')}</span>{!value && <span className="ck">✓</span>}
          </button>
          {options.length > 0 && <div className="sep">{tr('review.continueHd')}</div>}
          {options.map((o) => (
            <button key={o.sessionId!} type="button" role="option" aria-selected={o.sessionId === value} className={`it${o.sessionId === value ? ' on' : ''}`} onClick={() => { onPick(o.sessionId!); setOpen(false); }}>
              <span className="nm" title={runSummary(o, tr)}>{runSummary(o, tr)}</span>
              {o.sessionId === value && <span className="ck">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------------- 单条评审记录 ---------------- */
const ReviewRow: React.FC<{ run: ReviewRun; defaultOpen?: boolean; canSend: boolean; active?: boolean; onCancel: () => void; onDelete: () => void; onSendToChat: (text: string) => void; onContinue?: () => void }> = ({ run, defaultOpen, canSend, active, onCancel, onDelete, onSendToChat, onContinue }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(!!defaultOpen);
  const [showDiff, setShowDiff] = useState(false);
  const [sent, setSent] = useState(false);
  const running = run.status === 'running';
  const send = () => { if (!run.output) return; onSendToChat(run.output); setSent(true); setTimeout(() => setSent(false), 1600); };
  const canContinue = !running && !!run.sessionId && !!onContinue;
  return (
    <div className={`v2-rev-run ${run.status}${active ? ' active' : ''}`}>
      {active && <span className="v2-rev-active-tag" title={tr('review.activeTarget')}><IcoReuse />{tr('review.activeTarget')}</span>}
      <div className="v2-rev-run-hd">
        <button className={`exp${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="toggle"><IcoChevRight /></button>
        <span className={`dot ${run.status}`} />
        <ProviderLogo id={run.provider} />
        <span className="nm">{PROVIDER_LABELS[run.provider] || run.provider}</span>
        {run.model && <span className="mdl" title={tr('review.model')}>{run.model}</span>}
        {run.resumedFrom && <span className="rsm" title={tr('review.resumed')}><IcoReuse /></span>}
        <span className="fc">{tr('review.nFiles', { n: run.fileCount })}</span>
        <span className="grow" />
        <span className="tm">{relTime(run.startedAt, tr)}</span>
        {/* 在此会话继续评审：以这条结果的会话为上下文，对最新 worktree 再评一轮。 */}
        {canContinue && (
          <button className="act cont" onClick={onContinue} title={tr('review.continueIn')}><IcoContinue /></button>
        )}
        {/* 发送到对话：把评审结果灌进当前 CLI 会话输入框，可直接让 agent 去改。 */}
        {!running && run.output && canSend && (
          <button className={`act send${sent ? ' done' : ''}`} onClick={send} title={tr('review.sendToChat')}><IcoSendChat /></button>
        )}
        {running
          ? <button className="act stop" onClick={onCancel} title={tr('review.cancel')}><IcoStop /></button>
          : <button className="act del" onClick={onDelete} title={tr('common.delete')}><IcoTrash /></button>}
      </div>
      {open && (
        <div className="v2-rev-run-bd">
          <button className={`v2-rev-files-hd${showDiff ? ' open' : ''}`} onClick={() => setShowDiff((s) => !s)}>
            <span className={`chev${showDiff ? ' open' : ''}`}><IcoChevRight /></span>
            {tr('review.scope', { n: run.fileCount })}{run.truncated ? ` · ${tr('review.truncated')}` : ''}
          </button>
          {showDiff && (
            <div className="v2-rev-files">
              {run.files.map((f) => (
                <div key={f.path} className="f">
                  <span className={`st ${f.untracked ? 'new' : 'mod'}`}>{f.untracked ? 'U' : 'M'}</span>
                  <span className="p" title={f.path}>{f.path}</span>
                  {f.adds > 0 && <span className="add">+{f.adds}</span>}
                  {f.dels > 0 && <span className="del">−{f.dels}</span>}
                </div>
              ))}
            </div>
          )}
          {run.error && <div className="v2-rev-err">{run.error === 'aborted' ? tr('review.aborted') : run.error}</div>}
          {running && !run.output && <div className="v2-rev-running">{tr('review.running')}</div>}
          {run.output && <div className="v2-rev-out"><MD text={run.output} /></div>}
          {!running && !run.output && !run.error && <div className="v2-rev-running">{tr('review.noOutput')}</div>}
        </div>
      )}
    </div>
  );
};

/* ---------------- 主面板 ---------------- */
export const ReviewPanel: React.FC<{ cwd: string | null; provider?: string; modelOptions?: ModelInfo[]; activeProvider?: string; onSendToChat?: (text: string) => void }> = ({ cwd, provider = 'claude', modelOptions = [], activeProvider, onSendToChat }) => {
  const { t: tr } = useI18n();
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [detected, setDetected] = useState<DetectedProvider[]>([]);
  const [prov, setProv] = useState(provider);
  const [model, setModel] = useState('');   // '' = 引擎默认模型
  const [guidance, setGuidance] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [starting, setStarting] = useState(false);
  // 续用目标：auto=跟最近一次会话(省 token 默认)；用户显式选某条结果或「新会话」后置 false。
  const [auto, setAuto] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);   // 显式选择的 sessionId；null=新会话

  const reload = useCallback(() => {
    if (!cwd) { setRuns([]); setPreview(null); return; }
    review.list(cwd).then((r) => setRuns(r.runs || []));
    review.preview(cwd).then(setPreview);
  }, [cwd]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setProv(provider); }, [provider]);
  useEffect(() => { void localAgent.detect().then(setDetected); }, []);
  // 换引擎 → 回到「跟最近会话」默认（会话不能跨引擎续）+ 清掉模型（模型 id 是引擎专属）。
  useEffect(() => { setAuto(true); setPicked(null); setModel(''); }, [prov]);

  // 模型建议：评审引擎 == 活动会话引擎时用其权威 modelOptions，否则用静态别名；都支持自由输入。
  const modelSuggest = useMemo<ModelInfo[]>(() => {
    if (activeProvider === prov && modelOptions.length) return modelOptions;
    return (MODEL_SUGGEST[prov] || []).map((v) => ({ value: v, displayName: v }));
  }, [activeProvider, prov, modelOptions]);

  // 实时：评审进度/完成 + 列表变更回推。
  useEffect(() => {
    const off = review.onEvent((data) => {
      if (data.type === 'run' && data.run) {
        if (cwd && data.run.cwd !== cwd) return;
        setRuns((arr) => [data.run, ...arr.filter((x) => x.id !== data.run.id)].slice(0, 50));
        if (data.run.status !== 'running') { setStarting(false); if (cwd) review.preview(cwd).then(setPreview); }
      } else if (data.type === 'list') {
        if (!cwd || data.cwd === cwd) reload();
      } else if (data.type === 'error') {
        setStarting(false);
      }
    });
    return off;
  }, [cwd, reload]);

  // 当前引擎下可续用的会话（按 sessionId 去重，新→旧）。
  const resumable = useMemo(() => {
    const seen = new Set<string>(); const out: ReviewRun[] = [];
    for (const r of runs) {
      if (r.provider !== prov || !r.sessionId || r.status === 'running') continue;
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId); out.push(r);
    }
    return out;
  }, [runs, prov]);
  const latestSid = resumable[0]?.sessionId ?? null;
  const effectiveResume = auto ? latestSid : picked;   // 这次「评审」要续的会话（null=新会话）

  const hasChanges = !!preview?.repo && (preview.files.length > 0);
  const runReview = useCallback((opts: { provider?: string; resumeFrom?: string | null; model?: string }) => {
    if (!cwd || !hasChanges) return;
    setStarting(true);
    const p = opts.provider || prov;
    const m = (opts.model ?? model).trim();
    review.run({ cwd, provider: p, model: m || undefined, guidance: guidance.trim() || undefined, resumeFrom: opts.resumeFrom || undefined, fresh: !opts.resumeFrom });
  }, [cwd, hasChanges, prov, model, guidance]);
  // 在某条历史结果的会话里继续：切到它的引擎 + 锁定该会话 + 立即评审。
  const continueIn = useCallback((r: ReviewRun) => {
    if (!r.sessionId) return;
    setProv(r.provider); setAuto(false); setPicked(r.sessionId); setModel(r.model || '');
    runReview({ provider: r.provider, resumeFrom: r.sessionId, model: r.model || '' });
  }, [runReview]);
  const pickTarget = useCallback((sid: string | null) => { setAuto(false); setPicked(sid); }, []);

  const fileCount = preview?.files.length || 0;

  if (!cwd) return <div className="v2-rev-empty"><p className="t">{tr('review.noDir')}</p></div>;

  return (
    <div className="v2-rev">
      {/* 行动栏：引擎 · 提示词开关 · 评审（保持简洁，模型/续用归到下面的设置行）。 */}
      <div className="v2-rev-bar">
        <ProviderPick value={prov} detected={detected} onChange={setProv} />
        <button className="v2-rev-guide-btn" onClick={() => setShowGuide((s) => !s)} title={tr('review.guidance')} aria-pressed={showGuide}><IcoPrompt /></button>
        <span className="grow" />
        <button className="v2-rev-run-btn" disabled={!hasChanges || starting} onClick={() => runReview({ resumeFrom: effectiveResume })}>
          <IcoPlay />{starting ? tr('review.starting') : effectiveResume ? tr('review.runContinue') : tr('review.run')}
        </button>
      </div>

      {/* 设置行：模型（始终）+ 续用目标（有可续会话时）。 */}
      <div className="v2-rev-opt">
        <span className="lbl">{tr('review.model')}</span>
        <ModelPick value={model} suggestions={modelSuggest} onChange={setModel} />
      </div>
      {(resumable.length > 0 || !auto) && (
        <div className="v2-rev-opt">
          <span className="lbl">{tr('review.target')}</span>
          <SessionPick value={effectiveResume} options={resumable} onPick={pickTarget} />
        </div>
      )}

      {showGuide && (
        <textarea
          className="v2-rev-guide"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          rows={4}
          placeholder={tr('review.guidancePh')}
        />
      )}

      {/* 评审范围：当前工作区改动（事实来源 = git worktree vs HEAD）。 */}
      {preview && !preview.repo ? (
        <div className="v2-rev-scope none">{tr('review.notRepo')}</div>
      ) : fileCount === 0 ? (
        <div className="v2-rev-scope none">{tr('review.clean')}</div>
      ) : (
        <div className="v2-rev-scope">{tr('review.scope', { n: fileCount })}{preview?.truncated ? ` · ${tr('review.truncated')}` : ''}</div>
      )}

      <div className="v2-rev-list">
        {runs.length === 0 ? (
          <div className="v2-rev-empty">
            <p className="t">{tr('review.empty')}</p>
            <p className="h">{tr('review.emptyHint')}</p>
          </div>
        ) : runs.map((r, i) => (
          <ReviewRow
            key={r.id}
            run={r}
            defaultOpen={i === 0}
            canSend={!!onSendToChat}
            active={!!effectiveResume && r.sessionId === effectiveResume}
            onCancel={() => review.cancel(r.id)}
            onDelete={() => review.delete(cwd, r.id).then(reload)}
            onSendToChat={(text) => onSendToChat?.(text)}
            onContinue={() => continueIn(r)}
          />
        ))}
      </div>
    </div>
  );
};
