/**
 * TopicConfigDialog - 话题配置对话框
 * 用于配置话题的展示类型、名称、头像、参与者等
 */

import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Bot, MessageCircle, Lightbulb, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import type { Session } from '../../../services/chat';
import { getAgents } from '../../../services/chat';

export type TopicDisplayType = 'chat' | 'brainstorm';

export interface TopicConfigDialogProps {
  open: boolean;
  onClose: () => void;
  // 话题信息
  topicId: string;
  topicName: string;
  topicAvatar: string | null;
  topicDisplayType: TopicDisplayType;
  sessionType?: string; // session_type: 'topic_general' | 'agent' 等
  participants: Array<{
    participant_id: string;
    participant_type: 'user' | 'agent';
    name?: string;
    avatar?: string;
  }>;
  // 编辑状态
  editName: string;
  setEditName: (name: string) => void;
  editAvatar: string | null;
  setEditAvatar: (avatar: string | null) => void;
  editDisplayType: TopicDisplayType;
  setEditDisplayType: (type: TopicDisplayType) => void;
  // 回调
  onSave: () => Promise<void>;
  onUpdateSessionType?: (sessionType: 'topic_general' | 'agent') => Promise<void>;
  onAddParticipant?: (agentId: string) => Promise<void>;
  onRemoveParticipant?: (participantId: string) => Promise<void>;
}

const DISPLAY_TYPE_OPTIONS: Array<{ value: TopicDisplayType; label: string; icon: React.ReactNode; description: string }> = [
  { 
    value: 'chat', 
    label: '聊天', 
    icon: <MessageCircle className="w-5 h-5" />,
    description: '普通对话模式，适合日常交流'
  },
  { 
    value: 'brainstorm', 
    label: '头脑风暴', 
    icon: <Lightbulb className="w-5 h-5" />,
    description: '多人协作模式，适合创意讨论'
  },
];

