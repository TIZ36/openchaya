/**
 * 技能包对话框组件
 * 包括技能包创建结果对话框和技能包使用确认对话框
 */

import React from 'react';
import { X, Package, Sparkles, Loader, Plug } from 'lucide-react';
import type { SkillPackCreationResult, SkillPackProcessInfo } from '../../../services/skillPackApi';
import type { MCPServerConfig } from '../../../services/mcpApi';

export interface SkillPackDialogProps {
  open: boolean;
  onClose: () => void;
  skillPackResult: SkillPackCreationResult | null;
  setSkillPackResult: (result: SkillPackCreationResult | null) => void;
  skillPackProcessInfo: SkillPackProcessInfo | null;
  optimizationPrompt: string;
  setOptimizationPrompt: (prompt: string) => void;
  selectedMCPForOptimization: string[];
  setSelectedMCPForOptimization: (ids: string[]) => void;
  mcpServers: MCPServerConfig[];
  isOptimizing: boolean;
  isSavingSkillPack: boolean;
  selectedLLMConfigId: string | null;
  onOptimize: () => Promise<void>;
  onSave: () => Promise<void>;
}

export const SkillPackDialog: React.FC<SkillPackDialogProps> = ({
  open,
  onClose,
  skillPackResult,
  setSkillPackResult,
  skillPackProcessInfo,
  optimizationPrompt,
  setOptimizationPrompt,
  selectedMCPForOptimization,
  setSelectedMCPForOptimization,
  mcpServers,
  isOptimizing,
  isSavingSkillPack,
  selectedLLMConfigId,
  onOptimize,
  onSave,
}) => {
  if (!open || !skillPackResult || !skillPackProcessInfo) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Package className="w-6 h-6 text-primary-500" />
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              技能包制作完成
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="px-6 py-4 flex-1 overflow-y-auto">
          {/* 制作过程信息 */}
          <div className="mb-6">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-[#ffffff] mb-3">
              制作过程
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-primary-50 dark:bg-primary-900/20 rounded-lg p-3">
                <div className="text-xs text-gray-600 dark:text-[#b0b0b0] mb-1">消息数量</div>
                <div className="text-lg font-semibold text-primary-600 dark:text-primary-400">
                  {skillPackProcessInfo.messages_count}
                </div>
              </div>
              <div className="bg-primary-50 dark:bg-primary-900/20 rounded-lg p-3">
                <div className="text-xs text-gray-600 dark:text-[#b0b0b0] mb-1">思考过程</div>
                <div className="text-lg font-semibold text-primary-600 dark:text-primary-400">
                  {skillPackProcessInfo.thinking_count}
                </div>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
                <div className="text-xs text-gray-600 dark:text-[#b0b0b0] mb-1">工具调用</div>
                <div className="text-lg font-semibold text-green-600 dark:text-green-400">
                  {skillPackProcessInfo.tool_calls_count}
                </div>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3">
                <div className="text-xs text-gray-600 dark:text-[#b0b0b0] mb-1">媒体资源</div>
                <div className="text-lg font-semibold text-amber-600 dark:text-amber-400">
                  {skillPackProcessInfo.media_count}
                </div>
                {skillPackProcessInfo.media_types.length > 0 && (
                  <div className="text-xs text-gray-500 dark:text-[#b0b0b0] mt-1">
                    {skillPackProcessInfo.media_types.join(', ')}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 text-xs text-gray-500 dark:text-[#b0b0b0]">
              对话记录长度: {skillPackProcessInfo.conversation_length.toLocaleString()} 字符 | 
              提示词长度: {skillPackProcessInfo.prompt_length.toLocaleString()} 字符
            </div>
          </div>

          {/* 技能包名称 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
              技能包名称
            </label>
            <input
              type="text"
              value={skillPackResult.name}
              onChange={(e) => setSkillPackResult({ ...skillPackResult, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          
          {/* 技能包总结 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
              技能包总结
            </label>
            <textarea
              value={skillPackResult.summary}
              onChange={(e) => setSkillPackResult({ ...skillPackResult, summary: e.target.value })}
              rows={12}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 font-mono text-sm"
            />
          </div>

          {/* 优化总结区域 */}
          <div className="mb-4 border-t border-gray-200 dark:border-[#404040] pt-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-[#ffffff] mb-2">
              优化总结（可选）
            </label>
            
            {/* MCP服务器选择 */}
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 dark:text-[#b0b0b0] mb-2">
                连接感知模组（可选）- 用于验证工具名称和参数
              </label>
              <div className="space-y-2 max-h-32 overflow-y-auto border border-gray-200 dark:border-[#404040] rounded-lg p-2">
                {mcpServers.filter(s => s.enabled).length === 0 ? (
                  <div className="text-xs text-gray-500 dark:text-[#b0b0b0] text-center py-2">
                    暂无启用的MCP服务器
                  </div>
                ) : (
                  mcpServers
                    .filter(s => s.enabled)
                    .map((server) => {
                      const sid = server.server_id ?? server.id;
                      return (
                        <label
                          key={sid}
                          className="flex items-center space-x-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 p-2 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={selectedMCPForOptimization.includes(sid)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedMCPForOptimization([...selectedMCPForOptimization, sid]);
                              } else {
                                setSelectedMCPForOptimization(selectedMCPForOptimization.filter(id => id !== sid));
                              }
                            }}
                            className="w-4 h-4 text-primary-500 border-gray-300 rounded focus:ring-primary-500"
                          />
                          <Plug className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-700 dark:text-[#ffffff]">{server.name}</span>
                        </label>
                      );
                    })
                )}
              </div>
              <div className="mt-1 text-xs text-gray-500 dark:text-[#b0b0b0]">
                选择MCP服务器后，优化时将连接这些服务器来验证工具名称和参数，生成更准确的技能包描述
              </div>
            </div>
            
            <textarea
              value={optimizationPrompt}
              onChange={(e) => setOptimizationPrompt(e.target.value)}
              placeholder="例如：更详细地描述工具调用的参数，或者强调某个关键步骤..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#404040] rounded-lg bg-white dark:bg-[#363636] text-gray-900 dark:text-[#ffffff] focus:outline-none focus:ring-2 focus:ring-primary-500 text-sm"
            />
            <button
              onClick={onOptimize}
              disabled={isOptimizing || !selectedLLMConfigId}
              className="mt-2 px-4 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex items-center space-x-2"
            >
              {isOptimizing ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" />
                  <span>优化中...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>优化总结</span>
                </>
              )}
            </button>
          </div>
        </div>
        
        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#404040] flex items-center justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#ffffff] bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={isSavingSkillPack || !skillPackResult.name.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
          >
            {isSavingSkillPack ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                <span>保存中...</span>
              </>
            ) : (
              <span>保存技能包</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export interface SkillPackUseConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  skillPackName: string;
  onConfirm: () => void;
}

export const SkillPackUseConfirmDialog: React.FC<SkillPackUseConfirmDialogProps> = ({
  open,
  onClose,
  skillPackName,
  onConfirm,
}) => {
  if (!open) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl max-w-md w-full mx-4" 
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040]">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            确认使用技能包
          </h3>
        </div>
        <div className="p-5">
          <p className="text-sm text-gray-600 dark:text-[#b0b0b0]">
            确认使用技能包「{skillPackName}」？技能包中的提示词将会追加到当前会话的 system prompt 中。
          </p>
        </div>
        <div className="px-5 py-4 bg-gray-50 dark:bg-[#363636] flex items-center justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#ffffff] bg-white dark:bg-[#2d2d2d] border border-gray-300 dark:border-[#404040] hover:bg-gray-50 dark:hover:bg-[#363636] rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
          >
            确认使用
          </button>
        </div>
      </div>
    </div>
  );
};
