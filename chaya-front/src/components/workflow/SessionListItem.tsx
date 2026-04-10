/**
 * SessionListItem 组件
 * 会话列表项，包含头像编辑、技能包配置、职业选择、人设编辑等功能
 */

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Loader, Plus, Trash2, X } from 'lucide-react';
import { getLLMConfigs, LLMConfigFromDB } from '../../services/llmApi';
import { getSkillPacks, getSessionSkillPacks, assignSkillPack, unassignSkillPack, SkillPack, SessionSkillPack } from '../../services/skillPackApi';
import {
  updateSessionSystemPrompt,
  updateSessionMediaOutputPath,
  updateSessionLLMConfig,
  isPrimaryAgentSession,
  Session,
} from '../../services/chat';
import { createRole, updateRoleProfile } from '../../services/roleApi';
import { getDimensionOptions, saveDimensionOption } from '../../services/roleDimensionApi';
import { toast } from '../ui/use-toast';
import { emitSessionsChanged } from '../../utils/sessionEvents';
import AgentPersonaConfig, { defaultPersonaConfig, type AgentPersonaFullConfig } from '../AgentPersonaConfig';
import {
  applyProfessionToNameOrPrompt,
  detectProfessionType,
  extractProfession,
  getDefaultCareerProfessions,
  getDefaultGameProfessions,
} from './profession';

const DEFAULT_CAREER_PROFESSIONS = getDefaultCareerProfessions();
const DEFAULT_GAME_PROFESSIONS = getDefaultGameProfessions();

export interface SessionListItemProps {
  session: Session;
  displayName: string;
  avatarUrl: string | null;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onUpdateName: (name: string) => Promise<void>;
  onUpdateAvatar: (avatar: string) => Promise<void>;
  onConfigSaved?: () => Promise<Session | null>; // 配置保存后的回调，用于刷新会话列表，返回更新后的会话数据
}

