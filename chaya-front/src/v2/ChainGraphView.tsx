/* ============================================================
   ChainGraphView —— n8n 式任务链画布（全屏浮层）。
   点链路摘要里的一条链 → 这里把它画成节点图：任务=节点，onComplete=贝塞尔连线。
   支持平移(拖背景)/缩放(滚轮/按钮)/拖动节点/适配视图；环上的边红色虚线 + 警告。
   纯前端布局：忽略回边做分层(最长路径)，根在左、下游向右。
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { ProviderLogo, PROVIDER_LABELS } from './LocalAgentView';
import type { AutomationGraph, AutomationGraphNode, AutomationGraphEdge } from './services/automation';

const NODE_W = 252, NODE_H = 172, COL_GAP = 88, ROW_GAP = 32, PAD = 60;

const S = (p: React.ReactNode, w = 14, fill = false) => (
  <svg viewBox="0 0 24 24" width={w} height={w} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{p}</svg>
);
const IcoClose = () => S(<path d="M18 6 6 18M6 6l12 12" />);
const IcoPlus = () => S(<path d="M12 5v14M5 12h14" />, 15);
const IcoMinus = () => S(<path d="M5 12h14" />, 15);
const IcoFit = () => S(<><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></>, 15);
const IcoAlert = () => S(<><path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, 14);
const TrigIco: React.FC<{ k?: string }> = ({ k }) => k === 'interval'
  ? S(<><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></>, 12)
  : k === 'cron'
    ? S(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 14l2 2-2 2M12 18h4" /></>, 12)
    : S(<path d="M9 11V6a1.5 1.5 0 0 1 3 0v5M12 11V5a1.5 1.5 0 0 1 3 0v6M15 11V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-2a5 5 0 0 1-3.5-1.5L4 15a1.6 1.6 0 0 1 2.3-2.2L8 14.5V8a1.5 1.5 0 0 1 3 0" />, 12);

type Pos = { x: number; y: number };

function trigText(n: AutomationGraphNode, tr: (k: string, v?: any) => string): string {
  const t = n.trigger; const k = t?.kind;
  if (k === 'interval') { const min = Math.round((t!.everyMs || 0) / 60000); return min % 60 === 0 && min >= 60 ? tr('auto.everyHours', { n: min / 60 }) : tr('auto.everyMins', { n: min }); }
  if (k === 'cron') return `cron ${t!.cron || ''}`;
  return tr('auto.manual');
}
function permText(p?: string): string { return p === 'acceptEdits' ? 'acceptEdits' : p === 'plan' ? 'plan' : 'bypass'; }

/** 分层布局：忽略回边 → Kahn 拓扑 → rank=上游最长路径+1；同层纵向堆叠。 */
function layout(ids: string[], edges: AutomationGraphEdge[]): Record<string, Pos> {
  const within = new Set(ids);
  const out = new Map<string, string[]>();
  ids.forEach((id) => out.set(id, []));
  const E = edges.filter((e) => within.has(e.from) && within.has(e.to));
  for (const e of E) out.get(e.from)!.push(e.to);
  // 标记回边（DFS 栈上的目标）。
  const stateM = new Map<string, number>();
  const back = new Set<string>();
  const dfs = (u: string) => {
    stateM.set(u, 1);
    for (const v of out.get(u)!) {
      if (stateM.get(v) === 1) back.add(`${u}->${v}`);
      else if (!stateM.get(v)) dfs(v);
    }
    stateM.set(u, 2);
  };
  ids.forEach((id) => { if (!stateM.get(id)) dfs(id); });
  const fwd = E.filter((e) => !back.has(`${e.from}->${e.to}`));
  const indeg = new Map<string, number>(); ids.forEach((id) => indeg.set(id, 0));
  for (const e of fwd) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const rank = new Map<string, number>(); ids.forEach((id) => rank.set(id, 0));
  const q = ids.filter((id) => (indeg.get(id) || 0) === 0);
  const adjF = new Map<string, string[]>(); ids.forEach((id) => adjF.set(id, []));
  for (const e of fwd) adjF.get(e.from)!.push(e.to);
  const deg = new Map(indeg);
  while (q.length) {
    const u = q.shift()!;
    for (const v of adjF.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      deg.set(v, deg.get(v)! - 1);
      if (deg.get(v) === 0) q.push(v);
    }
  }
  const byRank = new Map<number, string[]>();
  ids.forEach((id) => { const r = rank.get(id)!; (byRank.get(r) || byRank.set(r, []).get(r)!).push(id); });
  const pos: Record<string, Pos> = {};
  for (const [r, list] of byRank) {
    list.forEach((id, i) => { pos[id] = { x: PAD + r * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP) }; });
  }
  return pos;
}

