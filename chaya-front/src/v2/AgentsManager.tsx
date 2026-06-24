/* ------------------------------------------------------------------ *
 * 本地 Agent 升格 / 编辑弹层（事件驱动，单例挂在 ClientShell）。
 *   监听 `chaya:promoteAgent`（{provider,dir,sessionId,title,agentId?}）：把一个会话
 *   「升格 / 编辑」成有身份的本地 Agent（名/头像/能力/提示词/可选 smartnote 记忆）。
 *
 * 系统提示词 = 真·系统提示：绑定会话（claude）起/续接时作为 systemPrompt.append 注入，
 *   直接对话与召唤都生效、每轮都在（见 useLocalAgent / sessionBridge / localAgent.cjs）。
 *
 * 换绑：编辑时可把 agent 绑到「新会话」或「另一个已有会话」（agent 本身不消失，名/人设/记忆全留）。
 *   约束：一个会话只能被一个 agent 绑定——已被别的 agent 绑的会话不可选（rebindAgent 兜底校验）。
 *   绑新会话：记一个待绑标记 + 在目标目录起新会话，其首轮 init 拿到真实 id 时回填（takePendingBind）。
 * ------------------------------------------------------------------ */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getAgent, upsertAgent, agentNameTaken, normalizeAgentName, listAgents, setPendingBind,
  type AgentMemory,
} from './services/agents';
import { ProviderLogo, PROVIDER_LABELS } from './LocalAgentView';
import { localAgent, type ProviderId, type SessionSummary } from './services/localAgent';

interface PromoteSeed {
  agentId?: string;
  provider: ProviderId;
  dir: string;
  sessionId: string;
  title: string;
}

const REBIND_PROVIDERS: ProviderId[] = ['claude', 'cursor', 'codex', 'gemini', 'copilot'];

function toast(text: string) {
  try { window.dispatchEvent(new CustomEvent('chaya:toast', { detail: { text } })); } catch { /* */ }
}