export const SessionListItem: React.FC<SessionListItemProps> = ({
  session,
  displayName,
  avatarUrl,
  isSelected,
  onSelect,
  onDelete,
  onUpdateName,
  onUpdateAvatar,
  onConfigSaved,
}) => {
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false); // 会话配置对话框（包含头像、昵称、人设、技能包、多媒体保存地址）
  const [editName, setEditName] = useState(session.name || '');
  const [editAvatar, setEditAvatar] = useState<string | null>(avatarUrl);
  const [editSystemPrompt, setEditSystemPrompt] = useState(session.system_prompt || '');
  const [editMediaOutputPath, setEditMediaOutputPath] = useState(session.media_output_path || '');
  const [editLlmConfigId, setEditLlmConfigId] = useState<string | null>(session.llm_config_id || null);
  const [editProfession, setEditProfession] = useState<string | null>(null); // 职业选择
  const [editProfessionType, setEditProfessionType] = useState<'career' | 'game'>('career'); // 职业类型（功能职业或游戏职业）
  const [careerProfessions, setCareerProfessions] = useState<string[]>(DEFAULT_CAREER_PROFESSIONS); // 功能职业列表
  const [gameProfessions, setGameProfessions] = useState<string[]>(DEFAULT_GAME_PROFESSIONS); // 游戏职业列表
  const [isLoadingProfessions, setIsLoadingProfessions] = useState(false); // 加载职业列表状态
  const [showAddProfessionDialog, setShowAddProfessionDialog] = useState(false); // 添加职业对话框
  const [newProfessionValue, setNewProfessionValue] = useState(''); // 新职业名称
  const fileInputRef = useRef<HTMLInputElement>(null);
  const configFileInputRef = useRef<HTMLInputElement>(null); // 配置对话框的文件输入
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false); // 配置保存状态
  const [isSavingAsRole, setIsSavingAsRole] = useState(false);
  const [activeConfigTab, setActiveConfigTab] = useState<'basic' | 'skillpack' | 'media' | 'persona'>('basic'); // 配置对话框的标签页

  /** 自定义 Agent（非主）：高级 Persona 与 Primag 能力入口隐藏 */
  const hidePrimagPersonaTab = session.session_type === 'agent' && !isPrimaryAgentSession(session);

  useEffect(() => {
    if (hidePrimagPersonaTab && activeConfigTab === 'persona') {
      setActiveConfigTab('basic');
    }
  }, [hidePrimagPersonaTab, activeConfigTab]);

  // Persona 高级配置状态
  const [editPersonaConfig, setEditPersonaConfig] = useState<AgentPersonaFullConfig>(defaultPersonaConfig);
  
  // 技能包管理状态
  const [showSkillPackTab, setShowSkillPackTab] = useState(false);
  const [allSkillPacks, setAllSkillPacks] = useState<SkillPack[]>([]);
  const [sessionSkillPacks, setSessionSkillPacks] = useState<SessionSkillPack[]>([]);
  const [isLoadingSkillPacks, setIsLoadingSkillPacks] = useState(false);
  // 仅用于会话配置弹窗里的"默认模型"下拉；该组件目前没有入口（会话切换已迁移到 App Header）
  const [localLLMConfigs, setLocalLLMConfigs] = useState<LLMConfigFromDB[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const configs = await getLLMConfigs();
        if (!cancelled) setLocalLLMConfigs(configs || []);
      } catch {
        if (!cancelled) setLocalLLMConfigs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载技能包数据
  const loadSkillPacks = async () => {
    setIsLoadingSkillPacks(true);
    try {
      const [allPacks, sessionPacks] = await Promise.all([
        getSkillPacks(),
        getSessionSkillPacks(session.session_id),
      ]);
      setAllSkillPacks(allPacks);
      setSessionSkillPacks(sessionPacks);
    } catch (error) {
      console.error('[SessionListItem] Failed to load skill packs:', error);
    } finally {
      setIsLoadingSkillPacks(false);
    }
  };

  // 加载职业列表（包括自定义职业）
  const loadProfessions = async () => {
    setIsLoadingProfessions(true);
    try {
      const [careerOptions, gameOptions] = await Promise.all([
        getDimensionOptions('profession', 'career'),
        getDimensionOptions('profession', 'game'),
      ]);
      setCareerProfessions([...DEFAULT_CAREER_PROFESSIONS, ...careerOptions]);
      setGameProfessions([...DEFAULT_GAME_PROFESSIONS, ...gameOptions]);
    } catch (error) {
      console.error('[SessionListItem] Failed to load professions:', error);
    } finally {
      setIsLoadingProfessions(false);
    }
  };

  // 保存自定义职业
  const handleSaveCustomProfession = async () => {
    if (!newProfessionValue.trim()) {
      toast({ title: '请输入职业名称', variant: 'destructive' });
      return;
    }

    try {
      const result = await saveDimensionOption('profession', editProfessionType, newProfessionValue.trim());
      if (result.success) {
        toast({ title: '职业已添加', variant: 'success' });
        // 重新加载职业列表
        await loadProfessions();
        // 自动选择新添加的职业
        setEditProfession(newProfessionValue.trim());
        setShowAddProfessionDialog(false);
        setNewProfessionValue('');
      } else {
        toast({ title: '添加失败', description: result.error, variant: 'destructive' });
      }
    } catch (error) {
      console.error('[SessionListItem] Failed to save custom profession:', error);
      toast({ title: '添加失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  // 点击头像弹出完整配置对话框
  const handleAvatarClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // 如果提供了刷新回调，先刷新会话数据以确保获取最新值（例如从圆桌面板修改的配置）
    let currentSession = session;
    if (onConfigSaved) {
      const updatedSession = await onConfigSaved();
      // 如果返回了更新后的会话数据，使用它；否则使用当前的 session prop
      if (updatedSession) {
        currentSession = updatedSession;
      }
    }
    // 从最新的会话数据加载值
    setEditName(currentSession.name || '');
    setEditAvatar(currentSession.avatar || null);
    setEditSystemPrompt(currentSession.system_prompt || '');
    setEditMediaOutputPath(currentSession.media_output_path || '');
    // 判断职业类型并提取当前职业
    const professionType = detectProfessionType(currentSession.name, currentSession.system_prompt);
    setEditProfessionType(professionType);
    const allProfessions = professionType === 'career' ? careerProfessions : gameProfessions;
    const currentProfession = extractProfession(currentSession.name, currentSession.system_prompt, allProfessions);
    setEditProfession(currentProfession);
    setActiveConfigTab('basic');
    loadSkillPacks();
    loadProfessions(); // 加载职业列表
    setShowConfigDialog(true);
  };

  const handleSaveAsRole = async () => {
    const name = editName.trim() || displayName;
    const avatar = (editAvatar || '').trim();
    const systemPrompt = editSystemPrompt.trim();
    const llmConfigId = editLlmConfigId;
    const mediaOutputPath = editMediaOutputPath.trim();

    if (!avatar || !systemPrompt || !llmConfigId) {
      toast({
        title: '还差一步',
        description: '保存为角色需要：头像、人设、默认LLM。',
        variant: 'destructive',
      });
      setActiveConfigTab('basic');
      return;
    }

    setIsSavingAsRole(true);
    try {
      const role = await createRole({
        name,
        avatar,
        system_prompt: systemPrompt,
        llm_config_id: llmConfigId,
        media_output_path: mediaOutputPath || undefined,
      });
      if (onConfigSaved) {
        await onConfigSaved();
      }
      emitSessionsChanged();
      setShowConfigDialog(false);
      toast({
        title: '已保存为角色',
        description: `角色「${role.name || role.title || role.session_id}」已加入角色库`,
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to save as role:', error);
      toast({
        title: '保存为角色失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsSavingAsRole(false);
    }
  };

  // 当 session prop 变化时，同步更新编辑状态（如果对话框已打开）
  // 这确保当父组件刷新会话列表后，对话框中的值也会更新
  useEffect(() => {
    if (showConfigDialog) {
      setEditName(session.name || '');
      setEditAvatar(session.avatar || null);
      setEditSystemPrompt(session.system_prompt || '');
      setEditMediaOutputPath(session.media_output_path || '');
      setEditLlmConfigId(session.llm_config_id || null);
      // 判断职业类型并提取当前职业
      const professionType = detectProfessionType(session.name, session.system_prompt);
      setEditProfessionType(professionType);
      const allProfessions = professionType === 'career' ? careerProfessions : gameProfessions;
      const currentProfession = extractProfession(session.name, session.system_prompt, allProfessions);
      setEditProfession(currentProfession);
      // 加载 Persona 配置
      const savedPersona = (session.ext as any)?.persona;
      if (savedPersona) {
        setEditPersonaConfig({
          voice: savedPersona.voice || defaultPersonaConfig.voice,
          thinking: savedPersona.thinking || defaultPersonaConfig.thinking,
          memoryTriggers: savedPersona.memoryTriggers || [],
          responseMode: savedPersona.responseMode || defaultPersonaConfig.responseMode,
        });
      } else {
        setEditPersonaConfig(defaultPersonaConfig);
      }
    }
  }, [session.name, session.avatar, session.system_prompt, session.media_output_path, session.llm_config_id, session.ext, showConfigDialog, careerProfessions, gameProfessions]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 检查文件类型
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件');
      return;
    }

    // 检查文件大小（限制为 2MB）
    if (file.size > 2 * 1024 * 1024) {
      alert('图片大小不能超过 2MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64String = event.target?.result as string;
      setEditAvatar(base64String);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // 更新名称
      if (editName.trim() !== (session.name || '')) {
        await onUpdateName(editName.trim());
      }
      
      // 更新头像
      if (editAvatar !== avatarUrl) {
        await onUpdateAvatar(editAvatar || '');
      }
      
      setShowEditDialog(false);
    } catch (error) {
      console.error('[SessionListItem] Failed to save:', error);
      alert('保存失败，请重试');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setShowEditDialog(false);
    setEditName(session.name || '');
    setEditAvatar(avatarUrl);
    setShowSkillPackTab(false);
  };

  // 切换技能包分配状态
  const toggleSkillPackAssignment = async (skillPackId: string, isAssigned: boolean) => {
    try {
      if (isAssigned) {
        await unassignSkillPack(skillPackId, session.session_id);
      } else {
        const targetType = session.session_type === 'agent' ? 'agent' : undefined;
        await assignSkillPack(skillPackId, session.session_id, targetType);
      }
      await loadSkillPacks();
    } catch (error: any) {
      console.error('[SessionListItem] Failed to toggle skill pack assignment:', error);
      alert(`操作失败: ${error.message}`);
    }
  };

  // 默认头像 SVG（机器人图标）
  const DefaultAvatar = () => (
    <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center flex-shrink-0 cursor-pointer hover:bg-primary-700 transition-colors">
      <Bot className="w-5 h-5 text-white" />
    </div>
  );

  return (
    <>
      <div
        className={`group relative w-full text-left px-2.5 py-2 rounded-lg text-sm transition-colors ${
          isSelected
            ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-200 border border-primary-200 dark:border-primary-800'
            : 'bg-gray-50 dark:bg-[#363636] text-gray-700 dark:text-[#ffffff] hover:bg-gray-100 dark:hover:bg-[#404040] border border-gray-200 dark:border-[#404040]'
        }`}
      >
        <button
          onClick={onSelect}
          className="w-full text-left"
        >
          <div className="flex items-start space-x-2">
            {/* 头像 - 可点击 */}
            <div onClick={handleAvatarClick} className="cursor-pointer hover:opacity-80 transition-opacity">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt="Avatar"
                  className="w-8 h-8 rounded-full flex-shrink-0 object-cover"
                />
              ) : (
                <DefaultAvatar />
              )}
            </div>
            
            <div className="flex-1 min-w-0">
              {/* 名称显示 */}
              <div className="font-medium truncate">
                {displayName}
              </div>
              
              <div className="flex items-center space-x-2 mt-0.5 text-xs text-gray-500 dark:text-[#b0b0b0]">
                {session.message_count ? (
                  <span>{session.message_count} 条消息</span>
                ) : null}
                {session.last_message_at && (
                  <span className="truncate">
                    {new Date(session.last_message_at).toLocaleDateString('zh-CN', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </button>
        
        {/* 删除按钮 */}
        <button
          onClick={onDelete}
          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-red-600 dark:hover:text-red-400 rounded"
          title="删除会话"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 编辑对话框 */}
      {showEditDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={handleCancel}>
          <div className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-[#ffffff]">
                编辑会话
              </h3>
              <button
                onClick={handleCancel}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 标签页 */}
            <div className="flex border-b border-gray-200 dark:border-[#404040] mb-4">
              <button
                onClick={() => setShowSkillPackTab(false)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  !showSkillPackTab
                    ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                }`}
              >
                基本信息
              </button>
              <button
                onClick={() => {
                  setShowSkillPackTab(true);
                  loadSkillPacks();
                }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  showSkillPackTab
                    ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                }`}
              >
                技能包
              </button>
            </div>

            {showSkillPackTab ? (
              /* 技能包管理 */
              <div className="space-y-4">
                {isLoadingSkillPacks ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader className="w-6 h-6 animate-spin text-primary-500" />
                  </div>
                ) : (
                  <>
                    <div className="text-sm text-gray-600 dark:text-[#b0b0b0] mb-2">
                      为{session.session_type === 'agent' ? '智能体' : '会话'}分配技能包
                    </div>
                    {allSkillPacks.length === 0 ? (
                      <div className="text-center py-8 text-gray-500 dark:text-[#b0b0b0]">
                        暂无技能包，请在聊天界面创建技能包
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-96 overflow-y-auto">
                        {allSkillPacks.map((pack) => {
                          const isAssigned = sessionSkillPacks.some(
                            sp => sp.skill_pack_id === pack.skill_pack_id
                          );
                          return (
                            <div
                              key={pack.skill_pack_id}
                              className={`flex items-start space-x-3 p-3 rounded-lg border ${
                                isAssigned
                                  ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800'
                                  : 'bg-gray-50 dark:bg-[#363636] border-gray-200 dark:border-[#404040]'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isAssigned}
                                onChange={() => toggleSkillPackAssignment(pack.skill_pack_id, isAssigned)}
                                className="mt-1 w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-sm text-gray-900 dark:text-white">
                                  {pack.name}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1 line-clamp-2">
                                  {pack.summary}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              /* 基本信息编辑 */
              <div className="space-y-4">
              {/* 头像编辑 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                  头像
                </label>
                <div className="flex items-center space-x-4">
                  <div className="relative">
                    {editAvatar ? (
                      <img
                        src={editAvatar}
                        alt="Avatar"
                        className="w-16 h-16 rounded-full object-cover border-2 border-gray-200 dark:border-[#404040]"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-primary-600 flex items-center justify-center border-2 border-gray-200 dark:border-[#404040]">
                        <Bot className="w-8 h-8 text-white" />
                      </div>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarUpload}
                      className="hidden"
                    />
                  </div>
                  <div className="flex flex-col space-y-2">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] text-gray-700 dark:text-[#ffffff] rounded transition-colors"
                    >
                      选择图片
                    </button>
                    {editAvatar && (
                      <button
                        onClick={() => setEditAvatar(null)}
                        className="px-3 py-1.5 text-sm bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 rounded transition-colors"
                      >
                        清除头像
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-2">
                  支持 JPG、PNG 等图片格式，建议大小不超过 2MB
                </p>
              </div>

              {/* 名称编辑 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                  会话名称
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSave();
                    } else if (e.key === 'Escape') {
                      handleCancel();
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                  placeholder="输入会话名称（留空则使用默认名称）"
                />
              </div>

              {/* 人设显示 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                  人设
                </label>
                <div className={`px-3 py-2.5 rounded-lg text-sm ${
                  session.system_prompt 
                    ? 'bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700' 
                    : 'bg-gray-50 dark:bg-[#363636] border border-dashed border-gray-300 dark:border-[#404040]'
                }`}>
                  {session.system_prompt ? (
                    <p className="text-gray-700 dark:text-[#ffffff] line-clamp-3">
                      {session.system_prompt}
                    </p>
                  ) : (
                    <p className="text-gray-400 dark:text-[#808080] italic">
                      人设为空
                    </p>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                  人设可在聊天界面底部设置
                </p>
              </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={handleCancel}
                disabled={isSaving}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#ffffff] bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] rounded-lg transition-colors disabled:opacity-50"
              >
                关闭
              </button>
              {!showSkillPackTab && (
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 flex items-center space-x-2"
                >
                  {isSaving ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      <span>保存中...</span>
                    </>
                  ) : (
                    <span>保存</span>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话配置对话框 - 使用 Portal 渲染到 body 下，确保在主界面中心显示 */}
      {showConfigDialog && createPortal(
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]" onClick={() => setShowConfigDialog(false)}>
          <div className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between flex-shrink-0">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                配置会话
              </h3>
              <button
                onClick={() => setShowConfigDialog(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 标签页 */}
            <div className="flex border-b border-gray-200 dark:border-[#404040] flex-shrink-0">
              <button
                onClick={() => setActiveConfigTab('basic')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeConfigTab === 'basic'
                    ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                }`}
              >
                基本信息
              </button>
              <button
                onClick={() => {
                  setActiveConfigTab('skillpack');
                  loadSkillPacks();
                }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeConfigTab === 'skillpack'
                    ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                }`}
              >
                技能包
              </button>
              <button
                onClick={() => setActiveConfigTab('media')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeConfigTab === 'media'
                    ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                    : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                }`}
              >
                多媒体设置
              </button>
              {!hidePrimagPersonaTab ? (
                <button
                  onClick={() => setActiveConfigTab('persona')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeConfigTab === 'persona'
                      ? 'border-primary-500 dark:border-primary-600 text-primary-600 dark:text-primary-400'
                      : 'border-transparent text-gray-500 dark:text-[#b0b0b0] hover:text-gray-700 dark:hover:text-[#cccccc]'
                  }`}
                >
                  高级设置
                </button>
              ) : null}
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto p-5">
              {activeConfigTab === 'basic' && (
                <div className="space-y-4">
                  {/* 头像配置 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                      头像
                    </label>
                    <div className="flex items-center space-x-4">
                      <div className="relative">
                        <div className="w-20 h-20 rounded-full overflow-hidden border-2 border-gray-200 dark:border-[#404040] flex items-center justify-center bg-gray-100 dark:bg-[#363636]">
                          {editAvatar ? (
                            <img src={editAvatar} alt="Avatar" className="w-full h-full object-cover" />
                          ) : (
                            <Bot className="w-10 h-10 text-gray-400" />
                          )}
                        </div>
                        <input
                          ref={configFileInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (!file.type.startsWith('image/')) {
                              alert('请选择图片文件');
                              return;
                            }
                            if (file.size > 2 * 1024 * 1024) {
                              alert('图片大小不能超过 2MB');
                              return;
                            }
                            const reader = new FileReader();
                            reader.onload = (event) => {
                              setEditAvatar(event.target?.result as string);
                            };
                            reader.readAsDataURL(file);
                          }}
                        />
                      </div>
                      <div className="flex flex-col space-y-2">
                        <button
                          onClick={() => configFileInputRef.current?.click()}
                          className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] text-gray-700 dark:text-[#ffffff] rounded transition-colors"
                        >
                          选择图片
                        </button>
                        {editAvatar && (
                          <button
                            onClick={() => setEditAvatar(null)}
                            className="px-3 py-1.5 text-sm bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-400 rounded transition-colors"
                          >
                            清除头像
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-2">
                      支持 JPG、PNG 等格式，建议大小不超过 2MB
                    </p>
                  </div>

                  {/* 昵称配置 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                      昵称
                    </label>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                      placeholder="输入会话昵称（留空则使用默认名称）"
                    />
                  </div>

                  {/* 职业选择（仅对 agent 显示） */}
                  {session.session_type === 'agent' && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff]">
                          职业
                        </label>
                        <button
                          onClick={() => setShowAddProfessionDialog(true)}
                          className="flex items-center gap-1 px-2 py-1 text-xs text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded transition-colors"
                          title="添加自定义职业"
                        >
                          <Plus className="w-3 h-3" />
                          <span>添加</span>
                        </button>
                      </div>
                      
                      {/* 职业类型切换 */}
                      <div className="flex gap-2 mb-2">
                        <button
                          onClick={() => {
                            setEditProfessionType('career');
                            setEditProfession(null); // 切换类型时清空选择
                          }}
                          className={`flex-1 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                            editProfessionType === 'career'
                              ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                              : 'bg-gray-100 dark:bg-[#363636] text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-200 dark:hover:bg-[#404040]'
                          }`}
                        >
                          功能职业
                        </button>
                        <button
                          onClick={() => {
                            setEditProfessionType('game');
                            setEditProfession(null); // 切换类型时清空选择
                          }}
                          className={`flex-1 px-3 py-1.5 text-sm rounded-lg transition-colors ${
                            editProfessionType === 'game'
                              ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                              : 'bg-gray-100 dark:bg-[#363636] text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-200 dark:hover:bg-[#404040]'
                          }`}
                        >
                          游戏职业
                        </button>
                      </div>
                      
                      {/* 职业选择下拉框 */}
                      <select
                        value={editProfession || ''}
                        onChange={(e) => {
                          const selectedProfession = e.target.value || null;
                          setEditProfession(selectedProfession);
                          // 自动更新名称和人设以反映职业变化
                          const currentProfessionList = editProfessionType === 'career' ? careerProfessions : gameProfessions;
                          const { name, systemPrompt } = applyProfessionToNameOrPrompt(
                            selectedProfession,
                            editName,
                            editSystemPrompt,
                            currentProfessionList
                          );
                          setEditName(name);
                          setEditSystemPrompt(systemPrompt);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                        disabled={isLoadingProfessions}
                      >
                        <option value="">无（自定义）</option>
                        {(editProfessionType === 'career' ? careerProfessions : gameProfessions).map(profession => (
                          <option key={profession} value={profession}>
                            {profession}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                        选择职业后，会自动更新名称和人设中的职业信息
                      </p>
                    </div>
                  )}

                  {/* 人设配置 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                      人设
                    </label>
                    <textarea
                      value={editSystemPrompt}
                      onChange={(e) => setEditSystemPrompt(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600 resize-none"
                      rows={6}
                      placeholder="输入系统提示词（人设），用于定义AI的角色和行为..."
                    />
                    <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                      人设定义了AI的角色、风格和行为特征
                    </p>
                  </div>

                  {/* 默认模型配置 */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                      默认模型
                    </label>
                    <select
                      value={editLlmConfigId || ''}
                      onChange={(e) => setEditLlmConfigId(e.target.value || null)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                    >
                      <option value="">不设置默认模型</option>
                      {localLLMConfigs.filter(c => c.enabled).map(config => (
                        <option key={config.config_id} value={config.config_id}>
                          {config.name} ({config.provider})
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                      选择该会话默认使用的 LLM 模型，选中后会自动应用到聊天
                    </p>
                  </div>
                </div>
              )}

              {activeConfigTab === 'skillpack' && (
                <div className="space-y-4">
                  {isLoadingSkillPacks ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader className="w-6 h-6 animate-spin text-primary-500" />
                    </div>
                  ) : (
                    <>
                      <div className="text-sm text-gray-600 dark:text-[#b0b0b0] mb-2">
                        为{session.session_type === 'agent' ? '智能体' : '会话'}分配技能包
                      </div>
                      {allSkillPacks.length === 0 ? (
                        <div className="text-center py-8 text-gray-500 dark:text-[#b0b0b0]">
                          暂无技能包，请在聊天界面创建技能包
                        </div>
                      ) : (
                        <div className="space-y-2 max-h-96 overflow-y-auto">
                          {allSkillPacks.map((pack) => {
                            const isAssigned = sessionSkillPacks.some(
                              sp => sp.skill_pack_id === pack.skill_pack_id
                            );
                            return (
                              <div
                                key={pack.skill_pack_id}
                                className={`flex items-start space-x-3 p-3 rounded-lg border ${
                                  isAssigned
                                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800'
                                    : 'bg-gray-50 dark:bg-[#363636] border-gray-200 dark:border-[#404040]'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isAssigned}
                                  onChange={() => toggleSkillPackAssignment(pack.skill_pack_id, isAssigned)}
                                  className="mt-1 w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm text-gray-900 dark:text-white">
                                    {pack.name}
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1 line-clamp-2">
                                    {pack.summary}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {activeConfigTab === 'media' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                      多媒体保存地址
                    </label>
                    <input
                      type="text"
                      value={editMediaOutputPath}
                      onChange={(e) => setEditMediaOutputPath(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                      placeholder="输入本地路径，例如：/Users/username/Documents/media 或 C:\Users\username\Documents\media"
                    />
                    <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                      设置图片、视频、音频等多媒体文件的保存路径。留空则使用默认路径。
                    </p>
                  </div>
                </div>
              )}

              {activeConfigTab === 'persona' && !hidePrimagPersonaTab ? (
                <div className="space-y-4">
                  <div className="text-sm text-gray-600 dark:text-[#b0b0b0] mb-4">
                    配置语音、自驱思考、记忆触发等高级 Persona 功能
                  </div>
                  <AgentPersonaConfig
                    config={editPersonaConfig}
                    onChange={setEditPersonaConfig}
                    compact
                  />
                </div>
              ) : null}
            </div>

            {/* 底部按钮 */}
            <div className="px-5 py-4 bg-gray-50 dark:bg-[#1a1a1a] flex items-center justify-end space-x-3 flex-shrink-0">
              {session.session_type !== 'agent' && (
                <button
                  onClick={handleSaveAsRole}
                  disabled={isSavingConfig || isSavingAsRole}
                  className="px-4 py-2 text-sm font-medium text-primary-700 dark:text-primary-300 bg-primary-100 dark:bg-primary-900/30 hover:bg-primary-200 dark:hover:bg-primary-900/50 rounded-lg transition-colors disabled:opacity-50 flex items-center space-x-2"
                  title="复制当前配置为一个可复用角色（不影响当前会话）"
                >
                  {isSavingAsRole ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      <span>保存为角色中...</span>
                    </>
                  ) : (
                    <span>保存为角色</span>
                  )}
                </button>
              )}
              <button
                onClick={() => setShowConfigDialog(false)}
                className="text-sm text-gray-600 dark:text-[#b0b0b0] hover:text-gray-900 dark:hover:text-[#cccccc]"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  setIsSavingConfig(true);
                  try {
                    // 如果职业发生变化，应用职业到名称和人设
                    let finalName = editName.trim();
                    let finalSystemPrompt = editSystemPrompt.trim();
                    
                    const currentProfessionList = editProfessionType === 'career' ? careerProfessions : gameProfessions;
                    const currentProfession = extractProfession(session.name, session.system_prompt, currentProfessionList);
                    if (editProfession !== currentProfession) {
                      // 职业发生变化，应用职业更新
                      const applied = applyProfessionToNameOrPrompt(
                        editProfession,
                        finalName,
                        finalSystemPrompt,
                        currentProfessionList
                      );
                      finalName = applied.name;
                      finalSystemPrompt = applied.systemPrompt;
                    }
                    
                    // 保存所有配置
                    const promises: Promise<void>[] = [];
                    
                    if (finalName !== (session.name || '')) {
                      promises.push(onUpdateName(finalName));
                    }
                    
                    if (editAvatar !== avatarUrl) {
                      promises.push(onUpdateAvatar(editAvatar || ''));
                    }
                    
                    if (finalSystemPrompt !== (session.system_prompt || '')) {
                      promises.push(updateSessionSystemPrompt(session.session_id, finalSystemPrompt || null));
                    }
                    
                    if (editMediaOutputPath !== (session.media_output_path || '')) {
                      promises.push(updateSessionMediaOutputPath(session.session_id, editMediaOutputPath.trim() || null));
                    }
                    
                    if (editLlmConfigId !== (session.llm_config_id || null)) {
                      promises.push(updateSessionLLMConfig(session.session_id, editLlmConfigId));
                    }
                    
                    // 保存 Persona 配置（仅主 Agent / 非 agent 会话；自定义 Agent 由顶栏基本设置维护）
                    if (!hidePrimagPersonaTab) {
                      const savedPersona = (session.ext as any)?.persona;
                      const personaChanged =
                        JSON.stringify(editPersonaConfig) !== JSON.stringify(savedPersona || defaultPersonaConfig);
                      if (personaChanged) {
                        promises.push(
                          updateRoleProfile(session.session_id, {
                            persona: editPersonaConfig,
                            reason: 'session_config_dialog',
                          }).then(() => {}),
                        );
                      }
                    }
                    
                    await Promise.all(promises);
                    // 保存成功后，刷新会话列表以获取最新数据
                    if (onConfigSaved) {
                      await onConfigSaved();
                    }
                  emitSessionsChanged();
                    setShowConfigDialog(false);
                  } catch (error) {
                    console.error('Failed to save config:', error);
                    alert('保存配置失败，请重试');
                  } finally {
                    setIsSavingConfig(false);
                  }
                }}
                disabled={isSavingConfig || isSavingAsRole}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 flex items-center space-x-2"
              >
                {isSavingConfig ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    <span>保存中...</span>
                  </>
                ) : (
                  <span>保存</span>
                )}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 添加自定义职业对话框 */}
      {showAddProfessionDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10000]" onClick={() => setShowAddProfessionDialog(false)}>
          <div className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl p-6 max-w-md w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-[#ffffff]">
                添加自定义职业
              </h3>
              <button
                onClick={() => setShowAddProfessionDialog(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                  职业类型
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditProfessionType('career')}
                    className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                      editProfessionType === 'career'
                        ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                        : 'bg-gray-100 dark:bg-[#363636] text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-200 dark:hover:bg-[#404040]'
                    }`}
                  >
                    功能职业
                  </button>
                  <button
                    onClick={() => setEditProfessionType('game')}
                    className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                      editProfessionType === 'game'
                        ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                        : 'bg-gray-100 dark:bg-[#363636] text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-200 dark:hover:bg-[#404040]'
                    }`}
                  >
                    游戏职业
                  </button>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                  职业名称
                </label>
                <input
                  type="text"
                  value={newProfessionValue}
                  onChange={(e) => setNewProfessionValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveCustomProfession();
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                  placeholder="输入职业名称..."
                  autoFocus
                />
              </div>
            </div>
            
            <div className="flex items-center justify-end space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowAddProfessionDialog(false);
                  setNewProfessionValue('');
                }}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#ffffff] bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSaveCustomProfession}
                className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default SessionListItem;
