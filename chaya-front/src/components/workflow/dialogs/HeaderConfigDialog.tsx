import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Bot, Plus, Loader } from 'lucide-react';
import { Button } from '../../ui/Button';
import type { Session } from '../../../services/chat';
import type { LLMConfigFromDB } from '../../../services/llmApi';
import { applyProfessionToNameOrPrompt } from '../profession';


export interface HeaderConfigDialogProps {
  open: boolean;
  onClose: () => void;
  // 编辑状态
  activeTab: 'basic' | 'skillpacks';
  setActiveTab: (tab: 'basic' | 'skillpacks') => void;
  editName: string;
  setEditName: (name: string) => void;
  editAvatar: string | null;
  setEditAvatar: (avatar: string | null) => void;
  editSystemPrompt: string;
  setEditSystemPrompt: (prompt: string) => void;
  editMediaOutputPath: string;
  setEditMediaOutputPath: (path: string) => void;
  editLlmConfigId: string | null;
  setEditLlmConfigId: (id: string | null) => void;
  editProfession: string | null;
  setEditProfession: (profession: string | null) => void;
  editProfessionType: 'career' | 'game';
  setEditProfessionType: (type: 'career' | 'game') => void;
  careerProfessions: string[];
  gameProfessions: string[];
  isLoadingProfessions: boolean;
  // 会话信息
  sessions: Session[];
  currentSessionId: string | null;
  llmConfigs: LLMConfigFromDB[];
  // 保存状态
  isSavingAsRole: boolean;
  // 回调
  onShowAddProfessionDialog: () => void;
  onSaveAsRole: () => Promise<void>;
  onSave: () => Promise<void>;
}

export const HeaderConfigDialog: React.FC<HeaderConfigDialogProps> = ({
  open,
  onClose,
  activeTab,
  setActiveTab,
  editName,
  setEditName,
  editAvatar,
  setEditAvatar,
  editSystemPrompt,
  setEditSystemPrompt,
  editMediaOutputPath,
  setEditMediaOutputPath,
  editLlmConfigId,
  setEditLlmConfigId,
  editProfession,
  setEditProfession,
  editProfessionType,
  setEditProfessionType,
  careerProfessions,
  gameProfessions,
  isLoadingProfessions,
  sessions,
  currentSessionId,
  llmConfigs,
  isSavingAsRole,
  onShowAddProfessionDialog,
  onSaveAsRole,
  onSave,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const currentSession = sessions.find(s => s.session_id === currentSessionId);
  const isAgent = currentSession?.session_type === 'agent';
  const currentProfessionList = editProfessionType === 'career' ? careerProfessions : gameProfessions;

  const handleProfessionChange = (selectedProfession: string | null) => {
    setEditProfession(selectedProfession);
    const { name, systemPrompt } = applyProfessionToNameOrPrompt(
      selectedProfession,
      editName,
      editSystemPrompt,
      currentProfessionList
    );
    setEditName(name);
    setEditSystemPrompt(systemPrompt);
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
            会话配置
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
        </div>
        
        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
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
                名称
              </label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                placeholder="输入名称..."
              />
            </div>
          </div>
          
          {/* 职业选择（仅对 agent 显示） */}
          {isAgent && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff]">
                  职业
                </label>
                <button
                  onClick={onShowAddProfessionDialog}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-primary-600 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded transition-colors"
                  title="添加自定义职业"
                >
                  <Plus className="w-3 h-3" />
                  <span>添加</span>
                </button>
              </div>
              
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => {
                    setEditProfessionType('career');
                    setEditProfession(null);
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
                    setEditProfession(null);
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
              
              <select
                value={editProfession || ''}
                onChange={(e) => handleProfessionChange(e.target.value || null)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                disabled={isLoadingProfessions}
              >
                <option value="">无（自定义）</option>
                {currentProfessionList.map(profession => (
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
          
          {/* 默认模型选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
              默认模型
            </label>
            <select
              value={editLlmConfigId || ''}
              onChange={(e) => setEditLlmConfigId(e.target.value || null)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
            >
              <option value="">使用当前选择的模型</option>
              {llmConfigs.filter(c => c.enabled).map(config => (
                <option key={config.config_id} value={config.config_id}>
                  {config.name} ({config.model})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
              设置后，每次打开此会话时将自动切换到指定的模型
            </p>
          </div>
          
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
          
          {/* 多媒体保存路径 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
              多媒体保存路径
            </label>
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={editMediaOutputPath}
                onChange={(e) => setEditMediaOutputPath(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-600"
                placeholder="输入保存路径..."
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
              设置后，生成的图片、视频等多媒体内容将保存到此目录
            </p>
          </div>
        </div>
        
        {/* 底部按钮 */}
        <div className="px-5 py-4 bg-gray-50 dark:bg-[#1a1a1a] flex items-center justify-end space-x-3 flex-shrink-0">
          {currentSessionId && currentSession && !isAgent && (
            <button
              onClick={onSaveAsRole}
              disabled={isSavingAsRole}
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
