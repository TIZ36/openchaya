/**
 * 点击 Agent 名 / 会话条打开的「Agent 设置」：基础信息、默认模型、人设（含人设管理预设）、能力开关与知识库快捷维护。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, Crown, Pencil, BookOpen, RefreshCw, Upload, FileText, Trash2, Plus, Search, Sparkles, SlidersHorizontal } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/Dialog';
import { Button } from './ui/Button';
import { ListItem } from './ui/PageLayout';
import {
  getAgentProfileForNameplate,
  getAgentHarnessStatus,
  getAgents,
  agentApiId,
  type Session,
  type AgentHarnessStatus,
} from '../services/chat';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { updateRoleProfile, type PersonaPreset } from '../services/roleApi';
import {
  getAgentKB,
  listDocuments,
  uploadDocuments,
  deleteDocument,
  addTextDocument,
  searchKB,
  type KnowledgeBase,
  type KBDocument,
  type KBSearchResult,
} from '../services/kbApi';
import { defaultPersonaConfig, type AgentPersonaFullConfig } from './AgentPersonaConfig';
import TopologyReadonlyPanel from './TopologyReadonlyPanel';
import { Switch } from './ui/Switch';
import { cn } from '@/utils/cn';
import { emitSessionsChanged } from '../utils/sessionEvents';

/** 全局人设预设存主 Agent ext.personaPresets（与 AgentsPage / Workflow 一致） */
const CHAYA_LEGACY_SESSION_ID = 'agent_chaya';

function personaPresetOwnerFromAgents(agents: Session[]): Session | null {
  const legacy = agents.find((a) => a.session_id === CHAYA_LEGACY_SESSION_ID);
  if (legacy) return legacy;
  const primary = agents.find((a) => a.is_primary);
  if (primary) return primary;
  return agents[0] ?? null;
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
  azure: 'Azure',
  local: '本地',
};

const sectionCardClass =
  '!cursor-default rounded-2xl border border-borderToken/70 bg-card/75 shadow-sm backdrop-blur-sm';

const inputClass =
  'w-full rounded-xl border border-borderToken/80 bg-background/90 px-3 text-sm text-foreground outline-none transition focus:border-[var(--color-accent)]/45 focus:ring-2 focus:ring-[var(--color-accent)]/15';

const softCardClass =
  'rounded-2xl border border-borderToken/70 bg-background/55 p-3';

function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedToken-foreground">{title}</div>
      {detail ? <div className="text-xs leading-relaxed text-mutedToken-foreground">{detail}</div> : null}
    </div>
  );
}

function SettingRow({
  title,
  detail,
  control,
}: {
  title: string;
  detail: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-borderToken/70 bg-background/55 px-3 py-3">
      <div className="min-w-0 space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs leading-relaxed text-mutedToken-foreground">{detail}</div>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function personaFromSession(s: Session | null): AgentPersonaFullConfig {
  if (!s) return defaultPersonaConfig;
  const ext = s.ext as Record<string, unknown> | undefined;
  const saved = ext?.persona as Partial<AgentPersonaFullConfig> | undefined;
  if (!saved) return defaultPersonaConfig;
  return {
    voice: saved.voice ? { ...defaultPersonaConfig.voice, ...saved.voice } : defaultPersonaConfig.voice,
    thinking: saved.thinking ? { ...defaultPersonaConfig.thinking, ...saved.thinking } : defaultPersonaConfig.thinking,
    memoryTriggers: saved.memoryTriggers ?? [],
    responseMode: saved.responseMode ?? defaultPersonaConfig.responseMode,
    memoryTriggersEnabled: saved.memoryTriggersEnabled !== false,
    topologyEnabled: saved.topologyEnabled === true,
    skillTriggerEnabled: saved.skillTriggerEnabled,
  };
}

function HarnessMiniPill({
  label,
  detail,
  muted,
  title: tip,
}: {
  label: string;
  detail: string;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span
      title={tip}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        muted
          ? 'border-borderToken/50 bg-mutedToken/30 text-mutedToken-foreground [data-skin="niho"]:border-[var(--niho-text-border)] [data-skin="niho"]:bg-[var(--niho-text-bg)] [data-skin="niho"]:text-[var(--niho-skyblue-gray)]'
          : 'border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200 [data-skin="niho"]:border-sky-500/30 [data-skin="niho"]:bg-sky-500/15 [data-skin="niho"]:text-sky-200',
      )}
    >
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate opacity-90">{detail}</span>
    </span>
  );
}

