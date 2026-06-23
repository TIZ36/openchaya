/**
 * AgentsPanel —— 右侧检视列：本地 Agent 管理 + 召唤实况（取代旧「会话互问围观面板」）。
 *
 * 单例，portal 进 #v2-inspector-slot（与 wiki/代码列同区域、复用 .v2-wiki-drawer 外壳）。
 * 两段：
 *   ① 召唤中 —— 进行中/最近的 agent-summon（及遗留的 # 互问）实时卡片：看 agent 被拉起作答的过程；
 *   ② 我的 Agent —— 角色清单（头像/名/能力/provider/RAG），可打开绑定会话 / 编辑 / 解绑。
 * 底部「升格说明」。答复由 AgentSummonController 自动折回主会话，这里也保留手动「纳入」兜底。
 *
 * 导出名沿用 SessionBridgePanel（ClientShell 已引用），语义已是 Agent 面板。
 */
import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getAsks, onAsksChange, type SessionAsk } from './services/sessionBridge';
import { listAgents, subscribeAgents, deleteAgent, type LocalAgent } from './services/agents';
import { IconAgent } from './LocalAgentView';
import { AgentFace } from './AgentFace';

// 检视列拖宽：与 wiki/代码列共用根节点 --wiki-w + 同一持久化键（宽度跨面板一致）。
const WIKI_W_KEY = 'chaya_wiki_w';
const WIKI_W_MIN = 320;
const WIKI_W_MAX = 680;

