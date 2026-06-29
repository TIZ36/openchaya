/* ------------------------------------------------------------------ *
 * AgentEvolveStrip —— 升格 Agent 会话「对话输入框底部」的自进化实时条。
 *
 * 两个栏目「记忆」「autoskill」+ 一行动态生成的提示（轮播最近沉淀）+ 进化时入场动画。
 * 点栏目 → 在其上方弹出**该栏目自己的信息列表**（记忆块 / 技能卡，eva 风格），不是 Agent 资料。
 * 数据真源在主进程 evolve.cjs（本地 SQLite）。
 * ------------------------------------------------------------------ */
import React, { useEffect, useMemo, useState } from 'react';
import {
  listSkills as evListSkills, listMemory as evListMemory, subscribeEvolution, isEvolveAvailable,
  approveSkill as evApprove, vetoSkill as evVeto, reviseSkill as evRevise, deleteSkill as evDelete,
  type EvolveSkill, type EvolveBlock, type EvolutionEvent,
} from './services/evolve';
import { upsertSkill, normalizeSkillName, loadSkills } from './services/skills';
import { getAgent } from './services/agents';
import { smartnoteMemories, type Memory } from '../services/smartnoteApi';
import { uiPrompt } from './services/uiPrompt';

function toast(text: string) {
  try { window.dispatchEvent(new CustomEvent('chaya:toast', { detail: { text } })); } catch { /* */ }
}

const HINT_ROTATE_MS = 3800;
const POLL_MS = 6000;

const MAT_LABEL: Record<string, string> = {
  draft: 'draft', trusted: 'trusted', promoted: 'promoted', rejected: 'rejected', archived: 'archived',
};
const SRC_LABEL: Record<string, string> = { induced: '归纳', user: '上传', ai: 'ai安装' };
function ladder(m: string): ('done' | 'on' | 'off')[] {
  if (m === 'draft') return ['on', 'off', 'off'];
  if (m === 'trusted') return ['done', 'on', 'off'];
  if (m === 'promoted') return ['done', 'done', 'on'];
  return ['off', 'off', 'off'];
}

