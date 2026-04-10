/**
 * Workflow 配置管理 Hook
 * 管理会话配置、对话框状态、LLM配置等
 */

import { useState } from 'react';
import type { Session } from '../../../services/chat';
import type { TopicDisplayType } from '../dialogs/TopicConfigDialog';
import type { Participant } from '../../../services/chat';
import { DEFAULT_CAREER_PROFESSIONS, DEFAULT_GAME_PROFESSIONS } from '../dialogs/AddProfessionDialog';

export interface UseWorkflowConfigReturn {
  // 当前会话配置
  currentSessionAvatar: string | null;
  setCurrentSessionAvatar: (avatar: string | null) => void;
  currentSystemPrompt: string | null;
  setCurrentSystemPrompt: (prompt: string | null) => void;
  
  // 头像配置对话框
  showAvatarConfigDialog: boolean;
  setShowAvatarConfigDialog: (show: boolean) => void;
  avatarConfigDraft: string | null;
  setAvatarConfigDraft: (draft: string | null) => void;
  
  // 头部配置对话框
  showHeaderConfigDialog: boolean;
  setShowHeaderConfigDialog: (show: boolean) => void;
  headerConfigEditName: string;
  setHeaderConfigEditName: (name: string) => void;
  headerConfigEditAvatar: string | null;
  setHeaderConfigEditAvatar: (avatar: string | null) => void;
  headerConfigEditSystemPrompt: string;
  setHeaderConfigEditSystemPrompt: (prompt: string) => void;
  headerConfigEditMediaOutputPath: string;
  setHeaderConfigEditMediaOutputPath: (path: string) => void;
  headerConfigEditLlmConfigId: string | null;
  setHeaderConfigEditLlmConfigId: (id: string | null) => void;
  headerConfigEditProfession: string | null;
  setHeaderConfigEditProfession: (profession: string | null) => void;
  headerConfigEditProfessionType: 'career' | 'game';
  setHeaderConfigEditProfessionType: (type: 'career' | 'game') => void;
  headerConfigCareerProfessions: string[];
  setHeaderConfigCareerProfessions: (professions: string[]) => void;
  headerConfigGameProfessions: string[];
  setHeaderConfigGameProfessions: (professions: string[]) => void;
  isLoadingHeaderProfessions: boolean;
  setIsLoadingHeaderProfessions: (loading: boolean) => void;
  showHeaderAddProfessionDialog: boolean;
  setShowHeaderAddProfessionDialog: (show: boolean) => void;
  headerNewProfessionValue: string;
  setHeaderNewProfessionValue: (value: string) => void;
  headerConfigActiveTab: 'basic' | 'skillpacks';
  setHeaderConfigActiveTab: (tab: 'basic' | 'skillpacks') => void;
  isSavingHeaderAsRole: boolean;
  setIsSavingHeaderAsRole: (saving: boolean) => void;
  
  // Topic 配置对话框
  showTopicConfigDialog: boolean;
  setShowTopicConfigDialog: (show: boolean) => void;
  topicConfigEditName: string;
  setTopicConfigEditName: (name: string) => void;
  topicConfigEditAvatar: string | null;
  setTopicConfigEditAvatar: (avatar: string | null) => void;
  topicConfigEditDisplayType: TopicDisplayType;
  setTopicConfigEditDisplayType: (type: TopicDisplayType) => void;
  topicParticipants: Participant[];
  setTopicParticipants: (participants: Participant[]) => void;
  
  // Agent Persona 对话框
  showAgentPersonaDialog: boolean;
  setShowAgentPersonaDialog: (show: boolean) => void;
  agentPersonaDialogAgent: Session | null;
  setAgentPersonaDialogAgent: (agent: Session | null) => void;
  
  // 系统提示词编辑
  isEditingSystemPrompt: boolean;
  setIsEditingSystemPrompt: (editing: boolean) => void;
  systemPromptDraft: string;
  setSystemPromptDraft: (draft: string) => void;
  
  // 其他对话框
  showModelSelectDialog: boolean;
  setShowModelSelectDialog: (show: boolean) => void;
  showHelpTooltip: boolean;
  setShowHelpTooltip: (show: boolean) => void;
  showSessionTypeDialog: boolean;
  setShowSessionTypeDialog: (show: boolean) => void;
  showUpgradeToAgentDialog: boolean;
  setShowUpgradeToAgentDialog: (show: boolean) => void;
  