// 行内小图标（16 viewBox，1.4 线宽，同 IconAgent 风格）。
const IconOpen = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2.5h4v4" /><path d="M13.5 2.5l-6 6" /><path d="M12 9.5V13a.5.5 0 0 1-.5.5h-8A.5.5 0 0 1 3 13V5a.5.5 0 0 1 .5-.5H7" /></svg>);
const IconEdit = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2.6 13.4h2.6l7-7a1.8 1.8 0 0 0-2.6-2.6l-7 7v2.6z" /><path d="M9 5l2 2" /></svg>);
const IconUnbind = () => (<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6.6 9.4l2.8-2.8" /><path d="M7.2 4.6l1.1-1.1a2.4 2.4 0 0 1 3.4 3.4l-1.1 1.1" /><path d="M8.8 11.4l-1.1 1.1a2.4 2.4 0 0 1-3.4-3.4l1.1-1.1" /><path d="M11.5 11.5l1 1M3.5 3.5l1 1" /></svg>);

export interface SessionBridgePanelProps {
  /** 把答复折回发起会话（插入其 composer 草稿）。 */
  onAdopt: (fromCwd: string, text: string) => void;
  /** provider logo 渲染（父层注入，避免循环依赖）。 */
  logo?: (provider: string) => React.ReactNode;
  /** provider 显示名。 */
  labelFor?: (provider: string) => string;
  /** 打开某 Agent 的绑定会话（跳转，由父层用 la.openSession 实现）。 */
  onOpenAgent?: (agent: LocalAgent) => void;
}

function useAsks(): SessionAsk[] {
  return useSyncExternalStore(onAsksChange, getAsks, getAsks);
}


const AgentRow: React.FC<{ agent: LocalAgent; activeAsk?: SessionAsk } & Pick<SessionBridgePanelProps, 'logo' | 'onOpenAgent'>> = ({ agent, activeAsk, logo, onOpenAgent }) => {
  const edit = () => window.dispatchEvent(new CustomEvent('chaya:promoteAgent', { detail: { agentId: agent.id, provider: agent.provider, dir: agent.dir, sessionId: agent.sessionId, title: agent.description || agent.name } }));
  const unbind = () => {
    deleteAgent(agent.id);
    try { window.dispatchEvent(new CustomEvent('chaya:toast', { detail: { text: `@${agent.name} 已解绑（会话保留）` } })); } catch { /* */ }
  };
  const busy = !!activeAsk && (activeAsk.phase === 'pending' || activeAsk.phase === 'running');
  return (
    <div className={`v2-ag-row${busy ? ' busy' : ''}`}>
      <div className="main">
        <span className="av"><AgentFace seed={agent.name || agent.id} /></span>
        <div className="meta">
          <div className="nm">@{agent.name}{agent.memory && <span className="mem" title="挂接了 smartnote 外置记忆">RAG</span>}{!!agent.ledger?.writeCount && <span className="mem" title="已写入记忆条数">记忆 {agent.ledger.writeCount}</span>}</div>
          <div className="ds" title={agent.description}>{agent.description || '（无描述）'}</div>
          <div className="bind"><span className="lg" data-prov={agent.provider}>{logo?.(agent.provider)}</span>{agent.dir.split('/').pop()}</div>
        </div>
        <div className="acts">
          <button className="open" onClick={() => onOpenAgent?.(agent)} title="打开绑定会话"><IconOpen /><span>打开</span></button>
          <button className="icon" onClick={edit} title="编辑 Agent" aria-label="编辑 Agent"><IconEdit /></button>
          <button className="icon danger" onClick={unbind} title="解绑（不删会话）" aria-label="解绑"><IconUnbind /></button>
        </div>
      </div>
      {busy && (
        <div className="summoned"><i className="dot" aria-hidden />被「{activeAsk!.fromTitle || '某会话'}」会话召唤中…</div>
      )}
    </div>
  );
};

export const SessionBridgePanel: React.FC<SessionBridgePanelProps & { open?: boolean; dir?: string | null }> = ({ open = true, dir = null, ...props }) => {
  const allAsks = useAsks();
  // 召唤实况：默认看当前工作目录发起的；未给 dir 看全部。
  const asks = useMemo(() => (dir ? allAsks.filter((a) => a.fromDir === dir) : allAsks), [allAsks, dir]);
  const running = asks.filter((a) => a.phase === 'pending' || a.phase === 'running').length;

  const [agents, setAgents] = useState<LocalAgent[]>(() => listAgents());
  useEffect(() => subscribeAgents(() => setAgents(listAgents())), []);
  // 每个 agent 最近一次召唤（驱动卡片上的实时流输出，item 2）。
  const askByAgent = useMemo(() => {
    const m = new Map<string, SessionAsk>();
    for (const a of allAsks) {
      if (!a.agentId) continue;
      const prev = m.get(a.agentId);
      if (!prev || a.ts > prev.ts) m.set(a.agentId, a);
    }
    return m;
  }, [allAsks]);

  // 右侧检视列：展开时给根节点打 data-bridge-right，让 grid 第二列展开到 --insp-w；回填上次拖出的宽度。
  useEffect(() => {
    const root = typeof document !== 'undefined' ? (document.querySelector('.chaya-v2') as HTMLElement | null) : null;
    if (!root) return;
    if (open) {
      const saved = Number(localStorage.getItem(WIKI_W_KEY));
      if (saved >= WIKI_W_MIN && saved <= WIKI_W_MAX) root.style.setProperty('--wiki-w', `${saved}px`);
      root.setAttribute('data-bridge-right', 'on');
    } else {
      root.removeAttribute('data-bridge-right');
    }
    return () => root.removeAttribute('data-bridge-right');
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

  if (!open) return null;
  const host: Element = (typeof document !== 'undefined'
    && (document.getElementById('v2-inspector-slot') || document.querySelector('.chaya-v2'))) || document.body;
  return createPortal(
    <aside className="v2-wiki-drawer v2-bridge-drawer" role="complementary" aria-label="Agents" onMouseDown={(e) => e.stopPropagation()}>
      <div className="v2-wiki-grip" onMouseDown={startResize} aria-hidden />
      <div className="v2-xs-top">
        <b>Agents</b>
        {running > 0 && <span className="v2-xs-count">{running} 召唤中</span>}
        <div className="v2-grow" />
      </div>

      {/* 召唤的流式输出走对话内联小卡 + 大弹框，这里的列表只做「我的 Agent」清单 + 被召唤状态。 */}
      <div className="v2-xs-list">
        {agents.length === 0
          ? <div className="v2-xs-empty">还没有 Agent。在左侧会话行点 <IconAgent /> 把一个会话升格成有身份的本地 Agent，之后在输入框打 <b>@</b> 即可召唤它。</div>
          : agents.map((a) => <AgentRow key={a.id} agent={a} activeAsk={askByAgent.get(a.id)} logo={props.logo} onOpenAgent={props.onOpenAgent} />)}
      </div>
    </aside>,
    host,
  );
};
