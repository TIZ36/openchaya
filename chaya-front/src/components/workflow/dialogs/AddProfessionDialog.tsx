import React from 'react';
import { X } from 'lucide-react';
import { toast } from '../../ui/use-toast';
import { getDimensionOptions, saveDimensionOption } from '../../../services/roleDimensionApi';
import { getDefaultCareerProfessions, getDefaultGameProfessions } from '../profession';

// 默认职业列表
export const DEFAULT_CAREER_PROFESSIONS = getDefaultCareerProfessions();
export const DEFAULT_GAME_PROFESSIONS = getDefaultGameProfessions();

export interface AddProfessionDialogProps {
  open: boolean;
  onClose: () => void;
  professionType: 'career' | 'game';
  setProfessionType: (type: 'career' | 'game') => void;
  newProfessionValue: string;
  setNewProfessionValue: (value: string) => void;
  setCareerProfessions: (professions: string[]) => void;
  setGameProfessions: (professions: string[]) => void;
  setEditProfession: (profession: string | null) => void;
}

export const AddProfessionDialog: React.FC<AddProfessionDialogProps> = ({
  open,
  onClose,
  professionType,
  setProfessionType,
  newProfessionValue,
  setNewProfessionValue,
  setCareerProfessions,
  setGameProfessions,
  setEditProfession,
}) => {
  if (!open) return null;

  const handleAddProfession = async () => {
    if (!newProfessionValue.trim()) {
      toast({ title: '请输入职业名称', variant: 'destructive' });
      return;
    }
    try {
      const result = await saveDimensionOption('profession', professionType, newProfessionValue.trim());
      if (result.success) {
        toast({ title: '职业已添加', variant: 'success' });
        // 重新加载职业列表
        const options = await getDimensionOptions('profession', professionType);
        if (professionType === 'career') {
          setCareerProfessions([...DEFAULT_CAREER_PROFESSIONS, ...options]);
        } else {
          setGameProfessions([...DEFAULT_GAME_PROFESSIONS, ...options]);
        }
        // 自动选择新添加的职业
        setEditProfession(newProfessionValue.trim());
        onClose();
        setNewProfessionValue('');
      } else {
        toast({ title: '添加失败', description: result.error, variant: 'destructive' });
      }
    } catch (error) {
      console.error('[AddProfessionDialog] Failed to save custom profession:', error);
      toast({ title: '添加失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10001]" 
      onClick={onClose}
    >
      <div 
        className="bg-white dark:bg-[#2d2d2d] rounded-lg shadow-xl p-6 max-w-md w-full mx-4" 
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-[#ffffff]">
            添加自定义职业
          </h3>
          <button
            onClick={onClose}
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
                onClick={() => setProfessionType('career')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                  professionType === 'career'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                    : 'bg-gray-100 dark:bg-[#363636] text-gray-600 dark:text-[#b0b0b0] hover:bg-gray-200 dark:hover:bg-[#404040]'
                }`}
              >
                功能职业
              </button>
              <button
                onClick={() => setProfessionType('game')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                  professionType === 'game'
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
                  handleAddProfession();
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
              onClose();
              setNewProfessionValue('');
            }}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#ffffff] bg-gray-100 dark:bg-[#363636] hover:bg-gray-200 dark:hover:bg-[#4a4a4a] rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleAddProfession}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
};
