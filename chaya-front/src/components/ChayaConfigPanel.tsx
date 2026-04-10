/**
 * 基本设置：按模块岛屿展示 — 基础信息 / 人设 / 智能化。
 * 供 Persona 页内嵌与 AgentPersonaDialog 共用。
 */

import React, { useState, useEffect, useRef, useId, useMemo, useLayoutEffect } from 'react';
import { Loader, Bot, User, Sparkles, Cpu } from 'lucide-react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Label } from './ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { toast } from './ui/use-toast';
import AgentPersonaConfig, {
  defaultPersonaConfig,
type AgentPersonaFullConfig,
} from './AgentPersonaConfig';
import { updateRoleProfile, type PersonaPreset } from '../services/roleApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { agentApiId, isPrimaryAgentSession, type Session } from '../services/chat';

export interface ChayaConfigPanelProps {
  agent: Session | null;
  /** 为 true 时从 agent 拉取并同步表单 */
  active: boolean;
  variant: 'inline' | 'dialog';
  /**
   * 人设预设全局库（存于主 Agent 的 ext.personaPresets）。
   * 自定义 Agent 自身 ext 通常无此字段；传入后「从预设载入」与主 Agent 一致。
   */
  globalPersonaPresets?: PersonaPreset[];
  onSaved?: () => void;
  onCancel?: () => void;
}

function stripPersonaForSave(cfg: AgentPersonaFullConfig): AgentPersonaFullConfig {
  const { skillTriggerEnabled: _s, ...rest } = cfg as AgentPersonaFullConfig & { skillTriggerEnabled?: boolean };
  return {
    ...rest,
    thinking: { ...cfg.thinking, enabled: false },
  };
}

const CUSTOM_PRESET = '__custom__';

type SaveSnapshot = {
  name: string;
  avatar: string | null;
  systemPrompt: string;
  llmConfigId: string | null;
  persona: AgentPersonaFullConfig;
};