export const AgentEvolveStrip: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [skills, setSkills] = useState<EvolveSkill[]>([]);
  const [blocks, setBlocks] = useState<EvolveBlock[]>([]);
  const [snMems, setSnMems] = useState<Memory[]>([]);   // SmartNote 云记忆（agent 挂了外置记忆才有）
  const [flash, setFlash] = useState(0);
  const [burst, setBurst] = useState<string>('');
  const [hintIdx, setHintIdx] = useState(0);
  const [panel, setPanel] = useState<null | 'mem' | 'skill'>(null);
  const [openBody, setOpenBody] = useState<Set<string>>(new Set());   // 展开预览正文的技能名
  const toggleBody = (n: string) => setOpenBody((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const [memSel, setMemSel] = useState<string | null>(null);          // 热力图选中的记忆 key

  const refresh = React.useCallback(() => {
    void evListSkills(agentId).then(setSkills);
    void evListMemory(agentId).then((m) => setBlocks(m.blocks));
    // SmartNote 云记忆：agent 挂了外置记忆(workspace tag)才拉，按 tag 过滤。
    const mem = getAgent(agentId)?.memory;
    if (mem?.provider === 'smartnote-cloud') {
      void smartnoteMemories.list({ tag: mem.workspaceTag?.trim() || undefined, limit: 30 })
        .then((r) => setSnMems(r.memories || []))
        .catch(() => setSnMems([]));
    } else {
      setSnMems([]);
    }
  }, [agentId]);

  useEffect(() => {
    if (!isEvolveAvailable()) return;
    refresh();
    const poll = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(poll);
  }, [refresh]);

  useEffect(() => subscribeEvolution((d: { agentId: string; event: EvolutionEvent }) => {
    if (d.agentId !== agentId) return;
    refresh();
    setFlash((f) => f + 1);
    if (d.event?.summary) { setBurst(d.event.summary); window.setTimeout(() => setBurst(''), 6000); }
  }), [agentId, refresh]);

  const drafts = useMemo(() => skills.filter((s) => s.maturity === 'draft'), [skills]);
  const live = useMemo(() => skills.filter((s) => s.maturity === 'trusted' || s.maturity === 'promoted'), [skills]);
  const visible = useMemo(() => skills.filter((s) => s.maturity !== 'rejected'), [skills]);

  // 记忆统一成「格子项」：本地块 + SmartNote 云记忆，按更新时间降序（越新越靠前、颜色越浓）。
  type MemItem = { key: string; kind: 'local' | 'sn'; title: string; body: string; sub?: string; ts: number };
  const memItems = useMemo<MemItem[]>(() => {
    const local: MemItem[] = blocks.map((b) => ({ key: `b${b.id}`, kind: 'local', title: b.label, body: b.value, sub: b.description, ts: b.updated_at || 0 }));
    const sn: MemItem[] = snMems.map((m) => ({ key: `s${m.id}`, kind: 'sn', title: `${m.pinned ? '📌 ' : ''}${m.kind}`, body: m.content, sub: m.tags.join(' · '), ts: Date.parse(m.updated_at) || 0 }));
    return [...local, ...sn].sort((a, b) => b.ts - a.ts);
  }, [blocks, snMems]);
  const memSelItem = memItems.find((m) => m.key === memSel) || null;

  const hints = useMemo(() => {
    const out: string[] = [];
    for (const b of blocks.slice(0, 3)) out.push(`记住偏好 · ${b.label}：${b.value}`);
    for (const d of drafts.slice(0, 3)) out.push(`归纳草稿 · ${d.name}（待你认可）`);
    for (const s of live.slice(0, 3)) out.push(`已掌握 · ${s.name}`);
    if (out.length === 0) {
      out.push('多聊几轮，我会悄悄记住你的偏好');
      out.push('出现可复用的多步方法时，我会归纳成 autoskill');
    }
    return out;
  }, [blocks, drafts, live]);

  useEffect(() => {
    if (burst) return;
    const id = window.setInterval(() => setHintIdx((i) => (i + 1) % Math.max(1, hints.length)), HINT_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [burst, hints.length]);

  // 技能动作
  const onApprove = async (n: string) => { await evApprove(agentId, n); refresh(); };
  const onVeto = async (n: string) => { const r = await uiPrompt('否决理由（给自己看）：', '没用 / 是硬凑的'); if (r === null) return; await evVeto(agentId, n, r); refresh(); };
  const onRevise = async (s: EvolveSkill) => { const body = await uiPrompt(`修订「${s.name}」的步骤正文（仍为草稿待认可）：`, s.body, { multiline: true }); if (body === null) return; await evRevise(agentId, s.name, { body }); refresh(); };
  const onDelete = async (n: string) => { if (!window.confirm(`删除技能「${n}」？`)) return; await evDelete(agentId, n); refresh(); };
  // 升格为可 / 呼出的 Chaya 技能：名字固定 auto-<用户短语>（ASCII；/ 命令只认 ASCII）。
  const onPromoteToSkill = async (s: EvolveSkill) => {
    const phrase = await uiPrompt('给它起个短语，将成为 /auto-短语（在输入框打 / 呼出，英文/数字）：', s.name.replace(/^auto-/, ''));
    if (phrase === null) return;
    let slug = normalizeSkillName(phrase.trim());
    if (!slug) slug = normalizeSkillName(s.name) || 'skill';
    const name = slug.startsWith('auto-') ? slug : `auto-${slug}`;
    const exists = loadSkills().some((x) => x.name.toLowerCase() === name.toLowerCase());
    if (exists && !window.confirm(`/${name} 已存在，覆盖它？`)) return;
    upsertSkill({ name, description: s.description || `由 autoskill「${s.name}」升格`, body: s.body });
    toast(`已升格为 /${name} · 输入框打 / 即可呼出`);
  };

  if (!isEvolveAvailable()) return null;

  const hint = burst || hints[hintIdx % hints.length] || '';
  const toggle = (p: 'mem' | 'skill') => setPanel((cur) => (cur === p ? null : p));

  return (
    <div className="v2-evostrip-wrap">
      {panel && (
        <>
          <div className="v2-evostrip-scrim" onMouseDown={() => setPanel(null)} />
          <div className="v2-evostrip-pop v2-evo" role="dialog">
            {panel === 'mem' && (
              <div className="v2-evo-list">
                <div className="v2-evo-cap">记忆 · {memItems.length} 块 <span className="mut">（本地 {blocks.length} · 云 {snMems.length}，点格看详情）</span></div>
                {memItems.length === 0 && <p className="v2-evo-empty">暂无记忆（多对话几轮，回合后自动蒸馏；挂了 SmartNote 还会带云记忆）</p>}
                {memItems.length > 0 && (
                  <div className="v2-evo-heat">
                    {memItems.map((it, i) => (
                      <button
                        key={it.key}
                        type="button"
                        className={`cell ${it.kind}${memSel === it.key ? ' sel' : ''}`}
                        style={{ opacity: 0.45 + 0.55 * (1 - i / Math.max(1, memItems.length - 1)) }}
                        title={`${it.title}：${it.body.slice(0, 60)}`}
                        onClick={() => setMemSel((k) => (k === it.key ? null : it.key))}
                      />
                    ))}
                  </div>
                )}
                {memSelItem && (
                  <div className="v2-evo-memo open detail">
                    <div className="hd">
                      <span className={`tag ${memSelItem.kind}`}>{memSelItem.kind === 'sn' ? 'SmartNote' : '本地'}</span>
                      <span className="k">{memSelItem.title}</span>
                      {memSelItem.sub && <span className="d" title={memSelItem.sub}>{memSelItem.sub}</span>}
                    </div>
                    <div className="v">{memSelItem.body}</div>
                  </div>
                )}
                {memItems.length > 0 && (
                  <div className="v2-evo-heat-legend">
                    <span><i className="sw local" />本地蒸馏</span>
                    <span><i className="sw sn" />SmartNote 云</span>
                    <span className="mut">颜色越深越新</span>
                  </div>
                )}
              </div>
            )}
            {panel === 'skill' && (
              <div className="v2-evo-list">
                <div className="v2-evo-cap">autoskill · 技能库 <span className="mut">（{visible.length}）</span></div>
                {visible.length === 0 && <p className="v2-evo-empty">暂无技能。出现可复用多步方法时会自动归纳成草稿。</p>}
                {visible.map((s) => {
                  const lad = ladder(s.maturity);
                  const isDraft = s.maturity === 'draft';
                  return (
                    <div key={s.name} className={`v2-evo-skill${s.maturity === 'archived' ? ' muted' : ''}`}>
                      <button type="button" className="v2-evo-skill-hd as-btn" onClick={() => toggleBody(s.name)} title="点击预览 / 收起步骤正文">
                        <span className="ic" aria-hidden>★</span><span className="nm">{s.name}</span>
                        <span className={`chev${openBody.has(s.name) ? ' open' : ''}`} aria-hidden>▸</span>
                      </button>
                      {s.description && <p className="v2-evo-skill-desc">{s.description}</p>}
                      {openBody.has(s.name) && <pre className="v2-evo-skill-body">{s.body || '（空）'}</pre>}
                      {s.maturity !== 'archived' && (
                        <div className="v2-evo-ladder">
                          {['归纳', '复用', '提升'].map((step, i) => (
                            <span key={step} className="seg"><span className={`st ${lad[i]}`}>{step}</span>{i < 2 && <span className="arr">›</span>}</span>
                          ))}
                        </div>
                      )}
                      <div className="v2-evo-badges">
                        {SRC_LABEL[s.source] && <span className={`bdg src-${s.source}`}>{SRC_LABEL[s.source]}</span>}
                        <span className={`bdg mat-${s.maturity}`}>{MAT_LABEL[s.maturity] || s.maturity}</span>
                        <span className="bdg">×{s.uses}</span>
                      </div>
                      <div className="v2-evo-acts">
                        {isDraft && <button type="button" className="ok" onClick={() => void onApprove(s.name)}>认可启用</button>}
                        <button type="button" className="hi" onClick={() => onPromoteToSkill(s)} title="升格为可 / 呼出的 Chaya 技能（auto-短语）">升格为 /技能</button>
                        <button type="button" onClick={() => void onRevise(s)}>修订</button>
                        {isDraft && <button type="button" className="warn" onClick={() => void onVeto(s.name)}>否决</button>}
                        <button type="button" className="warn" onClick={() => void onDelete(s.name)}>删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <div className="v2-evostrip" data-flash={flash}>
        <button type="button" key={`m${flash}`} className={`v2-evostrip-chip${flash ? ' pulse' : ''}${panel === 'mem' ? ' on' : ''}`} onClick={() => toggle('mem')} title="查看这个 Agent 记住的偏好/事实">
          <span className="ic" aria-hidden>◔</span>
          <span className="lb">记忆</span>
          <span className="n">{blocks.length + snMems.length}</span>
        </button>
        <button type="button" key={`s${flash}`} className={`v2-evostrip-chip${flash ? ' pulse' : ''}${panel === 'skill' ? ' on' : ''}`} onClick={() => toggle('skill')} title="autoskill：系统自动归纳的可复用方法">
          <span className="ic" aria-hidden>★</span>
          <span className="lb">autoskill</span>
          <span className="n">{live.length}</span>
          {drafts.length > 0 && <span className="pend" title={`${drafts.length} 个草稿待认可`}>+{drafts.length}</span>}
        </button>
        <span className="v2-evostrip-hint" key={burst || hintIdx}>
          <i className="spark" aria-hidden />
          <span className="tx">{hint}</span>
        </span>
      </div>
    </div>
  );
};