export interface AgentNameplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前对话 id（convid） */
  sessionId: string | null;
  /** 当前行在列表中的 agid，传入可减少一次 getAgents */
  agentAgid?: string;
  /** 左侧列表同一行，用于副标题「N 条消息」等 */
  listRow?: Session | null;
  /** 更新成功后通知父级刷新列表 */
  onUpdated?: () => void;
}

type AgentSettingsTab = 'profile' | 'persona' | 'capability' | 'knowledge';

const SETTINGS_TABS: Array<{ key: AgentSettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'profile', label: '基础', icon: Bot },
  { key: 'persona', label: '模型 / 人设', icon: Sparkles },
  { key: 'capability', label: '能力', icon: SlidersHorizontal },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
];

const AgentNameplateDialog: React.FC<AgentNameplateDialogProps> = ({
  open,
  onOpenChange,
  sessionId,
  agentAgid,
  listRow,
  onUpdated,
}) => {
  const [session, setSession] = useState<Session | null>(null);
  const [harness, setHarness] = useState<AgentHarnessStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [avatarDraft, setAvatarDraft] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState('');
  const [topologyDraft, setTopologyDraft] = useState(false);
  const [voiceEnabledDraft, setVoiceEnabledDraft] = useState(false);
  const [llmDraft, setLlmDraft] = useState<string | null>(null);
  const [llmConfigs, setLlmConfigs] = useState<LLMConfigFromDB[]>([]);
  /** 全局人设预设列表（人设管理） */
  const [personaPresetsGlobal, setPersonaPresetsGlobal] = useState<PersonaPreset[]>([]);
  const [personaPresetsLoading, setPersonaPresetsLoading] = useState(false);
  /** 当前 Agent 绑定的预设 id；空字符串表示不关联全局预设 */
  const [personaPresetChoiceId, setPersonaPresetChoiceId] = useState<string>('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [kbDocs, setKbDocs] = useState<KBDocument[]>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbUploading, setKbUploading] = useState(false);
  const [kbAddingText, setKbAddingText] = useState(false);
  const [kbTextTitle, setKbTextTitle] = useState('');
  const [kbTextDraft, setKbTextDraft] = useState('');
  const [kbSearchQuery, setKbSearchQuery] = useState('');
  const [kbSearching, setKbSearching] = useState(false);
  const [kbSearchResults, setKbSearchResults] = useState<KBSearchResult[]>([]);
  const [activeTab, setActiveTab] = useState<AgentSettingsTab>('profile');

  useEffect(() => {
    if (!open || !sessionId) {
      setSession(null);
      setHarness(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getLLMConfigs().then(setLlmConfigs).catch(() => setLlmConfigs([]));
    setPersonaPresetsLoading(true);
    void getAgents()
      .then((agents) => {
        const owner = personaPresetOwnerFromAgents(agents);
        const list = ((owner?.ext as Record<string, unknown> | undefined)?.personaPresets as PersonaPreset[]) ?? [];
        setPersonaPresetsGlobal(Array.isArray(list) ? list : []);
      })
      .catch(() => setPersonaPresetsGlobal([]))
      .finally(() => {
        if (!cancelled) setPersonaPresetsLoading(false);
      });
    void getAgentProfileForNameplate(sessionId, agentAgid)
      .then(async (s) => {
        if (!cancelled) setSession(s);
        try {
          const h = await getAgentHarnessStatus(agentApiId(s));
          if (!cancelled) setHarness(h);
        } catch {
          if (!cancelled) setHarness(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, agentAgid]);

  const persona = useMemo(() => personaFromSession(session), [session]);
  const topologyPanelAgid = session ? agentApiId(session) : '';

  const displayName = (session?.name || session?.title || listRow?.name || listRow?.title || 'Agent').trim() || 'Agent';
  const isPrimary = !!(session?.is_primary || listRow?.is_primary);
  const avatar = (session?.avatar || listRow?.avatar)?.trim() ? (session?.avatar || listRow?.avatar) : null;
  const prompt = (session?.system_prompt || '').trim();

  useEffect(() => {
    if (open) setEditingName(displayName);
  }, [open, displayName]);

  useEffect(() => {
    if (!open) return;
    setActiveTab('profile');
    setAvatarDraft(avatar ?? null);
    setPromptDraft(prompt);
    setTopologyDraft(persona.topologyEnabled === true);
    setVoiceEnabledDraft(persona.voice.enabled === true);
    setLlmDraft(session?.llm_config_id ?? null);
    const rawPid = (session?.ext as Record<string, unknown> | undefined)?.currentPersonaId;
    const pid = typeof rawPid === 'string' ? rawPid.trim() : '';
    const valid = pid !== '' && personaPresetsGlobal.some((p) => p.id === pid);
    setPersonaPresetChoiceId(valid ? pid : '');
  }, [
    open,
    avatar,
    prompt,
    persona.topologyEnabled,
    persona.voice.enabled,
    session?.llm_config_id,
    session?.ext,
    personaPresetsGlobal,
  ]);

  const loadKnowledgeBase = async (targetSessionId: string) => {
    setKbLoading(true);
    try {
      const nextKb = await getAgentKB(targetSessionId);
      const docs = await listDocuments(nextKb.kb_id);
      setKb(nextKb);
      setKbDocs(docs);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKbLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !session?.session_id) return;
    void loadKnowledgeBase(session.session_id);
  }, [open, session?.session_id]);

  const handleSaveProfile = async () => {
    if (!session) return;
    const nextName = editingName.trim();
    if (!nextName) return;
    try {
      setSavingProfile(true);
      const baseExt = { ...((session.ext || {}) as Record<string, unknown>) };
      if (personaPresetChoiceId) {
        baseExt.currentPersonaId = personaPresetChoiceId;
      } else {
        delete baseExt.currentPersonaId;
      }
      await updateRoleProfile(agentApiId(session), {
        name: nextName,
        avatar: avatarDraft,
        system_prompt: promptDraft.trim() || null,
        llm_config_id: llmDraft,
        ext: baseExt as Record<string, unknown>,
        persona: {
          ...persona,
          topologyEnabled: topologyDraft,
          voice: {
            ...persona.voice,
            enabled: voiceEnabledDraft,
          },
        },
      });
      const fresh = await getAgentProfileForNameplate(sessionId || session.session_id, agentApiId(session));
      setSession(fresh);
      onUpdated?.();
      emitSessionsChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleUploadAvatar = async (file: File | null) => {
    if (!file) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      if (dataUrl) setAvatarDraft(dataUrl);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUploadKnowledgeFiles = async (files: FileList | null) => {
    if (!kb || !files || files.length === 0) return;
    try {
      setKbUploading(true);
      await uploadDocuments(kb.kb_id, Array.from(files));
      await loadKnowledgeBase(sessionId || session?.session_id || '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKbUploading(false);
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!kb) return;
    try {
      await deleteDocument(kb.kb_id, docId);
      await loadKnowledgeBase(sessionId || session?.session_id || '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleAddKnowledgeText = async () => {
    if (!kb || !kbTextDraft.trim()) return;
    try {
      setKbAddingText(true);
      await addTextDocument(kb.kb_id, kbTextDraft.trim(), kbTextTitle.trim() || '临时笔记');
      setKbTextDraft('');
      setKbTextTitle('');
      await loadKnowledgeBase(sessionId || session?.session_id || '');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKbAddingText(false);
    }
  };

  const handleKnowledgeSearch = async () => {
    if (!kb || !kbSearchQuery.trim()) return;
    try {
      setKbSearching(true);
      const results = await searchKB(kb.kb_id, kbSearchQuery.trim());
      setKbSearchResults(results);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKbSearching(false);
    }
  };

  const fmtFileSize = (size: number) => {
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  };

  const serverPersonaPresetId = (() => {
    const raw = (session?.ext as Record<string, unknown> | undefined)?.currentPersonaId;
    return typeof raw === 'string' ? raw.trim() : '';
  })();

  const isDirty =
    editingName.trim() !== displayName ||
    (avatarDraft || '') !== (avatar || '') ||
    promptDraft !== prompt ||
    (llmDraft || null) !== (session?.llm_config_id || null) ||
    topologyDraft !== (persona.topologyEnabled === true) ||
    voiceEnabledDraft !== (persona.voice.enabled === true) ||
    (personaPresetChoiceId || '') !== (serverPersonaPresetId || '');

  const messageLine = useMemo(() => {
    const n = session?.message_count ?? listRow?.message_count;
    if (typeof n === 'number' && n >= 0) return `${n} 条消息`;
    return null;
  }, [session?.message_count, listRow?.message_count]);

  const voiceLine = useMemo(() => {
    const v = persona.voice;
    if (!v.enabled) return null;
    const prov = PROVIDER_LABEL[v.provider] || v.provider;
    const vn = (v.voiceName || v.voiceId || '').trim();
    return [vn, prov, v.language].filter(Boolean).join(' · ');
  }, [persona.voice]);

  const llmOptions = useMemo(() => llmConfigs.filter((cfg) => Boolean(cfg.enabled)), [llmConfigs]);
  const selectedLlm = useMemo(() => llmOptions.find((cfg) => cfg.config_id === llmDraft) || null, [llmOptions, llmDraft]);

  const footerDescription = useMemo(() => {
    switch (activeTab) {
      case 'profile':
        return '维护头像、昵称和当前 Agent 的基础身份。';
      case 'persona':
        return '设置默认模型与系统提示词，决定 Agent 的回复基线。';
      case 'capability':
        return '管理行为拓扑、语音输出和编排资源状态。';
      case 'knowledge':
        return '直接维护当前 Agent 的知识文档与文本知识。';
      default:
        return '可在此直接编辑默认 LLM、人设、行为拓扑与音色等属性。';
    }
  }, [activeTab]);

  const renderProfileTab = () => (
    <ListItem className={sectionCardClass}>
      <div className="w-full space-y-2">
        <SectionHeading title="基础信息" detail="头像和昵称会同步到当前 Agent，会话顶部与消息区会立即使用新配置。" />
        <div className="flex items-center gap-3">
          <label className="h-12 w-12 rounded-2xl overflow-hidden border border-borderToken bg-mutedToken inline-flex items-center justify-center cursor-pointer shadow-sm transition hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent-bg)]/50">
            {avatarDraft ? <img src={avatarDraft} alt="" className="h-full w-full object-cover" /> : <Bot className="h-4 w-4 text-[var(--color-accent)]" />}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleUploadAvatar(e.target.files?.[0] || null);
                e.currentTarget.value = '';
              }}
            />
          </label>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-[11px] text-mutedToken-foreground inline-flex items-center gap-1"><Pencil className="h-3 w-3" />昵称</div>
            <input
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              className={`${inputClass} h-10`}
            />
          </div>
        </div>
      </div>
    </ListItem>
  );

  const renderPersonaTab = () => (
    <ListItem className={sectionCardClass}>
      <div className="w-full space-y-3">
        <div className="space-y-1.5">
          <SectionHeading title="默认模型" detail="该配置会作为当前 Agent 的默认 LLM，在私聊或编排里作为基线模型使用。" />
          <select
            value={llmDraft || ''}
            onChange={(e) => setLlmDraft(e.target.value || null)}
            className={`${inputClass} h-10`}
          >
            <option value="">未设置</option>
            {llmOptions.map((cfg) => (
              <option key={cfg.config_id} value={cfg.config_id}>
                {cfg.name} {cfg.provider && cfg.model ? `· ${cfg.provider}/${cfg.model}` : ''}
              </option>
            ))}
          </select>
          {selectedLlm ? (
            <div className="rounded-xl border border-borderToken/60 bg-background/55 px-3 py-2 text-[11px] text-mutedToken-foreground">当前：{selectedLlm.name} · {selectedLlm.provider}{selectedLlm.model ? `/${selectedLlm.model}` : ''}</div>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <SectionHeading title="人设" detail="可从全局预设中继承，也可以只保留当前 Agent 的独立系统提示词。" />
          <div className={`${softCardClass} space-y-2`}>
            <div className="text-[11px] font-medium text-mutedToken-foreground">全局人设预设</div>
            <select
              value={personaPresetChoiceId || '__custom__'}
              disabled={personaPresetsLoading}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__custom__') {
                  setPersonaPresetChoiceId('');
                  return;
                }
                const p = personaPresetsGlobal.find((x) => x.id === v);
                if (p) {
                  setPersonaPresetChoiceId(p.id);
                  setPromptDraft((p.system_prompt || '').trim());
                }
              }}
              className={`${inputClass} h-10`}
            >
              <option value="__custom__">
                {personaPresetsLoading ? '加载预设中…' : '自定义（不关联全局预设）'}
              </option>
              {personaPresetsGlobal.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nickname}
                </option>
              ))}
            </select>
            {!personaPresetsLoading && personaPresetsGlobal.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-mutedToken-foreground">
                暂无全局预设。可在 Persona 管理页中先添加。
              </p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-mutedToken-foreground">
              若手动修改下方系统提示词，将自动取消与预设的关联。
            </p>
          </div>
          <textarea
            value={promptDraft}
            onChange={(e) => {
              setPromptDraft(e.target.value);
              setPersonaPresetChoiceId('');
            }}
            placeholder="输入系统提示词（人设）"
            className={`${inputClass} min-h-[120px] max-h-[220px] resize-y py-2.5 text-[13px] leading-relaxed`}
          />
        </div>
      </div>
    </ListItem>
  );

  const renderCapabilityTab = () => (
    <>
      <ListItem className={sectionCardClass}>
        <div className="w-full space-y-3">
          <SectionHeading title="语音输出" detail="控制 Agent 是否暴露语音人格。音色供应商与语种信息保留原配置。" />
          <div className={softCardClass}>
            <SettingRow
              title="音色"
              detail={voiceEnabledDraft && voiceLine ? voiceLine : '未开启语音输出（TTS）'}
              control={<Switch checked={voiceEnabledDraft} onCheckedChange={setVoiceEnabledDraft} />}
            />
          </div>
        </div>
      </ListItem>

      <ListItem className={sectionCardClass}>
        <div className="w-full space-y-3">
          <SectionHeading title="智能与能力" detail="这里管理编排能力的主开关，只保留高频项，避免把设置面板做成调参页面。" />
          <div className={`${softCardClass} space-y-2`}>
            <SettingRow
              title="行为拓扑"
              detail="开启后可构建与使用知识图谱，影响工具命中和编排路径。"
              control={<Switch checked={topologyDraft} onCheckedChange={setTopologyDraft} />}
            />
            <SettingRow
              title="自驱思考"
              detail="当前为只读状态，由 Agent 人设配置决定。"
              control={<span className="text-xs font-medium text-mutedToken-foreground">{persona.thinking.enabled ? '已开启' : '已关闭'}</span>}
            />
            <div className="rounded-2xl border border-borderToken/70 bg-background/50 px-3 py-3 text-[11px] leading-relaxed text-mutedToken-foreground">
              记忆锚点：{topologyDraft && persona.memoryTriggersEnabled !== false ? '可生效' : '依赖行为拓扑开启'}
              {isPrimary ? <span className="ml-2 text-amber-600 dark:text-amber-300">Primag 负责主会话编排与默认能力基线。</span> : null}
            </div>
          </div>
        </div>
      </ListItem>

      {topologyPanelAgid ? (
        <ListItem className={`${sectionCardClass} py-1`}>
          <TopologyReadonlyPanel
            agentId={topologyPanelAgid}
            topologyEnabled={topologyDraft}
          />
        </ListItem>
      ) : null}

      {harness ? (
        <ListItem className={sectionCardClass}>
          <div className="w-full space-y-2">
            <div className="text-xs font-medium text-mutedToken-foreground">编排资源（MCP · Skill · 知识库）</div>
            <div className="flex flex-wrap gap-1.5">
              <HarnessMiniPill
                label="MCP"
                detail={
                  harness.mcp_servers_bound > 0 || harness.mcp_tool_count > 0
                    ? `${harness.mcp_servers_bound} 服务 · ${harness.mcp_tool_count} 工具`
                    : '未绑定'
                }
                muted={harness.mcp_servers_bound === 0 && harness.mcp_tool_count === 0}
                title="已绑定到本 Agent 的 MCP 服务数，以及当前可列举的工具数（需服务在线）"
              />
              <HarnessMiniPill
                label="Skill"
                detail={harness.skills_bound > 0 ? `${harness.skills_bound} 个已绑定` : '未绑定'}
                muted={harness.skills_bound === 0}
                title="已绑定到本 Agent 的技能数量"
              />
              <HarnessMiniPill
                label="知识库"
                detail={
                  harness.kb_docs_ready > 0 || harness.kb_docs_processing > 0
                    ? `${harness.kb_docs_ready} 就绪${harness.kb_docs_processing > 0 ? ` · ${harness.kb_docs_processing} 处理中` : ''}`
                    : '无文档'
                }
                muted={harness.kb_docs_ready === 0 && harness.kb_docs_processing === 0}
                title="本 Agent 知识库文档：就绪 / 索引中"
              />
            </div>
          </div>
        </ListItem>
      ) : null}
    </>
  );

  const renderKnowledgeTab = () => (
    <ListItem className={sectionCardClass}>
      <div className="w-full space-y-3">
        <div className="flex items-start justify-between gap-3">
          <SectionHeading title="知识库" detail="在这里直接维护当前 Agent 的知识文档，不用再跳到外面的知识库页。" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={() => session?.session_id && void loadKnowledgeBase(session.session_id)}
            disabled={kbLoading || !session?.session_id}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${kbLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-2xl border border-borderToken/70 bg-background/55 px-3 py-3">
            <div className="text-[11px] text-mutedToken-foreground">文档数</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{kb?.doc_count ?? 0}</div>
          </div>
          <div className="rounded-2xl border border-borderToken/70 bg-background/55 px-3 py-3">
            <div className="text-[11px] text-mutedToken-foreground">切片数</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{kb?.chunk_count ?? 0}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-borderToken/70 bg-background/55 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <BookOpen className="h-4 w-4 text-[var(--color-accent)]" />
              文档管理
            </div>
            <label>
              <input
                type="file"
                multiple
                accept=".txt,.md,.pdf,.docx,.json,.yaml,.yml,.csv"
                className="hidden"
                onChange={(e) => {
                  void handleUploadKnowledgeFiles(e.target.files);
                  e.currentTarget.value = '';
                }}
              />
              <span className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-xl border border-borderToken/70 bg-background px-3 text-xs font-medium text-foreground transition hover:border-[var(--color-accent)]/40 hover:bg-[var(--color-accent-bg)]/40">
                <Upload className="h-3.5 w-3.5" />
                {kbUploading ? '上传中...' : '上传文件'}
              </span>
            </label>
          </div>

          <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
            {kbDocs.length > 0 ? (
              kbDocs.map((doc) => (
                <div key={doc.doc_id} className="flex items-center gap-2 rounded-xl border border-borderToken/70 bg-card/65 px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{doc.file_name}</div>
                    <div className="text-[11px] text-mutedToken-foreground">{doc.status === 'ready' ? `${doc.chunk_count} 块` : doc.status} · {fmtFileSize(doc.file_size)}</div>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-mutedToken-foreground hover:text-destructive" onClick={() => void handleDeleteDocument(doc.doc_id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-borderToken/70 bg-background/45 px-3 py-4 text-center text-xs text-mutedToken-foreground">
                还没有文档。可以上传文件，或直接添加一条文本笔记。
              </div>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-borderToken/70 bg-background/55 p-3 space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
            <Plus className="h-4 w-4 text-[var(--color-accent)]" />
            添加文本知识
          </div>
          <input
            value={kbTextTitle}
            onChange={(e) => setKbTextTitle(e.target.value)}
            placeholder="标题，例如：项目约束 / 领域术语"
            className={`${inputClass} h-10`}
          />
          <textarea
            value={kbTextDraft}
            onChange={(e) => setKbTextDraft(e.target.value)}
            placeholder="直接粘贴规则、背景信息、约定、FAQ 等内容"
            className={`${inputClass} min-h-[92px] resize-y py-2.5 text-[13px] leading-relaxed`}
          />
          <div className="flex justify-end">
            <Button type="button" onClick={handleAddKnowledgeText} disabled={kbAddingText || !kbTextDraft.trim()}>
              {kbAddingText ? '保存中...' : '加入知识库'}
            </Button>
          </div>
        </div>

        <div className="rounded-2xl border border-borderToken/70 bg-background/55 p-3 space-y-2">
          <div className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
            <Search className="h-4 w-4 text-[var(--color-accent)]" />
            检索测试
          </div>
          <div className="flex items-center gap-2">
            <input
              value={kbSearchQuery}
              onChange={(e) => setKbSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleKnowledgeSearch();
                }
              }}
              placeholder="输入问题，检查当前知识库能否检索到相关内容"
              className={`${inputClass} h-10 flex-1`}
            />
            <Button type="button" variant="outline" onClick={() => void handleKnowledgeSearch()} disabled={kbSearching || !kbSearchQuery.trim()}>
              {kbSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          {kbSearchResults.length > 0 ? (
            <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
              {kbSearchResults.map((result, index) => (
                <div key={`${result.doc_id}-${index}`} className="rounded-xl border border-borderToken/70 bg-card/65 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-[11px] text-mutedToken-foreground">{result.doc_name}{result.heading ? ` · ${result.heading}` : ''}</div>
                    <div className="shrink-0 text-[11px] font-medium text-[var(--color-accent)]">{result.score.toFixed(3)}</div>
                  </div>
                  <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-foreground">{result.text}</div>
                </div>
              ))}
            </div>
          ) : kbSearchQuery.trim() && !kbSearching ? (
            <div className="rounded-xl border border-dashed border-borderToken/70 bg-background/45 px-3 py-3 text-xs text-mutedToken-foreground">
              暂无结果。可以换个问题，或先补充文档与文本知识。
            </div>
          ) : null}
        </div>
      </div>
    </ListItem>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-borderToken px-5 py-4 text-left">
          <DialogTitle>Agent 设置</DialogTitle>
          <DialogDescription>编辑当前 Agent 的基础属性、模型与能力开关。</DialogDescription>
        </DialogHeader>

        <div className="border-b border-borderToken/70 bg-card/60 px-5 py-4">
          <div className="flex w-full items-center gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-borderToken/70 bg-mutedToken/60 shadow-sm">
                {avatarDraft ? (
                  <img src={avatarDraft} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Bot className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.75} />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground select-text inline-flex items-center gap-1.5">
                  <span className="truncate">{displayName}</span>
                  {isPrimary ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      <Crown className="h-3 w-3" />
                      Primag
                    </span>
                  ) : null}
                  {isDirty ? (
                    <span className="inline-flex items-center rounded-full border border-[var(--color-selected-border)] bg-[var(--color-accent-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                      未保存
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-mutedToken-foreground select-text">
                  {messageLine ? <span>{messageLine}</span> : null}
                  <span className="inline-flex items-center rounded-full border border-borderToken/70 bg-background/60 px-2 py-0.5">当前会话 Agent</span>
                  {isPrimary ? <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300">主编排角色</span> : null}
                </div>
              </div>
          </div>
        </div>

        <div className="border-b border-borderToken/70 bg-background/70 px-5 py-3">
          <div className="flex gap-1 overflow-x-auto no-scrollbar rounded-2xl border border-borderToken/70 bg-card/55 p-1">
            {SETTINGS_TABS.map((tab) => {
              const active = tab.key === activeTab;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center rounded-xl border px-3 text-xs font-medium transition',
                    active
                      ? 'border-[var(--color-accent)]/20 bg-[var(--color-accent-bg)] text-[var(--color-accent)] shadow-sm'
                      : 'border-transparent bg-transparent text-mutedToken-foreground hover:border-borderToken/60 hover:bg-background/80 hover:text-foreground',
                  )}
                >
                  <Icon className="mr-1.5 h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3 px-5 py-4 max-h-[min(72vh,560px)] overflow-y-auto bg-background/40">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-mutedToken-foreground">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              加载配置…
            </div>
          )}
          {error && !loading && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && session && (
            <>
              {activeTab === 'profile' ? renderProfileTab() : null}
              {activeTab === 'persona' ? renderPersonaTab() : null}
              {activeTab === 'capability' ? renderCapabilityTab() : null}
              {activeTab === 'knowledge' ? renderKnowledgeTab() : null}
            </>
          )}
        </div>

        <DialogFooter className="sticky bottom-0 flex-col items-stretch gap-3 border-t border-borderToken/70 bg-card/85 px-5 py-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-[11px] leading-relaxed text-mutedToken-foreground">{footerDescription}</div>
            {isDirty ? <div className="text-[11px] font-medium text-[var(--color-accent)]">当前修改尚未保存</div> : null}
          </div>
          <div className="flex items-center gap-2 self-end">
            <Button type="button" variant="ghost" className="text-mutedToken-foreground" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button type="button" variant="outline" onClick={() => {
              setEditingName(displayName);
              setAvatarDraft(avatar ?? null);
              setPromptDraft(prompt);
              setLlmDraft(session?.llm_config_id ?? null);
              setTopologyDraft(persona.topologyEnabled === true);
              setVoiceEnabledDraft(persona.voice.enabled === true);
              const rawPid = (session?.ext as Record<string, unknown> | undefined)?.currentPersonaId;
              const pid = typeof rawPid === 'string' ? rawPid.trim() : '';
              const valid = pid !== '' && personaPresetsGlobal.some((p) => p.id === pid);
              setPersonaPresetChoiceId(valid ? pid : '');
            }} disabled={savingProfile || !isDirty}>
              重置
            </Button>
            <Button type="button" className="min-w-[104px] shadow-sm" onClick={handleSaveProfile} disabled={savingProfile || !editingName.trim() || !isDirty}>
              {savingProfile ? '保存中...' : '保存更改'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AgentNameplateDialog;