  // 人设面板
  showPersonaPanel: boolean;
  setShowPersonaPanel: (show: boolean) => void;
  personaSearch: string;
  setPersonaSearch: (search: string) => void;
  showRoleGenerator: boolean;
  setShowRoleGenerator: (show: boolean) => void;
  personaAgents: Session[];
  setPersonaAgents: (agents: Session[]) => void;
  personaTopics: Session[];
  setPersonaTopics: (topics: Session[]) => void;
  isLoadingPersonaList: boolean;
  setIsLoadingPersonaList: (loading: boolean) => void;
  
  // 升级为智能体
  agentName: string;
  setAgentName: (name: string) => void;
  agentAvatar: string | null;
  setAgentAvatar: (avatar: string | null) => void;
  agentSystemPrompt: string;
  setAgentSystemPrompt: (prompt: string) => void;
  agentLLMConfigId: string | null;
  setAgentLLMConfigId: (id: string | null) => void;
  isUpgrading: boolean;
  setIsUpgrading: (upgrading: boolean) => void;
  
  // MCP 详情遮罩层
  showMCPDetailOverlay: boolean;
  setShowMCPDetailOverlay: (show: boolean) => void;
  selectedMCPDetail: any;
  setSelectedMCPDetail: (detail: any) => void;
}