export const ChainGraphView: React.FC<{
  graph: AutomationGraph;
  chainTasks: string[];
  onClose: () => void;
}> = ({ graph, chainTasks, onClose }) => {
  const { t: tr } = useI18n();
  const ids = useMemo(() => chainTasks.filter((id) => (graph.nodes || []).some((n) => n.id === id)), [chainTasks, graph]);
  const nodeMap = useMemo(() => new Map((graph.nodes || []).map((n) => [n.id, n])), [graph]);
  const edges = useMemo(() => graph.edges.filter((e) => ids.includes(e.from) && ids.includes(e.to)), [graph, ids]);
  const hasCycle = edges.some((e) => e.cyc);

  const [pos, setPos] = useState<Record<string, Pos>>(() => layout(ids, edges));
  const [view, setView] = useState({ x: 40, y: 40, k: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number } | null>(null);

  // 适配视图：把整张图缩放居中。
  const fit = useCallback(() => {
    const el = canvasRef.current; if (!el || ids.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) { const p = pos[id]; if (!p) continue; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H); }
    if (!isFinite(minX)) return;
    const w = el.clientWidth, h = el.clientHeight;
    const gw = maxX - minX + 80, gh = maxY - minY + 80;
    const k = Math.min(1.2, Math.max(0.3, Math.min(w / gw, h / gh)));
    setView({ k, x: (w - (maxX + minX) * k) / 2, y: (h - (maxY + minY) * k) / 2 });
  }, [ids, pos]);
  useEffect(() => { const t = setTimeout(fit, 30); return () => clearTimeout(t); /* eslint-disable-next-line */ }, []);
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    const el = canvasRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.25, v.k * factor));
      const gx = (cx - v.x) / v.k, gy = (cy - v.y) / v.k;
      return { k, x: cx - gx * k, y: cy - gy * k };
    });
  };
  const onDown = (e: React.MouseEvent, id?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = id
      ? { mode: 'node', id, sx: e.clientX, sy: e.clientY, ox: pos[id].x, oy: pos[id].y }
      : { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    const onMove = (ev: MouseEvent) => {
      const d = drag.current; if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (d.mode === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
      else setPos((p) => ({ ...p, [d.id!]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } }));
    };
    const onUp = () => { drag.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };

  const edgePath = (a: Pos, b: Pos) => {
    const sx = a.x + NODE_W, sy = a.y + NODE_H / 2, tx = b.x, ty = b.y + NODE_H / 2;
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
    return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
  };

  const host = (typeof document !== 'undefined' && (document.querySelector('.chaya-v2') || document.body)) || document.body;
  return createPortal(
    <div className="v2-chain-overlay" onMouseDown={onClose}>
      <div className="v2-chain-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-chain-hd">
          <span className="ttl">{tr('auto.chainView')}</span>
          <span className="meta">{tr('auto.chainNodes', { n: ids.length })}</span>
          {hasCycle && <span className="cyc"><IcoAlert />{tr('auto.cycleWarn', { n: 1 })}</span>}
          <span className="grow" />
          <button className="x" onClick={onClose} title={tr('common.close')}><IcoClose /></button>
        </div>
        <div className="v2-chain-canvas" ref={canvasRef} onMouseDown={(e) => onDown(e)} onWheel={onWheel}>
          <div className="v2-chain-grid" />
          <div className="v2-chain-vp" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="v2-chain-edges" width="20000" height="20000">
              <defs>
                <marker id="v2arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8 z" fill="var(--c-ink-4)" /></marker>
                <marker id="v2arrowcyc" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8 z" fill="var(--c-danger)" /></marker>
              </defs>
              {edges.map((e, i) => {
                const a = pos[e.from], b = pos[e.to]; if (!a || !b) return null;
                return (
                  <g key={i}>
                    <path d={edgePath(a, b)} className={`wire${e.cyc ? ' cyc' : ''}`} markerEnd={e.cyc ? 'url(#v2arrowcyc)' : 'url(#v2arrow)'} />
                    {(e.passOutput || e.onlyIfSuccess) && (() => {
                      const mx = (a.x + NODE_W + b.x) / 2, my = (a.y + b.y) / 2 + NODE_H / 2;
                      const label = [e.passOutput ? tr('auto.passOutput') : '', e.onlyIfSuccess ? tr('auto.onlyIfSuccess') : ''].filter(Boolean).join(' · ');
                      return <foreignObject x={mx - 50} y={my - 11} width="100" height="22"><div className="v2-chain-edgelbl">{label}</div></foreignObject>;
                    })()}
                  </g>
                );
              })}
            </svg>
            {ids.map((id) => {
              const n = nodeMap.get(id) as AutomationGraphNode; const p = pos[id]; if (!n || !p) return null;
              return (
                <div key={id} className={`v2-chain-node${n.cyc ? ' cyc' : ''}${n.enabled === false ? ' off' : ''}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                  onMouseDown={(e) => onDown(e, id)}>
                  <span className="port in" />
                  <div className="nhd">
                    <span className="tic"><TrigIco k={n.trigger?.kind} /></span>
                    <b title={n.name}>{n.name}</b>
                    <span className={`en ${n.enabled === false ? 'off' : 'on'}`} title={n.enabled === false ? tr('auto.disabled') : tr('auto.enabled')} />
                  </div>
                  <div className="ncwd" title={n.cwd}>{n.cwd.split('/').pop()}</div>
                  <div className="nrows">
                    <div className="r"><span className="k">{tr('auto.trigger')}</span><span className="v">{trigText(n, tr)}</span></div>
                    <div className="r"><span className="k">{tr('auto.target')}</span><span className="v">{n.target?.kind === 'bind' ? tr('auto.targetBind') : (n.branch || tr('auto.targetNew'))}</span></div>
                    <div className="r"><span className="k">{tr('auto.provider')}</span><span className="v eng"><ProviderLogo id={n.provider || 'claude'} />{PROVIDER_LABELS[n.provider || 'claude'] || n.provider}</span></div>
                    <div className="r"><span className="k">{tr('auto.overlap')}</span><span className="v">{n.overlap === 'parallel' ? tr('auto.overlapParallel') : tr('auto.overlapSkip')} · {permText(n.permMode)}</span></div>
                  </div>
                  {n.prompt && <div className="nprompt" title={n.prompt}>{n.prompt}</div>}
                  <span className="port out" />
                </div>
              );
            })}
          </div>
          <div className="v2-chain-tools" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => setView((v) => ({ ...v, k: Math.min(2.2, v.k * 1.15) }))} title="+"><IcoPlus /></button>
            <button onClick={() => setView((v) => ({ ...v, k: Math.max(0.25, v.k / 1.15) }))} title="−"><IcoMinus /></button>
            <button onClick={fit} title={tr('auto.fit')}><IcoFit /></button>
          </div>
        </div>
      </div>
    </div>,
    host,
  );
};
