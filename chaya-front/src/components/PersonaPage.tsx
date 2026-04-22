import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAgents, deleteAgent, agentApiId, type Session } from '../services/chat';
import { updateRoleProfile, type PersonaPreset } from '../services/roleApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import {
  smartnoteMemories, getSmartnoteApiKey,
  type Memory, type MemoryKind,
} from '../services/smartnoteApi';
import { emitSessionsChanged } from '../utils/sessionEvents';
import { toast } from './ui/use-toast';
import {
  PaperPage, PaperTopbar, PaperContent, PaperButton, PaperChip, PaperTextarea,
} from './paper';

/* ============================================================
   人设 / Agent Dossier — aligned with mockups/a-agent-detail.html
   Shows the currently-selected agent as a two-column dossier.
   ============================================================ */

interface PersonaPageProps {
  sessionId: string | null;
  onOpenChat?: () => void;
}

const glyphFor = (s?: Session | null): string => {
  const name = (s?.name || s?.title || '').trim();
  return name ? name.charAt(0) : '茶';
};

const relDays = (iso?: string): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
};

const sinceAge = (iso?: string): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 30) return `${days} 天`;
  const months = Math.floor(days / 30);
  const remDays = days - months * 30;
  return remDays > 0 ? `${months} 月 ${remDays} 天` : `${months} 月`;
};

