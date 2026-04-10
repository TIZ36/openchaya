/**
 * 会话类型选择对话框
 * 用于选择创建临时会话
 */

import React from 'react';
import { X, MessageCircle } from 'lucide-react';

export interface SessionTypeDialogProps {
  open: boolean;
  onClose: () => void;
  onSelectTemporary: () => void;
}

export const SessionTypeDialog: React.FC<SessionTypeDialogProps> = ({
  open,
  onClose,
  onSelectTemporary,
}) => {
  if (!open) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">选择会话类型</h3>
          <button 
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {/* 临时会话选项 */}
          <button
            onClick={onSelectTemporary}
            className="w-full text-left p-4 border-2 border-gray-200 dark:border-[#404040] rounded-lg hover:border-amber-400 dark:hover:border-amber-600 transition-colors"
          >
            <div className="flex items-start space-x-3">
              <MessageCircle className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-gray-900 dark:text-white mb-1">临时会话</h4>
                <p className="text-sm text-gray-600 dark:text-[#b0b0b0]">
                  不保存历史记录，不发送历史消息，不进行总结。适合快速询问各种无关联的问题。
                </p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
