/**
 * 升级为智能体对话框
 */

import React, { useRef } from 'react';
import { X, Sparkles, Bot } from 'lucide-react';
import { Button } from '../../ui/Button';
import { IconButton } from '../../ui/IconButton';
import { InputField, TextareaField, FormFieldGroup } from '../../ui/FormField';
import type { LLMConfigFromDB } from '../../../services/llmApi';

export interface UpgradeToAgentDialogProps {
  open: boolean;
  onClose: () => void;
  agentName: string;
  setAgentName: (name: string) => void;
  agentAvatar: string | null;
  setAgentAvatar: (avatar: string | null) => void;
  agentSystemPrompt: string;
  setAgentSystemPrompt: (prompt: string) => void;
  agentLLMConfigId: string | null;
  setAgentLLMConfigId: (id: string | null) => void;
  llmConfigs: LLMConfigFromDB[];
  isUpgrading: boolean;
  onUpgrade: () => Promise<void>;
}

export const UpgradeToAgentDialog: React.FC<UpgradeToAgentDialogProps> = ({
  open,
  onClose,
  agentName,
  setAgentName,
  agentAvatar,
  setAgentAvatar,
  agentSystemPrompt,
  setAgentSystemPrompt,
  agentLLMConfigId,
  setAgentLLMConfigId,
  llmConfigs,
  isUpgrading,
  onUpgrade,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      const base64String = event.target?.result as string;
      setAgentAvatar(base64String);
    };
    reader.readAsDataURL(file);
  };

  const handleUpgrade = async () => {
    if (!agentName.trim()) {
      alert('请输入智能体名称');
      return;
    }
    if (!agentAvatar) {
      alert('请上传智能体头像');
      return;
    }
    if (!agentSystemPrompt.trim()) {
      alert('请设置智能体人设');
      return;
    }
    if (!agentLLMConfigId) {
      alert('请选择关联的LLM模型');
      return;
    }
    await onUpgrade();
  };

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center space-x-2">
            <Sparkles className="w-5 h-5 text-primary-500" />
            <span>升级为智能体</span>
          </h3>
          <IconButton
            icon={X}
            onClick={onClose}
            variant="ghost"
            label="关闭"
          />
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600 dark:text-[#b0b0b0]">
            智能体必须设置头像、名字和人设。升级后，该会话将拥有固定的身份和角色。
          </p>

          <FormFieldGroup spacing="default">
            {/* 智能体名称 */}
            <InputField
              label="智能体名称"
              required
              inputProps={{
                id: "agent-name",
                type: "text",
                value: agentName,
                onChange: (e) => setAgentName(e.target.value),
                placeholder: "例如：AI助手、产品经理等",
              }}
            />

            {/* 智能体头像 */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-1">
                智能体头像 <span className="text-red-500">*</span>
              </label>
              <div className="flex items-center space-x-3">
                <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-gray-200 dark:border-[#404040] flex items-center justify-center bg-gray-100 dark:bg-[#363636]">
                  {agentAvatar ? (
                    <img src={agentAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <Bot className="w-8 h-8 text-gray-400" />
                  )}
                </div>
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="secondary"
                  size="sm"
                >
                  选择头像
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarUpload}
                />
              </div>
            </div>

            {/* 智能体人设 */}
            <TextareaField
              label="智能体人设"
              required
              textareaProps={{
                id: "agent-system-prompt",
                value: agentSystemPrompt,
                onChange: (e) => setAgentSystemPrompt(e.target.value),
                placeholder: "例如：你是一个专业的产品经理，擅长分析用户需求和产品设计...",
                rows: 4,
              }}
            />
          </FormFieldGroup>

          {/* 关联LLM模型 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-1">
              关联LLM模型 <span className="text-red-500">*</span>
            </label>
            <select
              value={agentLLMConfigId || ''}
              onChange={(e) => setAgentLLMConfigId(e.target.value || null)}
              className="input-field"
            >
              <option value="">请选择模型</option>
              {llmConfigs
                .filter(config => config.enabled)
                .map(config => (
                  <option key={config.config_id} value={config.config_id}>
                    {config.name} ({config.provider})
                  </option>
                ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-[#b0b0b0]">
              智能体将固定使用此模型，升级后不可更改
            </p>
          </div>
        </div>
        <div className="px-5 py-4 bg-gray-50 dark:bg-[#363636] flex items-center justify-between">
          <Button
            onClick={onClose}
            variant="ghost"
            size="sm"
          >
            取消
          </Button>
          <Button
            onClick={handleUpgrade}
            disabled={isUpgrading || !agentName.trim() || !agentAvatar || !agentSystemPrompt.trim() || !agentLLMConfigId}
            variant="primary"
            size="sm"
          >
            {isUpgrading ? '升级中...' : '确认升级'}
          </Button>
        </div>
      </div>
    </div>
  );
};