const PersonaPage: React.FC<PersonaPageProps> = ({ sessionId, onOpenChat }) => {
  const [agents, setAgents] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Edit buffers — form-level (not the saved shape on Session)
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [llmConfigId, setLlmConfigId] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [avatarDirty, setAvatarDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* Smartnote memories scoped to this agent — "它记得的事". */
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memLoading, setMemLoading] = useState(false);
  const [memErr, setMemErr] = useState<string | null>(null);
  const [memBusy, setMemBusy] = useState<Record<string, boolean>>({});

  /* Preset editor: null = closed, 'new' = creating, object = editing existing */
  const [presetEditor, setPresetEditor] = useState<null | 'new' | PersonaPreset>(null);
  const [presetName, setPresetName] = useState('');
  const [presetPrompt, setPresetPrompt] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const list = await getLLMConfigs();
        setConfigs(list.filter((c) => c.enabled));
      } catch {/* */}
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // getAgents() returns agent records with the agent UUID in `.id` —
      // that's what updateRoleProfile needs for its URL. Do NOT merge in
      // getSession() data: that's a conversation record with conv UUID in
      // `.id`, which would corrupt the agent id used for saving.
      const list = await getAgents();
      setAgents(list);
    } catch (e: any) {
      setErr(e?.message || '取 agent 时出错');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const agent = useMemo(() => {
    if (!sessionId) return agents.find((a) => a.is_primary) || agents[0] || null;
    return agents.find((a) => a.session_id === sessionId) || agents.find((a) => a.is_primary) || agents[0] || null;
  }, [agents, sessionId]);

  // Pull this agent's memories from Smartnote. ChatPage's save handler writes
  // them with scope `agent:<id>` — but the `<id>` it uses can be either the
  // agent UUID (`agent.id`) OR the conversation session_id, depending on
  // whether the agent record had loaded when the save fired. We accept both
  // and any trailing name tag, to avoid silent drift between save/read ids.
  //
  // Also: the Smartnote list endpoint's `scope` query param is an exact match,
  // and may not be honoured by every deploy. We fetch a broader slice (by the
  // agent's name tag) and filter client-side — this is immune to scope drift
  // and lets us show useful diagnostics when the filter is empty.
  const agentUuid = agent?.id || null;
  const agentSid = agent?.session_id || null;
  const agentName = (agent?.name || agent?.title || '').trim();
  useEffect(() => {
    if (!agentUuid && !agentSid) { setMemories([]); return; }
    if (!getSmartnoteApiKey()) {
      setMemories([]);
      setMemErr('没连 Smartnote — 去「设置 · 知识」填 API key');
      return;
    }
    let cancelled = false;
    setMemLoading(true);
    setMemErr(null);
    void (async () => {
      try {
        // Try the narrow filter first; if empty, widen to no-scope + client filter.
        const wantedScopes = new Set(
          [agentUuid, agentSid].filter(Boolean).map((id) => `agent:${id}`),
        );
        const narrow = await smartnoteMemories.list({
          scope: `agent:${agentUuid || agentSid}`,
          limit: 100,
        });
        if (cancelled) return;
        let list = (narrow.memories || []).filter((m) => wantedScopes.has(m.scope));
        if (list.length === 0) {
          // Backend may ignore the scope filter, or memories may have been
          // saved under a different id. Pull the whole workspace and filter
          // ourselves against any of: known scopes, or the agent's name tag.
          const wide = await smartnoteMemories.list({ limit: 200 });
          if (cancelled) return;
          list = (wide.memories || []).filter((m) =>
            wantedScopes.has(m.scope) ||
            (agentName && m.tags?.includes(agentName)),
          );
        }
        setMemories(list);
      } catch (e: any) {
        if (!cancelled) setMemErr(e?.message || '取不到记忆');
      } finally {
        if (!cancelled) setMemLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentUuid, agentSid, agentName]);

  const memoryBuckets = useMemo(() => {
    const groups: Record<MemoryKind, Memory[]> = {
      fact: [], preference: [], procedure: [], episode: [], document_ref: [],
    };
    for (const m of memories) {
      const k = (m.kind as MemoryKind) in groups ? (m.kind as MemoryKind) : 'fact';
      groups[k].push(m);
    }
    // Pinned first, then most-recent first.
    for (const k of Object.keys(groups) as MemoryKind[]) {
      groups[k].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at);
      });
    }
    return groups;
  }, [memories]);

  const togglePin = async (mem: Memory): Promise<void> => {
    setMemBusy((b) => ({ ...b, [mem.id]: true }));
    try {
      const next = await smartnoteMemories.update(mem.id, { pinned: !mem.pinned });
      setMemories((prev) => prev.map((m) => (m.id === mem.id ? next : m)));
    } catch (e: any) {
      toast({ title: '改不了', description: e?.message || '', variant: 'destructive' });
    } finally {
      setMemBusy((b) => { const n = { ...b }; delete n[mem.id]; return n; });
    }
  };

  const removeMemory = async (mem: Memory): Promise<void> => {
    if (!window.confirm('忘掉这条吗？忘了就找不回来了。')) return;
    setMemBusy((b) => ({ ...b, [mem.id]: true }));
    try {
      await smartnoteMemories.remove(mem.id);
      setMemories((prev) => prev.filter((m) => m.id !== mem.id));
    } catch (e: any) {
      toast({ title: '忘不掉', description: e?.message || '', variant: 'destructive' });
    } finally {
      setMemBusy((b) => { const n = { ...b }; delete n[mem.id]; return n; });
    }
  };

  /** Shared persona presets live on the primary agent's ext (global library). */
  const primaryAgent = useMemo(() => agents.find((a) => a.is_primary) || null, [agents]);

  const presets: PersonaPreset[] = useMemo(
    () => (primaryAgent?.ext as any)?.personaPresets ?? [],
    [primaryAgent],
  );

  const savePresets = async (next: PersonaPreset[]): Promise<void> => {
    if (!primaryAgent) {
      toast({ title: '存不了', description: '没找到主 agent。', variant: 'destructive' });
      return;
    }
    setPresetSaving(true);
    try {
      const ext = { ...(primaryAgent.ext || {}), personaPresets: next };
      await updateRoleProfile(agentApiId(primaryAgent), { ext });
      await load();
    } catch (e: any) {
      toast({ title: '保存共用人设失败', description: e?.message || '', variant: 'destructive' });
      throw e;
    } finally {
      setPresetSaving(false);
    }
  };

  const openNewPreset = () => {
    setPresetEditor('new');
    setPresetName('');
    setPresetPrompt(prompt || ''); // seed with current buffer for quick "save as preset"
  };

  const openEditPreset = (p: PersonaPreset) => {
    setPresetEditor(p);
    setPresetName(p.nickname);
    setPresetPrompt(p.system_prompt);
  };

  const closePresetEditor = () => {
    setPresetEditor(null);
    setPresetName('');
    setPresetPrompt('');
  };

  const submitPreset = async () => {
    const nm = presetName.trim();
    const sp = presetPrompt;
    if (!nm) { toast({ title: '得有个昵称', variant: 'destructive' }); return; }
    if (!sp.trim()) { toast({ title: '得有内容', variant: 'destructive' }); return; }
    const isNew = presetEditor === 'new';
    const next: PersonaPreset = isNew
      ? { id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, nickname: nm, system_prompt: sp }
      : { ...(presetEditor as PersonaPreset), nickname: nm, system_prompt: sp };
    const list = isNew
      ? [...presets, next]
      : presets.map((p) => (p.id === next.id ? next : p));
    try {
      await savePresets(list);
      toast({ title: isNew ? '加好了' : '改好了', variant: 'success' });
      closePresetEditor();
    } catch {/* toast already shown */}
  };

  const deletePreset = async (p: PersonaPreset) => {
    if (!confirm(`删掉预设「${p.nickname}」？`)) return;
    try {
      await savePresets(presets.filter((x) => x.id !== p.id));
      toast({ title: '删了' });
    } catch {/* */}
  };

  // Sync edit buffers when the selected agent changes
  useEffect(() => {
    setName(agent?.name || agent?.title || '');
    setPrompt(agent?.system_prompt || '');
    setLlmConfigId(agent?.llm_config_id || '');
    setAvatarDataUrl(agent?.avatar || null);
    setAvatarDirty(false);
  }, [agent?.session_id, agent?.system_prompt, agent?.name, agent?.title, agent?.llm_config_id, agent?.avatar]);

  // "dirty" = any buffer diverges from saved agent
  const dirty = useMemo(() => {
    if (!agent) return false;
    if ((agent.name || agent.title || '') !== name) return true;
    if ((agent.system_prompt || '') !== prompt) return true;
    if ((agent.llm_config_id || '') !== llmConfigId) return true;
    if (avatarDirty) return true;
    return false;
  }, [agent, name, prompt, llmConfigId, avatarDirty]);

  const saveAll = async () => {
    if (!agent || !dirty) return;
    setSaving(true);
    try {
      const updates: any = {};
      const trimmedName = name.trim();
      if (!trimmedName) {
        toast({ title: '名字不能空', variant: 'destructive' });
        setSaving(false);
        return;
      }
      if ((agent.name || agent.title || '') !== trimmedName) updates.name = trimmedName;
      if ((agent.system_prompt || '') !== prompt) updates.system_prompt = prompt;
      if ((agent.llm_config_id || '') !== llmConfigId) updates.llm_config_id = llmConfigId || null;
      if (avatarDirty) updates.avatar = avatarDataUrl || null;
      if (Object.keys(updates).length === 0) { setSaving(false); return; }

      // Payload-size sanity check — some backends cap request bodies at 2-4 MB.
      const approxBytes = JSON.stringify(updates).length;
      if (approxBytes > 4.5 * 1024 * 1024) {
        toast({ title: '太大了', description: `改动约 ${(approxBytes / 1024 / 1024).toFixed(1)} MB，把头像换小一点。`, variant: 'destructive' });
        setSaving(false);
        return;
      }

      const apiId = agentApiId(agent);
      await updateRoleProfile(apiId, updates);
      await load();
      emitSessionsChanged();
      toast({ title: '已保存', variant: 'success' });
    } catch (e: any) {
      // Show real backend message so we can see what mismatch it is.
      const raw = e?.message || String(e);
      console.error('[PersonaPage] saveAll failed:', e);
      toast({
        title: '保存失败',
        description: raw.includes('not found')
          ? '后端没找到这只 agent（URL 用的 id 可能不对）。刷新一下试试。'
          : raw,
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarPick = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({ title: '只接图片', variant: 'destructive' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: '太大了', description: '头像不超过 2 MB。', variant: 'destructive' });
      return;
    }
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      setAvatarDataUrl(dataUrl);
      setAvatarDirty(true);
    } catch {
      toast({ title: '读不了', variant: 'destructive' });
    }
  };

  const handleAvatarClear = () => {
    setAvatarDataUrl(null);
    setAvatarDirty(true);
  };

  const handleDelete = async () => {
    if (!agent) return;
    if (agent.is_primary) {
      toast({ title: '本命删不了', description: 'Primary agent 不可删。', variant: 'destructive' });
      return;
    }
    if (!confirm(`真要删掉「${agent.name || agent.title || '这只'}」吗？它的记忆会一起没。`)) return;
    setDeleting(true);
    try {
      await deleteAgent(agentApiId(agent));
      await load();
      emitSessionsChanged();
      toast({ title: '删了' });
      onOpenChat?.();
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  const applyPreset = async (preset: PersonaPreset) => {
    if (!agent) return;
    setSaving(true);
    try {
      const ext = { ...(agent.ext || {}), currentPersonaId: preset.id };
      await updateRoleProfile(agentApiId(agent), { system_prompt: preset.system_prompt, ext });
      setPrompt(preset.system_prompt);
      await load();
      toast({ title: `已切到「${preset.nickname}」`, variant: 'success' });
    } catch (e: any) {
      toast({ title: '切不动', description: e?.message || '', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const currentPresetId = (agent?.ext as any)?.currentPersonaId as string | undefined;
  const modelNice = useMemo(() => {
    if (!agent) return '—';
    const cfg = configs.find((c) => c.config_id === agent.llm_config_id);
    if (cfg) return cfg.shortname || cfg.model || cfg.name;
    const direct = (agent as any).model;
    if (typeof direct === 'string' && direct) return direct;
    return agent.llm_config_id ? `cfg-${agent.llm_config_id.slice(0, 6)}` : '未配置';
  }, [agent, configs]);

  return (
    <PaperPage>
      <PaperTopbar
        crumb={`Chapter Two · 人设档案 · No. ${agent?.is_primary ? '01' : '—'}`}
        title={agent?.name || agent?.title || '未选中 agent'}
        subtitle={agent ? `${agent.is_primary ? '本命 · ' : ''}已经陪你 ${sinceAge(agent.created_at)}` : '从上面的 "我养的" 挑一只'}
        meta={agent ? `${agent.message_count || 0} 条对话` : undefined}
        actions={
          agent && (
            <>
              <PaperButton variant="ghost" size="small" onClick={onOpenChat}>回对话</PaperButton>
              <PaperButton size="small" onClick={saveAll} disabled={!dirty || saving}>
                {saving ? '保存…' : dirty ? '保存' : '已保存'}
              </PaperButton>
            </>
          )
        }
      />

      <PaperContent noPad>
        {err && <div style={s.errBox}>{err}</div>}
        {loading && !agent ? (
          <div style={s.loading}>
            <p style={{ fontFamily: "'Young Serif', serif", fontStyle: 'italic', color: 'var(--pencil)' }}>正在翻档案…</p>
          </div>
        ) : !agent ? (
          <EmptyState />
        ) : (
          <div style={s.layout}>
            {/* LEFT — Dossier card */}
            <aside style={s.dossier}>
              {avatarDataUrl ? (
                <img src={avatarDataUrl} alt="" style={s.bigAvatar} />
              ) : (
                <div style={s.bigGlyph}>{glyphFor({ ...agent, name } as Session)}</div>
              )}
              <div style={s.dName}>{name || agent.name || agent.title || '未命名'}</div>
              <div style={s.dRole}>
                {firstSentence(prompt || '') || '还没写人设'}
              </div>

              <div style={s.dStatList}>
                <Stat k="养于" v={agent.created_at ? new Date(agent.created_at).toLocaleDateString('zh-CN').replace(/\//g, '·') : '—'} />
                <Stat k="模型" v={modelNice} large />
                <Stat k="对过话" v={`${agent.message_count || 0} 次`} />
                <Stat k="上次" v={relDays(agent.last_message_at)} />
                <Stat k="身份" v={agent.is_primary ? '本命 Primag' : '自定义'} />
                <Stat k="ID" v={agent.session_id.slice(0, 8)} mono />
              </div>

              {agent.preview_text && (
                <div style={s.dQuote}>
                  <span style={s.dQuoteMark}>"</span>
                  {agent.preview_text}
                  <div style={s.dQuoteSig}>—— {relDays(agent.last_message_at)}</div>
                </div>
              )}
            </aside>

            {/* RIGHT — Editor */}
            <div style={s.editor}>
              <section style={s.sect}>
                <div style={s.sectHead}>
                  <span style={s.sectN}>01</span>
                  <h2 style={s.sectTitle}>基本</h2>
                  <span style={s.sectAfter}>名字 · 头像 · 模型</span>
                </div>

                <div style={s.basicRow}>
                  <div style={s.basicAvatarCol}>
                    <div style={s.basicAvatarLabel}>头像</div>
                    <div style={s.basicAvatarBox}>
                      {avatarDataUrl ? (
                        <img src={avatarDataUrl} alt="" style={s.basicAvatarImg} />
                      ) : (
                        <div style={s.basicAvatarGlyph}>{glyphFor({ ...agent, name } as Session)}</div>
                      )}
                    </div>
                    <div style={s.basicAvatarActions}>
                      <PaperButton variant="ghost" size="small" onClick={() => fileRef.current?.click()}>
                        {avatarDataUrl ? '换一张' : '上传'}
                      </PaperButton>
                      {avatarDataUrl && (
                        <PaperButton variant="link" size="small" onClick={handleAvatarClear}>清除</PaperButton>
                      )}
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleAvatarPick}
                      />
                    </div>
                  </div>

                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                    <div>
                      <div style={s.fieldLabel}>
                        <span>名字</span>
                        <span style={s.fieldHint}>它在对话里就叫这个</span>
                      </div>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="给它起个名字"
                        style={s.basicInput}
                      />
                    </div>

                    <div>
                      <div style={s.fieldLabel}>
                        <span>用的模型</span>
                        <span style={s.fieldHint}>
                          去 <em style={{ color: 'var(--accent-ink)' }}>「模型」章节</em> 接一家 provider
                        </span>
                      </div>
                      <select
                        value={llmConfigId}
                        onChange={(e) => setLlmConfigId(e.target.value)}
                        style={s.basicInput}
                      >
                        <option value="">（不指定 · 用默认）</option>
                        {configs.map((c) => (
                          <option key={c.config_id} value={c.config_id}>
                            {(c.shortname || c.model || c.name)} — {c.provider}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </section>

              <section style={s.sect}>
                <div style={s.sectHead}>
                  <span style={s.sectN}>02</span>
                  <h2 style={s.sectTitle}>人设</h2>
                  <span style={s.sectAfter}>它怎么说话 · 想什么</span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={s.fieldLabel}>
                    <span>System Prompt</span>
                    <span style={s.fieldHint}>用自然语言写。不要想着像工程师。</span>
                  </div>
                  <PaperTextarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={8}
                    placeholder="例：&#10;你叫阿茶。你的语气像午后半醒的朋友，不急。&#10;说话中文为主，偶尔蹦英文单词但不做作。&#10;用户来问问题时，先别急着给结论——问一问他们在怕什么，或者在期待什么。"
                    style={{ minHeight: 180 }}
                  />
                </div>
              </section>

              <section style={s.sect}>
                <div style={s.sectHead}>
                  <span style={s.sectN}>03</span>
                  <h2 style={s.sectTitle}>共用人设</h2>
                  <span style={s.sectAfter}>{presets.length} 个 · 所有 agent 共用</span>
                  <PaperButton size="small" variant="ghost" onClick={openNewPreset} disabled={presetEditor !== null}>
                    + 加一个
                  </PaperButton>
                </div>

                {presetEditor !== null && (
                  <div style={s.presetForm}>
                    <div style={s.presetFormHead}>
                      <span>{presetEditor === 'new' ? '新人设' : `改 · ${(presetEditor as PersonaPreset).nickname}`}</span>
                      <button type="button" onClick={closePresetEditor} style={s.presetFormClose}>×</button>
                    </div>
                    <div style={s.fieldLabel}>
                      <span>昵称</span>
                      <span style={s.fieldHint}>短一点好选</span>
                    </div>
                    <input
                      type="text"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      placeholder="例：认真严谨 · 午后朋友 · 严厉导师"
                      style={s.basicInput}
                      autoFocus
                    />
                    <div style={{ ...s.fieldLabel, marginTop: 14 }}>
                      <span>System Prompt</span>
                      <span style={s.fieldHint}>给所有 agent 共用，一套口气</span>
                    </div>
                    <PaperTextarea
                      value={presetPrompt}
                      onChange={(e) => setPresetPrompt(e.target.value)}
                      rows={6}
                      placeholder="描述它的口气、边界、习惯…"
                      style={{ minHeight: 140, marginTop: 6 }}
                    />
                    <div style={s.presetFormActions}>
                      <PaperButton variant="ghost" size="small" onClick={closePresetEditor}>取消</PaperButton>
                      <PaperButton size="small" onClick={submitPreset} disabled={presetSaving}>
                        {presetSaving ? '存…' : '存'}
                      </PaperButton>
                    </div>
                  </div>
                )}

                {presets.length === 0 && presetEditor === null ? (
                  <div style={s.emptyInline}>
                    <div style={s.emptyInlineTitle}>还没有共用人设</div>
                    <div style={s.emptyInlineHint}>
                      点右上「+ 加一个」存一套常用口气。<em>存在主 agent 上，所有 agent 都能切。</em>
                    </div>
                  </div>
                ) : presets.length > 0 && (
                  <div style={s.presetGrid}>
                    {presets.map((p) => {
                      const active = p.id === currentPresetId;
                      return (
                        <div key={p.id} style={{ ...s.presetCard, ...(active ? s.presetCardOn : null) }}>
                          <button
                            type="button"
                            style={s.presetCardBody}
                            onClick={() => void applyPreset(p)}
                            disabled={saving || active || !agent}
                            title={active ? '已经在用' : `套到「${agent?.name || 'agent'}」身上`}
                          >
                            <div style={s.presetHead}>
                              <span style={s.presetName}>{p.nickname}</span>
                              {active && <PaperChip tone="ok">在用</PaperChip>}
                            </div>
                            {p.system_prompt && (
                              <div style={s.presetPreview}>
                                {p.system_prompt.slice(0, 90)}{p.system_prompt.length > 90 ? '…' : ''}
                              </div>
                            )}
                          </button>
                          <div style={s.presetCardActions}>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); openEditPreset(p); }}
                              style={s.presetIconBtn}
                              title="改"
                              aria-label="改"
                            >改</button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); void deletePreset(p); }}
                              style={{ ...s.presetIconBtn, ...s.presetIconBtnDanger }}
                              title="删"
                              aria-label="删"
                            >删</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section style={s.sect}>
                <div style={s.sectHead}>
                  <span style={s.sectN}>04</span>
                  <h2 style={s.sectTitle}>记得的事</h2>
                  <span style={s.sectAfter}>
                    Memory · {memLoading
                      ? '翻…'
                      : `${memories.length} 条 · agent:${(agentUuid || agentSid || '').slice(0, 6)}`}
                  </span>
                </div>
                {memErr ? (
                  <div style={s.memErr}>{memErr}</div>
                ) : memLoading ? (
                  <div style={s.memLoading}>正在从 Smartnote 取…</div>
                ) : memories.length === 0 ? (
                  <div style={s.memEmpty}>
                    它还没记下什么{agentName ? `（查过 scope agent:${(agentUuid || '').slice(0, 6)} · agent:${(agentSid || '').slice(0, 6)} · tag "${agentName}"）` : ''}。
                    回对话里任意一条消息点「→ 知识」就能让它记住。
                  </div>
                ) : (
                  <div style={s.memBuckets}>
                    {(['fact', 'preference', 'procedure', 'episode', 'document_ref'] as MemoryKind[])
                      .filter((k) => memoryBuckets[k].length > 0)
                      .map((k) => (
                        <div key={k} style={s.memBucket}>
                          <div style={s.memBucketHead}>
                            <span style={s.memKindLabel}>{MEM_KIND_LABEL[k]}</span>
                            <span style={s.memKindCount}>{memoryBuckets[k].length}</span>
                          </div>
                          <ul style={s.memList}>
                            {memoryBuckets[k].slice(0, 8).map((m) => (
                              <li key={m.id} style={s.memItem}>
                                <div style={s.memItemMain}>
                                  {m.pinned && <span style={s.memPin} title="置顶">★</span>}
                                  <span style={s.memContent}>{m.content}</span>
                                </div>
                                <div style={s.memMeta}>
                                  <span style={s.memDate}>{relDays(m.updated_at || m.created_at)}</span>
                                  {m.tags.slice(0, 3).map((t) => (
                                    <span key={t} style={s.memTag}>#{t}</span>
                                  ))}
                                  <button
                                    type="button"
                                    style={s.memBtn}
                                    disabled={!!memBusy[m.id]}
                                    onClick={() => void togglePin(m)}
                                    title={m.pinned ? '取消置顶' : '置顶'}
                                  >
                                    {m.pinned ? '取消' : '置顶'}
                                  </button>
                                  <button
                                    type="button"
                                    style={{ ...s.memBtn, ...s.memBtnDanger }}
                                    disabled={!!memBusy[m.id]}
                                    onClick={() => void removeMemory(m)}
                                    title="忘掉"
                                  >
                                    忘
                                  </button>
                                </div>
                              </li>
                            ))}
                            {memoryBuckets[k].length > 8 && (
                              <li style={s.memMore}>… 还有 {memoryBuckets[k].length - 8} 条</li>
                            )}
                          </ul>
                        </div>
                      ))}
                  </div>
                )}
              </section>

              <section style={s.sect}>
                <div style={s.sectHead}>
                  <span style={s.sectN}>05</span>
                  <h2 style={s.sectTitle}>会的手艺</h2>
                  <span style={s.sectAfter}>
                    Skills · {(agent.skill_packs?.length || 0)} 项
                  </span>
                </div>
                {!agent.skill_packs || agent.skill_packs.length === 0 ? (
                  <div style={s.emptyInline}>
                    <div style={s.emptyInlineTitle}>还没装手艺</div>
                    <div style={s.emptyInlineHint}>
                      技能包可以在别处装。装上之后它在这里会列出每一项。
                    </div>
                  </div>
                ) : (
                  <div style={s.skillChips}>
                    {agent.skill_packs.map((sp: any, i: number) => (
                      <PaperChip key={sp.id || i}>{sp.name || sp.id || `Skill ${i + 1}`}</PaperChip>
                    ))}
                  </div>
                )}
              </section>

              {!agent.is_primary && (
                <section style={s.sect}>
                  <div style={s.sectHead}>
                    <span style={s.sectN}>06</span>
                    <h2 style={s.sectTitle}>危险区</h2>
                    <span style={s.sectAfter}>Danger</span>
                  </div>
                  <div style={s.dangerBox}>
                    <div>
                      <div style={s.dangerTitle}>删掉这只 agent</div>
                      <div style={s.dangerHint}>它的对话、记忆、设置全会没。做了不能撤销。</div>
                    </div>
                    <PaperButton variant="link" danger disabled={deleting} onClick={handleDelete}>
                      {deleting ? '在删…' : '删'}
                    </PaperButton>
                  </div>
                </section>
              )}

              <div style={s.foot}>
                <span>{dirty ? '有未保存的改动' : '你对它做的改动会在下一句话生效'}</span>
                <span style={s.kbd}>⌘ S 保存</span>
              </div>
            </div>
          </div>
        )}
      </PaperContent>
    </PaperPage>
  );
};

/* ---------- pieces ---------- */

const Stat: React.FC<{ k: string; v: React.ReactNode; large?: boolean; mono?: boolean }> = ({ k, v, large, mono }) => (
  <div style={s.stat}>
    <span style={s.statK}>{k}</span>
    <span style={{
      ...s.statV,
      ...(large ? s.statVLarge : null),
      ...(mono ? { fontFamily: "'JetBrains Mono', monospace", fontSize: 11 } : null),
    }}>
      {v}
    </span>
  </div>
);

const EmptyState: React.FC = () => (
  <div style={{ padding: '72px 32px', textAlign: 'center' }}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 44, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>·</div>
    <h3 style={{ fontFamily: "'Young Serif', serif", fontSize: 18, color: 'var(--ink-strong)', margin: 0 }}>还没选 agent</h3>
    <p style={{ marginTop: 10, fontSize: 13, color: 'var(--pencil)', fontFamily: "'Young Serif', serif", fontStyle: 'italic', maxWidth: '44ch', margin: '10px auto 0' }}>
      侧栏点一只，这里就会显示它的档案 — 人设、记忆、技能。
    </p>
  </div>
);

const MEM_KIND_LABEL: Record<MemoryKind, string> = {
  fact: '事实',
  preference: '偏好',
  procedure: '做法',
  episode: '往事',
  document_ref: '出处',
};

const firstSentence = (text: string): string => {
  const t = text.trim();
  if (!t) return '';
  const m = t.match(/^([^。.\n]{3,80}[。.])/);
  return m ? m[1] : (t.length > 50 ? t.slice(0, 50) + '…' : t);
};

const s: Record<string, React.CSSProperties> = {
  errBox: {
    margin: '24px 32px 0',
    padding: '12px 14px',
    background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    color: 'oklch(0.40 0.130 25)',
    fontSize: 13,
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
  },
  loading: { padding: '72px 32px', textAlign: 'center' },
  layout: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
    height: '100%',
    overflow: 'hidden',
  },
  /* LEFT dossier */
  dossier: {
    borderRight: '1px solid var(--rule)',
    padding: '32px 28px',
    overflowY: 'auto',
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
  },
  bigGlyph: {
    width: 84,
    height: 84,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: "'Young Serif', serif",
    fontSize: 40,
    color: 'var(--accent-ink)',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    boxShadow:
      'inset 0 0 0 5px var(--page-elev), inset 0 0 0 6px var(--accent-ink), 0 8px 18px oklch(0.18 0.02 310 / 0.08)',
    borderRadius: 2,
    marginBottom: 18,
  },
  bigAvatar: {
    width: 84,
    height: 84,
    objectFit: 'cover',
    borderRadius: 2,
    marginBottom: 18,
    border: '1px solid var(--rule-strong)',
    boxShadow:
      'inset 0 0 0 3px var(--page-elev), inset 0 0 0 4px var(--accent-ink), 0 8px 18px oklch(0.18 0.02 310 / 0.08)',
    background: 'var(--paper)',
    display: 'block',
  },
  dName: {
    fontFamily: "'Young Serif', serif",
    fontSize: 26,
    color: 'var(--ink-strong)',
    letterSpacing: '-0.01em',
  },
  dRole: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 14,
    color: 'var(--pencil)',
    marginTop: 4,
  },
  dStatList: {
    marginTop: 24,
    borderTop: '1px dotted var(--rule-strong)',
  },
  stat: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 10,
    padding: '10px 0',
    borderBottom: '1px dotted var(--rule-strong)',
    fontSize: 12.5,
    alignItems: 'baseline',
  },
  statK: {
    fontSize: 10.5,
    letterSpacing: '0.18em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  statV: {
    fontFamily: "'JetBrains Mono', monospace",
    color: 'var(--ink)',
    fontSize: 12,
    letterSpacing: '0.04em',
  },
  statVLarge: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  dQuote: {
    marginTop: 24,
    padding: '14px 16px',
    background: 'color-mix(in oklch, var(--marginalia) 40%, transparent)',
    borderLeft: '3px solid var(--marginalia-ink)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13.5,
    color: 'var(--marginalia-ink)',
    lineHeight: 1.6,
  },
  dQuoteMark: {
    fontFamily: "'Young Serif', serif",
    fontSize: 22,
    lineHeight: 0,
    position: 'relative',
    top: 7,
    marginRight: 2,
  },
  dQuoteSig: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    fontStyle: 'normal',
    letterSpacing: '0.1em',
    color: 'var(--pencil)',
    marginTop: 6,
  },
  /* RIGHT editor */
  editor: {
    overflowY: 'auto',
    padding: '32px 44px 80px',
  },
  sect: { marginBottom: 40 },
  sectHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    padding: '0 0 10px',
    borderBottom: '1px solid var(--rule)',
  },
  sectN: {
    fontFamily: "'Young Serif', serif",
    fontSize: 18,
    color: 'var(--accent-ink)',
    minWidth: 30,
  },
  sectTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 20,
    color: 'var(--ink-strong)',
    fontWeight: 400,
    margin: 0,
  },
  sectAfter: {
    marginLeft: 'auto',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'var(--pencil)',
    letterSpacing: '0.15em',
  },
  fieldLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 6,
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  fieldHint: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--marginalia-ink)',
    letterSpacing: 0,
    textTransform: 'none',
  },
  presetGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 10,
    marginTop: 16,
  },
  presetCard: {
    padding: '12px 14px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'var(--ink)',
    transition: 'border-color 180ms, background 180ms',
  },
  presetCardOn: {
    background: 'var(--accent-soft)',
    borderColor: 'var(--accent-ink)',
    cursor: 'default',
  },
  presetHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  presetName: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  presetPreview: {
    marginTop: 6,
    fontSize: 11.5,
    color: 'var(--pencil)',
    lineHeight: 1.5,
    fontStyle: 'italic',
    fontFamily: "'Young Serif', serif",
  },
  presetCardBody: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    background: 'transparent',
    border: 0,
    cursor: 'pointer',
    textAlign: 'left',
    color: 'inherit',
    fontFamily: 'inherit',
  },
  presetCardActions: {
    display: 'flex',
    gap: 6,
    paddingTop: 6,
    marginTop: 8,
    borderTop: '1px dotted var(--rule)',
    justifyContent: 'flex-end',
  },
  presetIconBtn: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil)',
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: "'Young Serif', serif",
    padding: '2px 8px',
    borderRadius: 2,
    letterSpacing: '0.1em',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },
  presetIconBtnDanger: {
    color: 'var(--status-error)',
  },
  presetForm: {
    marginTop: 14,
    padding: '16px 18px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
  },
  presetFormHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink-strong)',
    fontStyle: 'italic',
    marginBottom: 10,
  },
  presetFormClose: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil)',
    fontSize: 18,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '0 4px',
  },
  presetFormActions: {
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  comingBox: { marginTop: 12 },
  coming: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--pencil)',
    lineHeight: 1.7,
    padding: '16px 18px',
    border: '1px dashed var(--rule-strong)',
    borderRadius: 2,
  },
  emptyInline: {
    marginTop: 12,
    padding: '20px 18px',
    border: '1px dashed var(--rule-strong)',
    borderRadius: 2,
  },
  emptyInlineTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  emptyInlineHint: {
    marginTop: 6,
    fontSize: 12.5,
    color: 'var(--pencil)',
    lineHeight: 1.6,
  },
  skillChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  foot: {
    marginTop: 24,
    padding: '14px 0',
    borderTop: '1px solid var(--rule)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 12,
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
  },
  kbd: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    fontStyle: 'normal',
    letterSpacing: '0.08em',
    color: 'var(--pencil-soft)',
  },
  /* basic section */
  basicRow: {
    display: 'flex',
    gap: 32,
    marginTop: 18,
    alignItems: 'flex-start',
  },
  basicAvatarCol: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
    flexShrink: 0,
  },
  basicAvatarLabel: {
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  basicAvatarBox: {
    width: 68,
    height: 68,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    boxShadow: 'inset 0 0 0 3px var(--page-elev), inset 0 0 0 4px var(--accent-ink)',
  },
  basicAvatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  basicAvatarGlyph: {
    fontFamily: "'Young Serif', serif",
    fontSize: 28,
    color: 'var(--accent-ink)',
  },
  basicAvatarActions: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  basicInput: {
    width: '100%',
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    padding: '8px 0',
    fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif",
    fontSize: 14.5,
    color: 'var(--ink)',
    outline: 'none',
    caretColor: 'var(--accent-ink)',
    transition: 'border-bottom-color 180ms cubic-bezier(0.22,1,0.36,1)',
    appearance: 'none',
    borderRadius: 0,
  },
  /* danger */
  dangerBox: {
    marginTop: 14,
    padding: '14px 16px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    borderRadius: 2,
  },
  dangerTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'oklch(0.35 0.130 25)',
  },
  dangerHint: {
    fontSize: 12.5,
    color: 'oklch(0.40 0.110 25)',
    marginTop: 3,
  },

  // ── Section 04 · 记得的事 (Smartnote memories) ──
  memErr: {
    margin: '0 0 12px',
    padding: '10px 12px',
    border: '1px dotted var(--rule-strong)',
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--pencil)',
    background: 'var(--page)',
  },
  memLoading: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--pencil)',
    fontSize: 13,
    padding: '10px 0',
  },
  memEmpty: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--pencil)',
    fontSize: 13,
    padding: '14px 14px',
    border: '1px dotted var(--rule)',
    background: 'var(--page)',
    borderRadius: 2,
  },
  memBuckets: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    marginTop: 4,
  },
  memBucket: {
    borderTop: '1px solid var(--rule)',
    paddingTop: 10,
  },
  memBucketHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 6,
  },
  memKindLabel: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
  },
  memKindCount: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    letterSpacing: '0.06em',
    color: 'var(--pencil)',
  },
  memList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  memItem: {
    padding: '6px 0',
    borderBottom: '1px dotted var(--rule)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  memItemMain: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    lineHeight: 1.5,
    fontSize: 13.5,
    color: 'var(--ink)',
  },
  memPin: {
    fontFamily: "'JetBrains Mono', monospace",
    color: 'var(--marginalia-ink)',
    fontSize: 11,
    lineHeight: '20px',
  },
  memContent: {
    flex: 1,
    wordBreak: 'break-word',
  },
  memMeta: {
    display: 'flex',
    gap: 8,
    alignItems: 'baseline',
    flexWrap: 'wrap',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    letterSpacing: '0.04em',
    color: 'var(--pencil)',
  },
  memDate: { color: 'var(--pencil-soft)' },
  memTag: {
    padding: '1px 5px',
    border: '1px solid var(--rule)',
    borderRadius: 2,
    color: 'var(--pencil)',
  },
  memBtn: {
    background: 'transparent',
    border: 0,
    padding: '1px 5px',
    cursor: 'pointer',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    textDecorationColor: 'var(--rule-strong)',
  },
  memBtnDanger: {
    color: 'oklch(0.45 0.140 25)',
    textDecorationColor: 'oklch(0.75 0.100 25)',
  },
  memMore: {
    listStyle: 'none',
    padding: '4px 0',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 12,
    color: 'var(--pencil-soft)',
  },
};

export default PersonaPage;