export const TopicConfigDialog: React.FC<TopicConfigDialogProps> = ({
  open,
  onClose,
  topicId,
  topicName,
  topicAvatar,
  topicDisplayType,
  sessionType,
  participants,
  editName,
  setEditName,
  editAvatar,
  setEditAvatar,
  editDisplayType,
  setEditDisplayType,
  onSave,
  onUpdateSessionType,
  onAddParticipant,
  onRemoveParticipant,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<'basic' | 'participants'>('basic');
  const [availableAgents, setAvailableAgents] = useState<Session[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [isAddingParticipant, setIsAddingParticipant] = useState(false);

  // 加载可用的 Agent 列表
  useEffect(() => {
    if (open && activeTab === 'participants') {
      (async () => {
        try {
          setIsLoadingAgents(true);
          const agents = await getAgents();
          setAvailableAgents(agents);
        } catch (error) {
          console.error('[TopicConfigDialog] Failed to load agents:', error);
        } finally {
          setIsLoadingAgents(false);
        }
      })();
    }
  }, [open, activeTab]);

  if (!open) return null;

  // 过滤掉已经是参与者的 Agent
  const participantIds = new Set(participants.map(p => p.participant_id));
  const filteredAgents = availableAgents
    .filter(agent => !participantIds.has(agent.session_id))
    .filter(agent => {
      if (!agentSearchQuery.trim()) return true;
      const query = agentSearchQuery.toLowerCase();
      return (
        (agent.name || '').toLowerCase().includes(query) ||
        (agent.title || '').toLowerCase().includes(query)
      );
    });

  const handleAddParticipant = async (agentId: string) => {
    if (!onAddParticipant) return;
    try {
      setIsAddingParticipant(true);
      await onAddParticipant(agentId);
    } catch (error) {
      console.error('[TopicConfigDialog] Failed to add participant:', error);
    } finally {
      setIsAddingParticipant(false);
    }
  };

  const handleRemoveParticipant = async (participantId: string) => {
    if (!onRemoveParticipant) return;
    try {
      await onRemoveParticipant(participantId);
    } catch (error) {
      console.error('[TopicConfigDialog] Failed to remove participant:', error);
    }
  };

  return createPortal(
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[9999]" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col" 
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-[#ffffff]">
            话题配置
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Tab 切换 */}
        <div className="px-5 py-2 border-b border-gray-200 dark:border-[#404040] flex space-x-4 flex-shrink-0">
          <button
            onClick={() => setActiveTab('basic')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              activeTab === 'basic'
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-100 dark:hover:bg-[#363636]'
            }`}
          >
            基本信息
          </button>
          <button
            onClick={() => setActiveTab('participants')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5 ${
              activeTab === 'participants'
                ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-100 dark:hover:bg-[#363636]'
            }`}
          >
            <Users className="w-4 h-4" />
            参与者
            {participants.filter(p => p.participant_type === 'agent').length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-primary-200 dark:bg-primary-800 rounded-full">
                {participants.filter(p => p.participant_type === 'agent').length}
              </span>
            )}
          </button>
        </div>
        
        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {activeTab === 'basic' ? (
            <>
              {/* 头像和名称 */}
              <div className="flex items-start space-x-4">
                <div className="flex flex-col items-center space-y-2">
                  <div 
                    className="w-16 h-16 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center cursor-pointer hover:ring-2 hover:ring-primary-400 hover:ring-offset-2 transition-all overflow-hidden"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {editAvatar ? (
                      <img src={editAvatar} alt="Avatar" className="w-full h-full object-cover" />
                    ) : (
                      <Bot className="w-8 h-8 text-primary-600 dark:text-primary-400" />
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                          setEditAvatar(e.target?.result as string);
                        };
                        reader.readAsDataURL(file);
                      }
                    }}
                  />
                  <span className="text-xs text-gray-500 dark:text-[#b0b0b0]">点击更换</span>
                </div>
                
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-1">
                    话题名称
                  </label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                    placeholder="输入话题名称..."
                  />
                </div>
              </div>
              
              {/* 展示类型选择 */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-3">
                  展示类型
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {DISPLAY_TYPE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setEditDisplayType(option.value)}
                      className={`flex flex-col items-center p-4 rounded-lg border-2 transition-all ${
                        editDisplayType === option.value
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                          : 'border-gray-200 dark:border-[#404040] hover:border-gray-300 dark:hover:border-[#505050]'
                      }`}
                    >
                      <div className={`mb-2 ${
                        editDisplayType === option.value
                          ? 'text-primary-600 dark:text-primary-400'
                          : 'text-gray-500 dark:text-[#808080]'
                      }`}>
                        {option.icon}
                      </div>
                      <span className={`text-sm font-medium ${
                        editDisplayType === option.value
                          ? 'text-primary-700 dark:text-primary-300'
                          : 'text-gray-700 dark:text-[#b0b0b0]'
                      }`}>
                        {option.label}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-[#808080] mt-1 text-center">
                        {option.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              
              {/* 积极模式开关（仅对 topic_general 或 agent 类型的话题显示） */}
              {(sessionType === 'topic_general' || sessionType === 'agent') && onUpdateSessionType && (
                <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-[#363636] rounded-lg border border-gray-200 dark:border-[#404040]">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900 dark:text-[#ffffff] mb-1">
                      积极模式
                    </div>
                    <div className="text-xs text-gray-500 dark:text-[#808080]">
                      {sessionType === 'agent' 
                        ? '开启：Agent 会像普通对话一样直接回答所有问题'
                        : '关闭：Agent 会智能判断是否需要回答（收敛模式）'}
                    </div>
                  </div>
                  <Switch
                    checked={sessionType === 'agent'}
                    onCheckedChange={async (checked) => {
                      if (onUpdateSessionType) {
                        try {
                          await onUpdateSessionType(checked ? 'agent' : 'topic_general');
                        } catch (error) {
                          console.error('[TopicConfigDialog] Failed to update session type:', error);
                          alert('更新失败，请重试');
                        }
                      }
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {/* 参与者管理 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff]">
                    当前参与者
                  </label>
                </div>
                
                {/* 当前参与者列表 */}
                <div className="space-y-2 mb-4">
                  {participants.filter(p => p.participant_type === 'agent').length === 0 ? (
                    <div className="text-sm text-gray-500 dark:text-[#808080] text-center py-4 border border-dashed border-gray-300 dark:border-[#404040] rounded-lg">
                      暂无 Agent 参与者，请从下方添加
                    </div>
                  ) : (
                    participants
                      .filter(p => p.participant_type === 'agent')
                      .map((participant) => (
                        <div
                          key={participant.participant_id}
                          className="flex items-center justify-between p-3 bg-gray-50 dark:bg-[#363636] rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center overflow-hidden">
                              {participant.avatar ? (
                                <img src={participant.avatar} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                              )}
                            </div>
                            <span className="text-sm font-medium text-gray-900 dark:text-[#ffffff]">
                              {participant.name || participant.participant_id}
                            </span>
                          </div>
                          {onRemoveParticipant && (
                            <button
                              onClick={() => handleRemoveParticipant(participant.participant_id)}
                              className="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                              title="移除参与者"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))
                  )}
                </div>
                
                {/* 添加参与者 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
                    添加 Agent
                  </label>
                  <div className="relative mb-3">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      value={agentSearchQuery}
                      onChange={(e) => setAgentSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600 text-sm"
                      placeholder="搜索 Agent..."
                    />
                  </div>
                  
                  <div className="max-h-48 overflow-y-auto space-y-1 border border-gray-200 dark:border-[#404040] rounded-lg p-2">
                    {isLoadingAgents ? (
                      <div className="text-sm text-gray-500 dark:text-[#808080] text-center py-4">
                        加载中...
                      </div>
                    ) : filteredAgents.length === 0 ? (
                      <div className="text-sm text-gray-500 dark:text-[#808080] text-center py-4">
                        {agentSearchQuery ? '没有找到匹配的 Agent' : '没有可添加的 Agent'}
                      </div>
                    ) : (
                      filteredAgents.map((agent) => (
                        <button
                          key={agent.session_id}
                          onClick={() => handleAddParticipant(agent.session_id)}
                          disabled={isAddingParticipant}
                          className="w-full flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-[#404040] rounded-lg transition-colors disabled:opacity-50"
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center overflow-hidden">
                              {agent.avatar ? (
                                <img src={agent.avatar} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <Bot className="w-4 h-4 text-primary-600 dark:text-primary-400" />
                              )}
                            </div>
                            <div className="text-left">
                              <div className="text-sm font-medium text-gray-900 dark:text-[#ffffff]">
                                {agent.name || agent.title || agent.session_id}
                              </div>
                              {agent.system_prompt && (
                                <div className="text-xs text-gray-500 dark:text-[#808080] truncate max-w-[200px]">
                                  {agent.system_prompt.slice(0, 50)}...
                                </div>
                              )}
                            </div>
                          </div>
                          <Plus className="w-4 h-4 text-primary-500" />
                        </button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        
        {/* 底部按钮 */}
        <div className="px-5 py-4 bg-gray-50 dark:bg-[#1a1a1a] flex items-center justify-end space-x-3 flex-shrink-0">
          <Button onClick={onClose} variant="ghost" size="sm">
            取消
          </Button>
          <Button onClick={onSave} variant="primary" size="sm">
            保存
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};