/** 升格 / 编辑表单。 */
const AgentPromoteModal: React.FC = () => {
  const [seed, setSeed] = useState<PromoteSeed | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [memOn, setMemOn] = useState(false);
  const [memTag, setMemTag] = useState('');
  const [memKey, setMemKey] = useState('');
  const [memTopK, setMemTopK] = useState('5');
  const [memDistill, setMemDistill] = useState(true);

  // 换绑状态（仅编辑已有 agent 时可用）
  const [rebindOpen, setRebindOpen] = useState(false);
  const [bindMode, setBindMode] = useState<'existing' | 'new'>('existing');
  const [bindProvider, setBindProvider] = useState<ProviderId>('claude');
  const [bindDir, setBindDir] = useState('');
  const [bindSessionId, setBindSessionId] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessLoading, setSessLoading] = useState(false);

  const reset = () => { setName(''); setDescription(''); setTags(''); setSystemPrompt(''); setMemOn(false); setMemTag(''); setMemKey(''); setMemTopK('5'); setMemDistill(true); };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as PromoteSeed;
      if (!d?.sessionId) return;
      setSeed(d);
      setRebindOpen(false); setBindMode('existing');
      setBindProvider(d.provider); setBindDir(d.dir); setBindSessionId(d.sessionId);
      setSessions([]);
      const existing = d.agentId ? getAgent(d.agentId) : undefined;
      if (existing) {
        setName(existing.name); setDescription(existing.description || '');
        setTags((existing.tags || []).join(', ')); setSystemPrompt(existing.systemPrompt || '');
        setMemOn(!!existing.memory); setMemTag(existing.memory?.workspaceTag || ''); setMemKey(existing.memory?.apiKey || '');
        setMemTopK(String(existing.memory?.topK ?? 5)); setMemDistill(existing.memory?.autoDistill !== false);
      } else {
        reset();
        setName(normalizeAgentName(d.title || '') || 'agent');
        setDescription(d.title || '');
      }
    };
    window.addEventListener('chaya:promoteAgent', on as EventListener);
    return () => window.removeEventListener('chaya:promoteAgent', on as EventListener);
  }, []);

  // 换绑·已有会话：拉目标 (provider, dir) 的会话列表。
  useEffect(() => {
    if (!rebindOpen || bindMode !== 'existing' || !bindDir) return;
    setSessLoading(true);
    localAgent.listSessions(bindProvider, bindDir).then((ss) => setSessions(ss || [])).finally(() => setSessLoading(false));
  }, [rebindOpen, bindMode, bindProvider, bindDir]);

  const close = () => setSeed(null);

  const pickDir = async () => {
    const p = await localAgent.pickFolder();
    if (p) { setBindDir(p); setBindSessionId(''); }
  };

  const save = () => {
    if (!seed) return;
    const nm = normalizeAgentName(name);
    if (!nm) { toast('请填写 Agent 名字'); return; }
    if (agentNameTaken(nm, seed.agentId)) { toast(`@${nm} 已被占用，换个名字`); return; }
    const memory: AgentMemory | undefined = memOn
      ? { provider: 'smartnote-cloud', workspaceTag: memTag.trim() || undefined, apiKey: memKey.trim() || undefined, topK: Math.max(1, Math.min(20, parseInt(memTopK, 10) || 5)), autoDistill: memDistill }
      : undefined;

    // 最终绑定：编辑且开了换绑则用换绑选择，否则沿用 seed。
    const rebinding = !!seed.agentId && rebindOpen;
    const finalProvider = rebinding ? bindProvider : seed.provider;
    const finalDir = rebinding ? bindDir : seed.dir;
    let finalSessionId = rebinding ? bindSessionId : seed.sessionId;

    if (rebinding && bindMode === 'new') {
      finalSessionId = '';   // 待绑：先清空，新会话 init 后回填
    } else if (rebinding && bindMode === 'existing') {
      if (!finalSessionId) { toast('请选择一个会话，或改用「绑定新会话」'); return; }
      const other = listAgents().find((a) => a.id !== seed.agentId && a.sessionId === finalSessionId);
      if (other) { toast(`该会话已被 @${other.name} 绑定`); return; }
    }

    upsertAgent({
      id: seed.agentId, name: nm,
      description: description.trim(), tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      systemPrompt: systemPrompt.trim() || undefined,
      provider: finalProvider, dir: finalDir, sessionId: finalSessionId, memory,
    });

    if (rebinding && bindMode === 'new' && seed.agentId) {
      setPendingBind(seed.agentId, finalDir, finalProvider);
      try { window.dispatchEvent(new CustomEvent('chaya:bindNewSession', { detail: { provider: finalProvider, dir: finalDir } })); } catch { /* */ }
      toast(`@${nm} 将绑定到新会话…`);
    } else {
      toast(`@${nm} 已${seed.agentId ? '更新' : '升格为 Agent'}`);
    }
    close();
  };

  if (!seed) return null;
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  const editing = !!seed.agentId;
  const sessLabel = (s: SessionSummary) => s.title || (s.preview ? s.preview.slice(0, 40) : '') || `会话 ${s.sessionId.slice(0, 8)}`;

  return createPortal(
    <div className="v2-agent-scrim" onMouseDown={close}>
      <div className="v2-agent-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-agent-modal-hd">
          <span>{editing ? '编辑 Agent' : '升格为 Agent'}</span>
          <span className="bind"><ProviderLogo id={(rebindOpen ? bindProvider : seed.provider)} mono /> {PROVIDER_LABELS[rebindOpen ? bindProvider : seed.provider] || (rebindOpen ? bindProvider : seed.provider)} · {(rebindOpen ? bindDir : seed.dir).split('/').pop()}</span>
        </div>
        <div className="v2-agent-modal-bd">
          <label>名字（@-handle）<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="backend-expert" /></label>
          <label>能力描述（驱动 @ 联想）<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="精通本仓后端 API 与数据流" /></label>
          <label>触发关键词（逗号分隔，命中即自动召唤）<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="归因, pltv, 回传" /></label>
          <label>系统提示词（真·系统提示：直接对话/召唤都生效，每轮在）<textarea rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="你是本仓后端专家，回答务实、给出文件路径。" /></label>

          {/* 换绑会话：仅编辑已有 agent 时可用。 */}
          {editing && (
            <div className="v2-agent-rebind">
              <button type="button" className="v2-agent-rebind-tg" onClick={() => setRebindOpen((o) => !o)}>
                <span className={`chev${rebindOpen ? ' open' : ''}`}>▸</span> 换绑会话{!rebindOpen && <em>（保留人设/记忆，只换底层会话）</em>}
              </button>
              {rebindOpen && (
                <div className="v2-agent-rebind-bd">
                  <div className="v2-agent-seg">
                    <button type="button" className={bindMode === 'existing' ? 'on' : ''} onClick={() => setBindMode('existing')}>绑定已有会话</button>
                    <button type="button" className={bindMode === 'new' ? 'on' : ''} onClick={() => setBindMode('new')}>绑定新会话</button>
                  </div>
                  <div className="v2-agent-rebind-row">
                    <div className="provs">
                      {REBIND_PROVIDERS.map((p) => (
                        <button key={p} type="button" className={`prov${p === bindProvider ? ' on' : ''}`} title={PROVIDER_LABELS[p] || p}
                          onClick={() => { setBindProvider(p); setBindSessionId(''); }}><ProviderLogo id={p} mono /></button>
                      ))}
                    </div>
                    <button type="button" className="dirbtn" onClick={pickDir} title={bindDir}>📁 {bindDir.split('/').pop() || '选目录'}</button>
                  </div>

                  {bindMode === 'existing' ? (
                    <div className="v2-agent-sesslist">
                      {sessLoading ? <div className="hint">载入会话…</div>
                        : sessions.length === 0 ? <div className="hint">该目录下没有 {PROVIDER_LABELS[bindProvider] || bindProvider} 会话，可改用「绑定新会话」</div>
                          : sessions.map((s) => {
                            const owner = listAgents().find((a) => a.id !== seed.agentId && a.sessionId === s.sessionId);
                            const disabled = !!owner;
                            return (
                              <button key={s.sessionId} type="button" disabled={disabled}
                                className={`sess${s.sessionId === bindSessionId ? ' on' : ''}${disabled ? ' taken' : ''}`}
                                onClick={() => setBindSessionId(s.sessionId)} title={disabled ? `已被 @${owner!.name} 绑定` : sessLabel(s)}>
                                <span className="t">{sessLabel(s)}</span>
                                {disabled ? <span className="by">@{owner!.name}</span> : <span className="tn">{s.turns} 轮</span>}
                              </button>
                            );
                          })}
                    </div>
                  ) : (
                    <div className="v2-agent-rebind-note">保存后将在该目录起一个空会话并绑定给本 Agent（首条消息后落盘）。</div>
                  )}
                </div>
              )}
            </div>
          )}

          <label className="row"><input type="checkbox" checked={memOn} onChange={(e) => setMemOn(e.target.checked)} /> 挂接 smartnote-cloud 外置记忆（RAG）</label>
          {memOn && (
            <div className="v2-agent-mem">
              <label>知识域 / workspace tag<input value={memTag} onChange={(e) => setMemTag(e.target.value)} placeholder="留空=全局检索" /></label>
              <label>API Key（可选，留空用全局连接）<input value={memKey} onChange={(e) => setMemKey(e.target.value)} placeholder="sn_..." /></label>
              <label>注入片段数<input value={memTopK} onChange={(e) => setMemTopK(e.target.value)} placeholder="5" /></label>
              <label className="row"><input type="checkbox" checked={memDistill} onChange={(e) => setMemDistill(e.target.checked)} /> 每次回答完把问答存为记忆（带 ts）</label>
            </div>
          )}
        </div>
        <div className="v2-agent-modal-ft">
          <button className="ghost" onMouseDown={close}>取消</button>
          <button className="primary" onMouseDown={save}>{editing ? '保存' : '升格'}</button>
        </div>
      </div>
    </div>,
    host,
  );
};

/** 单例挂载点：升格/编辑弹层。Agent 清单已迁到右侧 Agent 面板。 */
export const AgentsManagerHost: React.FC = () => <AgentPromoteModal />;