/** 岛屿容器：圆角卡片 + 边框 */
function ConfigIsland({
  title,
  icon,
  children,
  subtitle,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] shadow-sm">
      <div className="border-b border-[var(--border-muted)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--color-accent)]">{icon}</span>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {title}
          </h3>
        </div>
        {subtitle ? (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      <div className="space-y-5 p-4">{children}</div>
    </section>
  );
}

function SubBlock({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <div className="text-xs font-medium text-[var(--text-primary)]">
        <span className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded-md bg-[var(--surface-elevated)] text-[11px] text-[var(--text-secondary)]">
          {index}
        </span>
        {title}
      </div>
      <div className="pl-0 sm:pl-0">{children}</div>
    </div>
  );
}

const ChayaConfigPanel: React.FC<ChayaConfigPanelProps> = ({
  agent,
  active,
  variant,
  globalPersonaPresets,
  onSaved,
  onCancel,
}) => {
  const uid = useId();
  const nameId = `${uid}-basic-name`;
  const promptId = `${uid}-basic-prompt`;
  const avatarInputId = `${uid}-avatar-file`;

  const [config, setConfig] = useState<AgentPersonaFullConfig>(defaultPersonaConfig);
  const [isSaving, setIsSaving] = useState(false);

  const [editName, setEditName] = useState('');
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [personaPresetId, setPersonaPresetId] = useState<string>(CUSTOM_PRESET);
  const [editLlmConfigId, setEditLlmConfigId] = useState<string | null>(null);
  const [llmConfigs, setLlmConfigs] = useState<LLMConfigFromDB[]>([]);
  const [initialSnapshot, setInitialSnapshot] = useState<SaveSnapshot | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const personaPresets: PersonaPreset[] = useMemo(() => {
    if (globalPersonaPresets !== undefined) return globalPersonaPresets;
    return ((agent?.ext as Record<string, unknown> | undefined)?.personaPresets as PersonaPreset[]) ?? [];
  }, [globalPersonaPresets, agent]);

  const personaPresetsRef = useRef(personaPresets);
  personaPresetsRef.current = personaPresets;

  const prevAgentSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (active) {
      getLLMConfigs().then(setLlmConfigs).catch(console.error);
    }
  }, [active]);

  /** 仅当切换不同 Agent 时先清空，避免同一 Agent 后台刷新引用时误清空；也避免切换瞬间残留上一 Agent 字段 */
  useLayoutEffect(() => {
    if (!agent || !active) return;
    const sid = agent.session_id;
    if (prevAgentSessionRef.current === sid) return;
    prevAgentSessionRef.current = sid;
    setEditName('');
    setEditAvatar(null);
    setEditSystemPrompt('');
    setEditLlmConfigId(null);
    setPersonaPresetId(CUSTOM_PRESET);
    setConfig(defaultPersonaConfig);
  }, [agent, active]);

  useEffect(() => {
    if (agent && active) {
      setEditName(agent.name || agent.title || '');
      setEditAvatar(agent.avatar || null);
      const sp = agent.system_prompt || '';
      setEditSystemPrompt(sp);
      setEditLlmConfigId(agent.llm_config_id || null);

      const presets = personaPresetsRef.current;
      const match = presets.find((p) => p.system_prompt === sp);
      setPersonaPresetId(match ? match.id : CUSTOM_PRESET);

      const savedPersona = (agent.ext as any)?.persona;
      if (savedPersona) {
        const nextConfig = {
          voice: savedPersona.voice || defaultPersonaConfig.voice,
          thinking: savedPersona.thinking || defaultPersonaConfig.thinking,
          memoryTriggers: savedPersona.memoryTriggers || [],
          responseMode: savedPersona.responseMode || defaultPersonaConfig.responseMode,
          memoryTriggersEnabled: savedPersona.memoryTriggersEnabled !== false ? true : false,
          topologyEnabled: savedPersona.topologyEnabled === true,
        };
        setConfig(nextConfig);
        setInitialSnapshot({
          name: agent.name || agent.title || '',
          avatar: agent.avatar || null,
          systemPrompt: sp,
          llmConfigId: agent.llm_config_id || null,
          persona: stripPersonaForSave(nextConfig),
        });
      } else {
        setConfig(defaultPersonaConfig);
        setInitialSnapshot({
          name: agent.name || agent.title || '',
          avatar: agent.avatar || null,
          systemPrompt: sp,
          llmConfigId: agent.llm_config_id || null,
          persona: stripPersonaForSave(defaultPersonaConfig),
        });
      }
    }
  }, [agent, active]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: '请选择图片文件', variant: 'destructive' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setEditAvatar(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const onPersonaPresetChange = (value: string) => {
    setPersonaPresetId(value);
    if (value === CUSTOM_PRESET) return;
    const p = personaPresets.find((x) => x.id === value);
    if (p) setEditSystemPrompt(p.system_prompt);
  };

  const onSystemPromptInput = (v: string) => {
    setEditSystemPrompt(v);
    setPersonaPresetId(CUSTOM_PRESET);
  };

  const handleSave = async () => {
    if (!agent) return;

    const primagOnly = isPrimaryAgentSession(agent);

    setIsSaving(true);
    try {
      await updateRoleProfile(agentApiId(agent), {
        name: editName.trim() || undefined,
        avatar: editAvatar || undefined,
        system_prompt: editSystemPrompt.trim() || undefined,
        llm_config_id: editLlmConfigId || undefined,
        ...(primagOnly
          ? {
              persona: stripPersonaForSave(config),
              reason: variant === 'dialog' ? 'basic_settings_dialog' : 'basic_settings_page',
            }
          : { reason: variant === 'dialog' ? 'basic_settings_dialog_custom' : 'basic_settings_page_custom' }),
      });

      toast({ title: '已保存', variant: 'success' });
      onSaved?.();
    } catch (error) {
      console.error('[ChayaConfigPanel] Save failed:', error);
      toast({
        title: '保存失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (!agent) {
    return <p className="text-xs text-[var(--text-muted)]">未选择 Agent</p>;
  }

  const primagOnly = isPrimaryAgentSession(agent);

  const enabledFeatures: string[] = [];
  if (primagOnly && config.voice.enabled) enabledFeatures.push('音色');
  const enabledLlmConfigs = llmConfigs.filter((c) => c.enabled);

  const footerHint = !primagOnly
    ? '自定义 Agent：可选用全局人设预设与编辑系统提示词；音色与智能化仅主 Agent（Primag）可用'
    : enabledFeatures.length > 0
      ? `已启用：${enabledFeatures.join('、')}`
      : '技能（Skill）属 Hardness，在 Skill 面板配置';

  const topologyId = agentApiId(agent);

  const currentSnapshot = useMemo<SaveSnapshot>(() => ({
    name: editName.trim(),
    avatar: editAvatar || null,
    systemPrompt: editSystemPrompt.trim(),
    llmConfigId: editLlmConfigId || null,
    persona: stripPersonaForSave(config),
  }), [config, editAvatar, editLlmConfigId, editName, editSystemPrompt]);

  const changeCount = useMemo(() => {
    if (!initialSnapshot) return 0;
    let count = 0;
    if (initialSnapshot.name !== currentSnapshot.name) count += 1;
    if ((initialSnapshot.avatar || null) !== (currentSnapshot.avatar || null)) count += 1;
    if (initialSnapshot.systemPrompt !== currentSnapshot.systemPrompt) count += 1;
    if ((initialSnapshot.llmConfigId || null) !== (currentSnapshot.llmConfigId || null)) count += 1;
    if (JSON.stringify(initialSnapshot.persona) !== JSON.stringify(currentSnapshot.persona)) count += 1;
    return count;
  }, [currentSnapshot, initialSnapshot]);

  const hasChanges = changeCount > 0;

  const resetToInitial = () => {
    if (!initialSnapshot) return;
    setEditName(initialSnapshot.name);
    setEditAvatar(initialSnapshot.avatar);
    setEditSystemPrompt(initialSnapshot.systemPrompt);
    setEditLlmConfigId(initialSnapshot.llmConfigId);
    setConfig(initialSnapshot.persona);
    const match = personaPresets.find((p) => p.system_prompt === initialSnapshot.systemPrompt);
    setPersonaPresetId(match ? match.id : CUSTOM_PRESET);
  };

  const inputTheme =
    'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--color-accent)] focus:ring-[var(--color-accent-bg)]';

  const bodyScrollClass =
    variant === 'inline'
      ? 'space-y-4 py-1'
      : 'flex-1 min-h-0 overflow-y-auto no-scrollbar space-y-4 py-3 px-1';

  return (
    <div className={variant === 'inline' ? 'flex flex-col' : 'flex flex-col min-h-0'}>
      <div className={bodyScrollClass}>
        <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
          以下为当前 Agent 的配置；人设预设来自左侧 Rail「Persona → 人设管理」全局库。
        </p>

        {/* 基础信息 */}
        <ConfigIsland
          title="基础信息"
          icon={<User className="h-4 w-4" />}
          subtitle="头像、显示昵称与默认对话模型"
        >
          <SubBlock index={1} title="头像">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileInputRef}
                id={avatarInputId}
                type="file"
                accept="image/*"
                onChange={handleAvatarUpload}
                className="sr-only"
              />
              <label
                htmlFor={avatarInputId}
                className="relative flex h-16 w-16 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] transition-[box-shadow,ring] hover:ring-2 hover:ring-[var(--color-accent)]/40 focus-within:ring-2 focus-within:ring-[var(--color-accent)]"
                title="更换头像"
              >
                {editAvatar ? (
                  <img src={editAvatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <Bot className="h-6 w-6 text-[var(--text-muted)]" />
                )}
              </label>
              {editAvatar ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditAvatar(null)}
                  className="text-[var(--color-secondary)] hover:bg-[var(--color-secondary-bg)] hover:text-[var(--color-secondary-hover)]"
                >
                  清除头像
                </Button>
              ) : null}
            </div>
          </SubBlock>

          <SubBlock index={2} title="昵称">
            <Label htmlFor={nameId} className="mb-1 block text-[var(--text-primary)]">
              显示名称
            </Label>
            <Input
              id={nameId}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="显示名称"
              className={inputTheme}
            />
          </SubBlock>

          <SubBlock index={3} title="默认 LLM">
            <Label className="mb-1 block text-[var(--text-primary)]">模型配置</Label>
            <Select value={editLlmConfigId || ''} onValueChange={(v) => setEditLlmConfigId(v || null)}>
              <SelectTrigger className="border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:border-[var(--color-accent)]">
                <SelectValue placeholder="选择 LLM 配置" />
              </SelectTrigger>
              <SelectContent className="border-[var(--border-default)] bg-[var(--surface-overlay)]">
                {enabledLlmConfigs.map((c) => (
                  <SelectItem
                    key={c.config_id}
                    value={c.config_id}
                    className="text-[var(--text-primary)] hover:bg-[var(--color-accent-bg)] focus:bg-[var(--color-accent-bg)]"
                  >
                    {c.name} {c.model ? `· ${c.model}` : ''} {c.provider ? `(${c.provider})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SubBlock>
        </ConfigIsland>

        {/* 人设 */}
        <ConfigIsland
          title="人设"
          icon={<Sparkles className="h-4 w-4" />}
          subtitle={
            primagOnly
              ? '系统提示词与朗读音色（TTS）'
              : '系统提示词（音色与 TTS 仅主 Agent Primag 支持）'
          }
        >
          <SubBlock index={1} title="人设">
            <Label className="mb-1 block text-[var(--text-primary)]">从预设载入</Label>
            <Select value={personaPresetId} onValueChange={onPersonaPresetChange}>
              <SelectTrigger className="mb-2 border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] focus:border-[var(--color-accent)]">
                <SelectValue placeholder="选择人设预设" />
              </SelectTrigger>
              <SelectContent className="border-[var(--border-default)] bg-[var(--surface-overlay)]">
                <SelectItem
                  value={CUSTOM_PRESET}
                  className="text-[var(--text-primary)] hover:bg-[var(--color-accent-bg)]"
                >
                  自定义（手动编辑下方提示词）
                </SelectItem>
                {personaPresets.map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    className="text-[var(--text-primary)] hover:bg-[var(--color-accent-bg)]"
                  >
                    {p.nickname || p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {personaPresets.length === 0 ? (
              <p className="text-[11px] text-[var(--text-secondary)]">
                暂无全局人设预设。请在左侧「Persona → 人设管理」添加后再回到此处选择。
              </p>
            ) : null}
            <Label htmlFor={promptId} className="mb-1 mt-2 block text-[var(--text-primary)]">
              系统提示词
            </Label>
            <Textarea
              id={promptId}
              value={editSystemPrompt}
              onChange={(e) => onSystemPromptInput(e.target.value)}
              placeholder="定义角色、能力与行为…"
              className={`min-h-[min(220px,32vh)] sm:min-h-[240px] ${inputTheme}`}
            />
          </SubBlock>

          {primagOnly ? (
            <SubBlock index={2} title="音色">
              <p className="text-[11px] text-[var(--text-secondary)]">
                关闭时不使用 TTS；开启后可选择提供方与角色。音色全局预设请在「音色管理」中维护。
              </p>
              <AgentPersonaConfig config={config} onChange={setConfig} voiceOnly compact />
            </SubBlock>
          ) : null}
        </ConfigIsland>

        {primagOnly ? (
          <ConfigIsland
            title="智能化"
            icon={<Cpu className="h-4 w-4" />}
            subtitle="行为拓扑增强为总开关：开启后构建知识图谱，回答中记忆锚点命中依赖拓扑路径；下方拓扑统计只读"
          >
            <AgentPersonaConfig
              config={config}
              onChange={setConfig}
              intelOnly
              compact
              topologyAgentId={topologyId}
            />
          </ConfigIsland>
        ) : null}
      </div>

      <div
        className={`chaya-config-savebar mt-2 flex flex-shrink-0 items-center justify-between gap-3 border-t border-[var(--border-default)] pt-3 ${
          variant === 'inline'
            ? 'sticky bottom-0 z-[1] -mx-[var(--app-space-card)] -mb-[var(--app-space-card)] mt-4 bg-[var(--surface-primary)] px-[var(--app-space-card)] pb-[var(--app-space-card)] pt-3 backdrop-blur-md'
            : ''
        }`}
      >
        <div className="chaya-config-savebar__copy min-w-0">
          <div className="chaya-config-savebar__status">
            {isSaving ? '正在保存...' : hasChanges ? `有 ${changeCount} 项待保存` : '当前更改已同步'}
          </div>
          <div className="chaya-config-savebar__hint text-[11px] text-[var(--text-secondary)]">{footerHint}</div>
        </div>
        <div className="chaya-config-savebar__actions flex flex-shrink-0 gap-2">
          {hasChanges && (
            <Button
              variant="ghost"
              onClick={resetToInitial}
              disabled={isSaving}
              className="border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:bg-[var(--color-hover-bg)] hover:text-[var(--text-primary)]"
            >
              撤销更改
            </Button>
          )}
          {variant === 'dialog' && onCancel && (
            <Button
              variant="secondary"
              onClick={onCancel}
              className="border-[var(--border-default)] bg-transparent text-[var(--text-primary)] hover:bg-[var(--surface-elevated)]"
            >
              取消
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="chaya-config-savebar__submit text-[var(--text-on-accent)] disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <Loader className="mr-2 h-4 w-4 animate-spin" />
                保存中...
              </>
            ) : (
              '保存'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChayaConfigPanel;
