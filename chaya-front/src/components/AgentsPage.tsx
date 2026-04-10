import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Bot, Loader, Volume2, Plus, Pencil } from 'lucide-react';
import { getAgents, Session, getSession, agentApiId } from '../services/chat';
import { updateRoleProfile } from '../services/roleApi';
import type { PersonaPreset, VoicePreset } from '../services/roleApi';
import ChayaConfigPanel from './ChayaConfigPanel';
import PersonaPresetDialog from './PersonaPresetDialog';
import VoicePresetDialog from './VoicePresetDialog';
import { Button } from './ui/Button';
import { toast } from './ui/use-toast';
import { emitSessionsChanged } from '../utils/sessionEvents';

const CHAYA_ID = 'agent_chaya';

const EMPTY_PERSONA_PRESETS: PersonaPreset[] = [];
const EMPTY_VOICE_PRESETS: VoicePreset[] = [];

/** 由主导航 `App` 传入：人设/音色预设为全局；基本设置为当前 Agent */
export type AgentsPageSection = 'persona-presets' | 'voice-presets' | 'chaya-config';

interface AgentsPageProps {
  sessionId?: string | null;
  section: AgentsPageSection;
}

const AgentsPage: React.FC<AgentsPageProps> = ({ sessionId, section }) => {
  const [agents, setAgents] = useState<Session[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [sessionDetailFailed, setSessionDetailFailed] = useState(false);
  const [personaPresetDialogOpen, setPersonaPresetDialogOpen] = useState(false);
  const [personaPresetEdit, setPersonaPresetEdit] = useState<PersonaPreset | null>(null);
  const [voicePresetDialogOpen, setVoicePresetDialogOpen] = useState(false);
  const [voicePresetEdit, setVoicePresetEdit] = useState<VoicePreset | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);

  /** 人设/音色预设存主 Agent（兼容旧 id agent_chaya 与后端 UUID primary） */
  const sharedPersonaOwner = useMemo(() => {
    const legacy = agents.find((a) => a.session_id === CHAYA_ID);
    if (legacy) return legacy;
    const primary = agents.find((a) => a.is_primary);
    if (primary) return primary;
    return agents[0] ?? null;
  }, [agents]);

  /** 当前选中的 Agent 行：勿在「已选 sessionId 但列表尚未合并该行」时回退到主 Agent，否则会短暂显示错配置 */
  const currentAgent = useMemo(() => {
    if (!sessionId) return null;
    const row = agents.find((a) => a.session_id === sessionId);
    if (row) return row;
    if (sessionId === CHAYA_ID) return sharedPersonaOwner;
    return null;
  }, [sessionId, agents, sharedPersonaOwner]);

  const editableAgent = currentAgent;
  const personaPresets: PersonaPreset[] = useMemo(
    () => (sharedPersonaOwner?.ext as any)?.personaPresets ?? EMPTY_PERSONA_PRESETS,
    [sharedPersonaOwner],
  );
  const voicePresets: VoicePreset[] = useMemo(
    () => (sharedPersonaOwner?.ext as any)?.voicePresets ?? EMPTY_VOICE_PRESETS,
    [sharedPersonaOwner],
  );

  /** 基本设置：列表里还没有该 session 对应行时视为加载中（等 getSession 合并） */
  const chayaConfigWaitingRow =
    section === 'chaya-config' && !!sessionId && !currentAgent && !sessionDetailFailed;

  const loadAgents = useCallback(async () => {
    try {
      setIsLoadingAgents(true);
      const agentSessions = await getAgents();
      setAgents(agentSessions);
    } catch (error) {
      console.error('[AgentsPage] Failed to load agents:', error);
    } finally {
      setIsLoadingAgents(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (!sessionId || sessionId === CHAYA_ID) {
      setSessionDetailFailed(false);
      return;
    }
    let cancelled = false;
    setSessionDetailFailed(false);
    getSession(sessionId)
      .then((session) => {
        if (cancelled) return;
        setAgents((prev) => {
          const exists = prev.some((a) => a.session_id === sessionId);
          if (exists) {
            return prev.map((a) => (a.session_id === sessionId ? session : a));
          }
          return [session, ...prev];
        });
      })
      .catch((error) => {
        console.error('[AgentsPage] Failed to load current agent:', error);
        if (!cancelled) setSessionDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const savePersonaPresets = async (nextList: PersonaPreset[]) => {
    if (!sharedPersonaOwner) {
      toast({ title: '无法保存', description: '未加载到主 Agent，请刷新页面后重试', variant: 'destructive' });
      return;
    }
    setPresetSaving(true);
    try {
      const ext = { ...(sharedPersonaOwner.ext || {}), personaPresets: nextList };
      await updateRoleProfile(agentApiId(sharedPersonaOwner), { ext });
      await loadAgents();
      toast({ title: '人设预设已保存', variant: 'success' });
    } catch (e) {
      toast({ title: '保存失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setPresetSaving(false);
    }
  };

  const saveVoicePresets = async (nextList: VoicePreset[]) => {
    if (!sharedPersonaOwner) {
      toast({ title: '无法保存', description: '未加载到主 Agent，请刷新页面后重试', variant: 'destructive' });
      return;
    }
    setPresetSaving(true);
    try {
      const ext = { ...(sharedPersonaOwner.ext || {}), voicePresets: nextList };
      await updateRoleProfile(agentApiId(sharedPersonaOwner), { ext });
      await loadAgents();
      toast({ title: '音色预设已保存', variant: 'success' });
    } catch (e) {
      toast({ title: '保存失败', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setPresetSaving(false);
    }
  };

  const handleSavePersonaPreset = (preset: PersonaPreset) => {
    const isEdit = personaPresetEdit != null;
    const next = isEdit
      ? personaPresets.map((p) => (p.id === preset.id ? preset : p))
      : [...personaPresets, preset];
    savePersonaPresets(next);
    setPersonaPresetEdit(null);
  };

  /** 将全局人设预设应用到当前选中的 Agent（与聊天内 PersonaSwitchDialog 逻辑一致） */
  const applyPersonaPresetToCurrentAgent = async (preset: PersonaPreset) => {
    if (!editableAgent) {
      toast({ title: '无法应用', description: '未加载当前 Agent', variant: 'destructive' });
      return;
    }
    setPresetSaving(true);
    try {
      const ext = { ...(editableAgent.ext || {}), currentPersonaId: preset.id };
      await updateRoleProfile(agentApiId(editableAgent), { system_prompt: preset.system_prompt, ext });
      await loadAgents();
      emitSessionsChanged();
      toast({ title: `已切换到「${preset.nickname}」`, variant: 'success' });
    } catch (e) {
      toast({
        title: '应用失败',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setPresetSaving(false);
    }
  };

  const handleSaveVoicePreset = (preset: VoicePreset) => {
    const isEdit = voicePresetEdit != null;
    const next = isEdit
      ? voicePresets.map((v) => (v.id === preset.id ? preset : v))
      : [...voicePresets, preset];
    saveVoicePresets(next);
    setVoicePresetEdit(null);
  };

  const renderSection = () => {
    switch (section) {
      case 'persona-presets':
        return (
          <div className="app-card-item agents-page-card app-card-pad">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-900 dark:text-white">人设管理</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPersonaPresetEdit(null);
                  setPersonaPresetDialogOpen(true);
                }}
                className="agents-page-btn-secondary"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                添加人设
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-[#858585] mb-3">
              全局人设预设（昵称 + 系统提示词），所有 Agent 会话均可切换使用
            </p>
            {personaPresets.length === 0 ? (
              <p className="text-xs text-gray-500">暂无预设，点击「添加人设」创建</p>
            ) : (
              <ul className="space-y-2 max-h-[48vh] overflow-y-auto no-scrollbar">
                {personaPresets.map((p) => {
                  const inUse =
                    !!editableAgent &&
                    (editableAgent.ext as any)?.currentPersonaId === p.id;
                  return (
                    <li
                      key={p.id}
                      className="app-list-item agents-page-list-item flex items-center justify-between gap-2 py-1.5 px-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs font-medium truncate text-gray-900 dark:text-white">
                            {p.nickname}
                          </span>
                          {inUse ? (
                            <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-primary-600 dark:text-primary-400 [data-skin='niho']:text-[var(--color-accent)]">
                              使用中
                            </span>
                          ) : null}
                        </div>
                        {p.system_prompt && (
                          <div className="text-[10px] text-gray-500 truncate">
                            {p.system_prompt.slice(0, 60)}
                            {p.system_prompt.length > 60 ? '...' : ''}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          disabled={presetSaving || !editableAgent || inUse}
                          onClick={() => void applyPersonaPresetToCurrentAgent(p)}
                          title="将此人设应用到当前 Agent"
                        >
                          使用
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-[var(--color-accent)]"
                          onClick={() => {
                            setPersonaPresetEdit(p);
                            setPersonaPresetDialogOpen(true);
                          }}
                          title="编辑"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      case 'voice-presets':
        return (
          <div className="app-card-item agents-page-card app-card-pad">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-gray-900 dark:text-white flex items-center gap-2">
                <Volume2 className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                音色管理
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setVoicePresetEdit(null);
                  setVoicePresetDialogOpen(true);
                }}
                className="agents-page-btn-secondary"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                添加音色
              </Button>
            </div>
            <p className="text-xs text-gray-500 dark:text-[#858585] mb-3">
              全局音色预设（昵称 + 提供方/角色），所有 Agent 会话均可切换使用
            </p>
            {voicePresets.length === 0 ? (
              <p className="text-xs text-gray-500">暂无预设，点击「添加音色」创建</p>
            ) : (
              <ul className="space-y-2 max-h-[48vh] overflow-y-auto no-scrollbar">
                {voicePresets.map((v) => (
                  <li
                    key={v.id}
                    className="app-list-item agents-page-list-item flex items-center justify-between gap-2 py-1.5 px-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate text-gray-900 dark:text-white">
                        {v.nickname}
                      </div>
                      <div className="text-[10px] text-gray-500 truncate">{v.voiceName}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/10 hover:text-[var(--color-accent)]"
                      onClick={() => {
                        setVoicePresetEdit(v);
                        setVoicePresetDialogOpen(true);
                      }}
                      title="编辑"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      case 'chaya-config':
        return (
          <div className="app-card-item agents-page-card app-card-pad flex flex-col min-h-0">
            <ChayaConfigPanel
              key={sessionId || 'none'}
              agent={editableAgent}
              active={!!editableAgent}
              variant="inline"
              globalPersonaPresets={personaPresets}
              onSaved={async () => {
                await loadAgents();
                emitSessionsChanged();
              }}
            />
          </div>
        );
      default:
        return null;
    }
  };

  const headerTitle =
    section === 'persona-presets'
      ? '人设管理'
      : section === 'voice-presets'
        ? '音色管理'
        : `${editableAgent?.name || editableAgent?.title || 'Agent'} · 基本设置`;

  const headerSubtitle =
    section === 'persona-presets'
      ? '全局预设，对所有 Agent 可见'
      : section === 'voice-presets'
        ? '全局预设，对所有 Agent 可见'
        : editableAgent && editableAgent.is_primary === false
          ? '当前自定义 Agent：头像、昵称、模型与系统提示词；音色与智能化仅主 Agent（Primag）'
          : '当前 Agent 的模型与人格等（与人设/音色预设列表独立）';

  const scrollShellClass =
    section === 'chaya-config'
      ? 'flex-1 min-h-0 overflow-y-auto overflow-x-hidden app-pane-pad agents-page-scroll--basic-settings'
      : 'flex-1 min-h-0 overflow-y-auto no-scrollbar app-pane-pad';

  return (
    <>
      <div className="agents-page h-full min-h-0 flex flex-col bg-[var(--surface-primary)]">
        <div className={scrollShellClass}>
          {isLoadingAgents || chayaConfigWaitingRow ? (
            <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
              <Loader className="w-6 h-6 animate-spin mr-2" />
              加载中…
            </div>
          ) : section !== 'chaya-config' && !sharedPersonaOwner ? (
            <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
              <Bot className="w-10 h-10 text-[var(--text-muted)] mb-3 opacity-60" />
              <p className="text-sm text-[var(--text-secondary)]">
                Chaya 未就绪，请刷新或检查后端
              </p>
            </div>
          ) : section === 'chaya-config' && !editableAgent ? (
            <div className="flex flex-col items-center justify-center py-16 text-center max-w-md mx-auto">
              <Bot className="w-10 h-10 text-[var(--text-muted)] mb-3 opacity-60" />
              <p className="text-sm text-[var(--text-secondary)]">
                {sessionDetailFailed
                  ? '无法加载该 Agent，请检查网络或刷新后重试'
                  : 'Chaya 未就绪，请刷新或检查后端'}
              </p>
            </div>
          ) : (
            <div
              className={`mx-auto w-full space-y-3 ${
                section === 'chaya-config' ? 'max-w-[min(100%,72rem)]' : 'max-w-6xl'
              }`}
            >
              <div className="app-card-item app-card-pad-sm">
                <div className="text-sm font-semibold text-[var(--text-primary)]">{headerTitle}</div>
                <div className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
                  {headerSubtitle}
                </div>
              </div>
              {renderSection()}
            </div>
          )}
        </div>
      </div>

      <PersonaPresetDialog
        open={personaPresetDialogOpen}
        onOpenChange={setPersonaPresetDialogOpen}
        mode={personaPresetEdit ? 'edit' : 'add'}
        initial={personaPresetEdit}
        onSave={handleSavePersonaPreset}
        saving={presetSaving}
      />
      <VoicePresetDialog
        open={voicePresetDialogOpen}
        onOpenChange={setVoicePresetDialogOpen}
        mode={voicePresetEdit ? 'edit' : 'add'}
        initial={voicePresetEdit}
        onSave={handleSaveVoicePreset}
        saving={presetSaving}
      />
    </>
  );
};

export default AgentsPage;
