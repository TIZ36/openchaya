/* ------------------------------------------------------------------ *
 * 本地 Agent 升格 / 编辑弹层（事件驱动，单例挂在 ClientShell）。
 *   监听 `chaya:promoteAgent`（{provider,dir,sessionId,title,agentId?}）：把一个会话
 *   「升格 / 编辑」成有身份的本地 Agent（名/头像/能力/提示词/可选 smartnote 记忆）。
 *
 * Agent 清单/解绑/跳转在右侧检视列的 Agent 面板（SessionBridgePanel）里，不再用 modal。
 * 升格 promotion-only：Agent 必须绑定一个现有会话（记忆来源）。绑定期间该会话不可删
 * （守卫在 useLocalAgent.deleteSession）。召唤逻辑在 LocalAgentView 的 @ 下拉 + sessionBridge。
 * ------------------------------------------------------------------ */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getAgent, upsertAgent, agentNameTaken, normalizeAgentName,
  type AgentMemory,
} from './services/agents';
import { ProviderLogo, PROVIDER_LABELS } from './LocalAgentView';
import type { ProviderId } from './services/localAgent';

interface PromoteSeed {
  agentId?: string;
  provider: ProviderId;
  dir: string;
  sessionId: string;
  title: string;
}

function toast(text: string) {
  try { window.dispatchEvent(new CustomEvent('chaya:toast', { detail: { text } })); } catch { /* */ }
}

/** 升格 / 编辑表单。绑定信息（provider/dir/sessionId）来自触发的会话，不可在此改。 */
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

  const reset = () => { setName(''); setDescription(''); setTags(''); setSystemPrompt(''); setMemOn(false); setMemTag(''); setMemKey(''); setMemTopK('5'); setMemDistill(true); };

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as PromoteSeed;
      if (!d?.sessionId) return;
      setSeed(d);
      const existing = d.agentId ? getAgent(d.agentId) : undefined;
      if (existing) {
        setName(existing.name); setDescription(existing.description || '');
        setTags((existing.tags || []).join(', ')); setSystemPrompt(existing.systemPrompt || '');
        setMemOn(!!existing.memory); setMemTag(existing.memory?.workspaceTag || ''); setMemKey(existing.memory?.apiKey || '');
        setMemTopK(String(existing.memory?.topK ?? 5)); setMemDistill(existing.memory?.autoDistill !== false);
      } else {
        reset();
        // 默认用会话标题做初始名字（归一成 @-handle）。
        setName(normalizeAgentName(d.title || '') || 'agent');
        setDescription(d.title || '');
      }
    };
    window.addEventListener('chaya:promoteAgent', on as EventListener);
    return () => window.removeEventListener('chaya:promoteAgent', on as EventListener);
  }, []);

  const close = () => setSeed(null);
  const save = () => {
    if (!seed) return;
    const nm = normalizeAgentName(name);
    if (!nm) { toast('请填写 Agent 名字'); return; }
    if (agentNameTaken(nm, seed.agentId)) { toast(`@${nm} 已被占用，换个名字`); return; }
    const memory: AgentMemory | undefined = memOn
      ? { provider: 'smartnote-cloud', workspaceTag: memTag.trim() || undefined, apiKey: memKey.trim() || undefined, topK: Math.max(1, Math.min(20, parseInt(memTopK, 10) || 5)), autoDistill: memDistill }
      : undefined;
    upsertAgent({
      id: seed.agentId, name: nm,
      description: description.trim(), tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      systemPrompt: systemPrompt.trim() || undefined,
      provider: seed.provider, dir: seed.dir, sessionId: seed.sessionId, memory,
    });
    toast(`@${nm} 已${seed.agentId ? '更新' : '升格为 Agent'}`);
    close();
  };

  if (!seed) return null;
  // 必须 portal 进 .chaya-v2 根（而非 document.body）：否则主题 CSS 变量(--c-*)与
  // `.chaya-v2 .v2-agent-*` 选择器都不命中，弹层会变成无样式的全宽裸排版。
  const host: Element = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-agent-scrim" onMouseDown={close}>
      <div className="v2-agent-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-agent-modal-hd">
          <span>{seed.agentId ? '编辑 Agent' : '升格为 Agent'}</span>
          <span className="bind"><ProviderLogo id={seed.provider} mono /> {PROVIDER_LABELS[seed.provider] || seed.provider} · {seed.dir.split('/').pop()}</span>
        </div>
        <div className="v2-agent-modal-bd">
          <label>名字（@-handle）<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="backend-expert" /></label>
          <label>能力描述（驱动 @ 联想）<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="精通本仓后端 API 与数据流" /></label>
          <label>触发关键词（逗号分隔，命中即自动召唤）<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="归因, pltv, 回传" /></label>
          <label>系统提示词（召唤时前置，可选）<textarea rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} placeholder="你是本仓后端专家，回答务实、给出文件路径。" /></label>
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
          <button className="primary" onMouseDown={save}>{seed.agentId ? '保存' : '升格'}</button>
        </div>
      </div>
    </div>,
    host,
  );
};

/** 单例挂载点：升格/编辑弹层。Agent 清单已迁到右侧 Agent 面板。 */
export const AgentsManagerHost: React.FC = () => <AgentPromoteModal />;
