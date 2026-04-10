/**
 * 模型选择对话框组件
 * 支持模糊搜索，compact 样式显示
 */

import React, { useState, useMemo } from 'react';
import { Search, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './Dialog';
import { Input } from './Input';
import { Button } from './Button';
import { ScrollArea } from './ScrollArea';

export interface ModelSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: string[];
  selectedModel?: string;
  onSelect: (model: string) => void;
  title?: string;
  description?: string;
  loading?: boolean;
  emptyMessage?: string;
}

export const ModelSelectDialog: React.FC<ModelSelectDialogProps> = ({
  open,
  onOpenChange,
  models,
  selectedModel,
  onSelect,
  title = '选择模型',
  description = '从列表中选择一个模型',
  loading = false,
  emptyMessage = '暂无可用模型',
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // 去重并过滤模型
  const filteredModels = useMemo(() => {
    // 去重：使用 Set 去除重复项
    const uniqueModels = Array.from(new Set(models));
    
    if (!searchQuery.trim()) {
      return uniqueModels;
    }

    // 模糊搜索：不区分大小写
    const query = searchQuery.toLowerCase().trim();
    return uniqueModels.filter((model) =>
      model.toLowerCase().includes(query)
    );
  }, [models, searchQuery]);

  const handleSelect = (model: string) => {
    onSelect(model);
    onOpenChange(false);
    setSearchQuery(''); // 关闭时清空搜索
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0 overflow-hidden">
        <div className="flex flex-col h-full max-h-[80vh] min-h-0">
          <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {/* 搜索框 */}
          <div className="relative mb-3 px-6 flex-shrink-0">
            <Search className="absolute left-9 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              type="text"
              placeholder="搜索模型名称..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          {/* 模型列表 - 使用固定高度确保滚动正常工作 */}
          <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-gray-300 dark:border-gray-600 border-t-primary-600 rounded-full animate-spin" />
                <span className="ml-3 text-sm text-gray-500">正在加载模型列表...</span>
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {searchQuery ? '未找到匹配的模型' : emptyMessage}
                </p>
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSearchQuery('')}
                    className="mt-2"
                  >
                    清空搜索
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="space-y-0 pr-4">
                    {filteredModels.map((model) => {
                      const isSelected = model === selectedModel;
                      return (
                        <button
                          key={model}
                          type="button"
                          onClick={() => handleSelect(model)}
                          className={`
                            w-full text-left px-2.5 py-1.5 rounded text-xs
                            transition-colors
                            ${
                              isSelected
                                ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 font-medium'
                                : 'hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                            }
                          `}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-xs">{model}</span>
                            {isSelected && (
                              <Check className="w-3.5 h-3.5 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>

          {/* 底部信息 */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 flex-shrink-0">
            <span>
              {searchQuery
                ? `找到 ${filteredModels.length} 个匹配的模型（共 ${models.length} 个）`
                : `共 ${models.length} 个模型`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-7 text-xs"
            >
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
