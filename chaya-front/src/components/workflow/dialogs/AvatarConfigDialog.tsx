/**
 * 头像配置对话框
 */

import React, { useRef } from 'react';
import { X, Bot } from 'lucide-react';
import { Button } from '../../ui/Button';

export interface AvatarConfigDialogProps {
  open: boolean;
  onClose: () => void;
  avatarDraft: string | null;
  setAvatarDraft: (avatar: string | null) => void;
  onSave: () => Promise<void>;
}

export const AvatarConfigDialog: React.FC<AvatarConfigDialogProps> = ({
  open,
  onClose,
  avatarDraft,
  setAvatarDraft,
  onSave,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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
      setAvatarDraft(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl max-w-sm w-full mx-4" 
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 dark:border-[#404040] flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            配置会话头像
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-[#cccccc]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {/* 头像预览和上传 */}
          <div className="flex flex-col items-center space-y-4">
            <div className="w-24 h-24 rounded-full overflow-hidden border-2 border-gray-200 dark:border-[#404040] flex items-center justify-center bg-gray-100 dark:bg-[#363636]">
              {avatarDraft ? (
                <img src={avatarDraft} alt="Avatar" className="w-full h-full object-cover" />
              ) : (
                <Bot className="w-12 h-12 text-gray-400" />
              )}
            </div>
            <div className="flex items-center space-x-3">
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="secondary"
                size="sm"
              >
                选择图片
              </Button>
              {avatarDraft && (
                <Button
                  onClick={() => setAvatarDraft(null)}
                  variant="ghost"
                  size="sm"
                  className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                >
                  清除头像
                </Button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-[#b0b0b0] text-center">
            支持 JPG、PNG 等格式，建议大小不超过 2MB
          </p>
        </div>
        <div className="px-5 py-4 bg-gray-50 dark:bg-[#363636] flex items-center justify-end space-x-3">
          <Button
            onClick={onClose}
            variant="ghost"
            size="sm"
          >
            取消
          </Button>
          <Button
            onClick={onSave}
            variant="primary"
            size="sm"
          >
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};