export function useWorkflowConfig(): UseWorkflowConfigReturn {
  // 当前会话配置
  const [currentSessionAvatar, setCurrentSessionAvatar] = useState<string | null>(null);
  const [currentSystemPrompt, setCurrentSystemPrompt] = useState<string | null>(null);
  
  // 头像配置对话框
  const [showAvatarConfigDialog, setShowAvatarConfigDialog] = useState(false);
  const [avatarConfigDraft, setAvatarConfigDraft] = useState<string | null>(null);
  
  // 头部配置对话框
  const [showHeaderConfigDialog, setShowHeaderConfigDialog] = useState(false);
  const [headerConfigEditName, setHeaderConfigEditName] = useState('');
  const [headerConfigEditAvatar, setHeaderConfigEditAvatar] = useState<string | null>(null);
  const [headerConfigEditSystemPrompt, setHeaderConfigEditSystemPrompt] = useState('');
  const [headerConfigEditMediaOutputPath, setHeaderConfigEditMediaOutputPath] = useState('');
  const [headerConfigEditLlmConfigId, setHeaderConfigEditLlmConfigId] = useState<string | null>(null);
  const [headerConfigEditProfession, setHeaderConfigEditProfession] = useState<string | null>(null);
  const [headerConfigEditProfessionType, setHeaderConfigEditProfessionType] = useState<'career' | 'game'>('career');
  const [headerConfigCareerProfessions, setHeaderConfigCareerProfessions] = useState<string[]>(DEFAULT_CAREER_PROFESSIONS);
  const [headerConfigGameProfessions, setHeaderConfigGameProfessions] = useState<string[]>(DEFAULT_GAME_PROFESSIONS);
  const [isLoadingHeaderProfessions, setIsLoadingHeaderProfessions] = useState(false);
  const [showHeaderAddProfessionDialog, setShowHeaderAddProfessionDialog] = useState(false);
  const [headerNewProfessionValue, setHeaderNewProfessionValue] = useState('');
  const [headerConfigActiveTab, setHeaderConfigActiveTab] = useState<'basic' | 'skillpacks'>('basic');
  const [isSavingHeaderAsRole, setIsSavingHeaderAsRole] = useState(false);
  
  // Topic 配置对话框
  const [showTopicConfigDialog, setShowTopicConfigDialog] = useState(false);
  const [topicConfigEditName, setTopicConfigEditName] = useState('');
  const [topicConfigEditAvatar, setTopicConfigEditAvatar] = useState<string | null>(null);
  const [topicConfigEditDisplayType, setTopicConfigEditDisplayType] = useState<TopicDisplayType>('chat');
  const [topicParticipants, setTopicParticipants] = useState<Participant[]>([]);
  
  // Agent Persona 对话框
  const [showAgentPersonaDialog, setShowAgentPersonaDialog] = useState(false);
  const [agentPersonaDialogAgent, setAgentPersonaDialogAgent] = useState<Session | null>(null);
  
  // 系统提示词编辑
  const [isEditingSystemPrompt, setIsEditingSystemPrompt] = useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = useState('');
  
  // 其他对话框
  const [showModelSelectDialog, setShowModelSelectDialog] = useState(false);
  const [showHelpTooltip, setShowHelpTooltip] = useState(false);
  const [showSessionTypeDialog, setShowSessionTypeDialog] = useState(false);
  const [showUpgradeToAgentDialog, setShowUpgradeToAgentDialog] = useState(false);
  
  // 人设面板
  const [showPersonaPanel, setShowPersonaPanel] = useState(false);
  const [personaSearch, setPersonaSearch] = useState('');
  const [showRoleGenerator, setShowRoleGenerator] = useState(false);
  const [personaAgents, setPersonaAgents] = useState<Session[]>([]);
  const [personaTopics, setPersonaTopics] = useState<Session[]>([]);
  const [isLoadingPersonaList, setIsLoadingPersonaList] = useState(false);
  
  // 升级为智能体
  const [agentName, setAgentName] = useState('');
  const [agentAvatar, setAgentAvatar] = useState<string | null>(null);
  const [agentSystemPrompt, setAgentSystemPrompt] = useState('');
  const [agentLLMConfigId, setAgentLLMConfigId] = useState<string | null>(null);
  const [isUpgrading, setIsUpgrading] = useState(false);
  
  // MCP 详情遮罩层
  const [showMCPDetailOverlay, setShowMCPDetailOverlay] = useState(false);
  const [selectedMCPDetail, setSelectedMCPDetail] = useState<any>(null);
  
  return {
    currentSessionAvatar,
    setCurrentSessionAvatar,
    currentSystemPrompt,
    setCurrentSystemPrompt,
    showAvatarConfigDialog,
    setShowAvatarConfigDialog,
    avatarConfigDraft,
    setAvatarConfigDraft,
    showHeaderConfigDialog,
    setShowHeaderConfigDialog,
    headerConfigEditName,
    setHeaderConfigEditName,
    headerConfigEditAvatar,
    setHeaderConfigEditAvatar,
    headerConfigEditSystemPrompt,
    setHeaderConfigEditSystemPrompt,
    headerConfigEditMediaOutputPath,
    setHeaderConfigEditMediaOutputPath,
    headerConfigEditLlmConfigId,
    setHeaderConfigEditLlmConfigId,
    headerConfigEditProfession,
    setHeaderConfigEditProfession,
    headerConfigEditProfessionType,
    setHeaderConfigEditProfessionType,
    headerConfigCareerProfessions,
    setHeaderConfigCareerProfessions,
    headerConfigGameProfessions,
    setHeaderConfigGameProfessions,
    isLoadingHeaderProfessions,
    setIsLoadingHeaderProfessions,
    showHeaderAddProfessionDialog,
    setShowHeaderAddProfessionDialog,
    headerNewProfessionValue,
    setHeaderNewProfessionValue,
    headerConfigActiveTab,
    setHeaderConfigActiveTab,
    isSavingHeaderAsRole,
    setIsSavingHeaderAsRole,
    showTopicConfigDialog,
    setShowTopicConfigDialog,
    topicConfigEditName,
    setTopicConfigEditName,
    topicConfigEditAvatar,
    setTopicConfigEditAvatar,
    topicConfigEditDisplayType,
    setTopicConfigEditDisplayType,
    topicParticipants,
    setTopicParticipants,
    showAgentPersonaDialog,
    setShowAgentPersonaDialog,
    agentPersonaDialogAgent,
    setAgentPersonaDialogAgent,
    isEditingSystemPrompt,
    setIsEditingSystemPrompt,
    systemPromptDraft,
    setSystemPromptDraft,
    showModelSelectDialog,
    setShowModelSelectDialog,
    showHelpTooltip,
    setShowHelpTooltip,
    showSessionTypeDialog,
    setShowSessionTypeDialog,
    showUpgradeToAgentDialog,
    setShowUpgradeToAgentDialog,
    showPersonaPanel,
    setShowPersonaPanel,
    personaSearch,
    setPersonaSearch,
    showRoleGenerator,
    setShowRoleGenerator,
    personaAgents,
    setPersonaAgents,
    personaTopics,
    setPersonaTopics,
    isLoadingPersonaList,
    setIsLoadingPersonaList,
    agentName,
    setAgentName,
    agentAvatar,
    setAgentAvatar,
    agentSystemPrompt,
    setAgentSystemPrompt,
    agentLLMConfigId,
    setAgentLLMConfigId,
    isUpgrading,
    setIsUpgrading,
    showMCPDetailOverlay,
    setShowMCPDetailOverlay,
    selectedMCPDetail,
    setSelectedMCPDetail,
  };
}
