/**
 * 供应商选择对话框（移动端优先）
 * - 使用项目内 Dialog，而不是原生下拉
 * - 仅展示已录入供应商，显示当前选中
 */
import React from 'react';
import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './Dialog';
import { Button } from './Button';
import { ScrollArea } from './ScrollArea';

export interface ProviderSelectItem {
  provider_id: string;
  name: string;
  provider_type: string;
  icon?: React.ReactNode;
}

export interface ProviderSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: ProviderSelectItem[];
  selectedProviderId?: string | null;
  onSelect: (providerId: string) => void;
  title?: string;
  description?: string;
  emptyMessage?: string;
}

export const ProviderSelectDialog: React.FC<ProviderSelectDialogProps> = ({
  open,
  onOpenChange,
  providers,
  selectedProviderId,
  onSelect,
  title = '切换供应商',
  description = '选择一个供应商以管理 Token / 模型配置',
  emptyMessage = '暂无可用供应商，请先添加一个自定义供应商',
}) => {
  const handleSelect = (providerId: string) => {
    onSelect(providerId);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0 overflow-hidden">
        <div className="flex flex-col h-full max-h-[80vh] min-h-0">
          <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0">
            <DialogTitle className="[data-skin='niho']:text-[#e8f5f0]">
              {title}
            </DialogTitle>
            <DialogDescription className="[data-skin='niho']:text-[var(--text-secondary)]">
              {description}
            </DialogDescription>
          </DialogHeader>

          {/* 列表 */}
          <div className="flex-1 min-h-0 flex flex-col px-6 pb-4">
            {providers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <p className="text-sm text-gray-500 dark:text-gray-400 [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                  {emptyMessage}
                </p>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-hidden">
                <ScrollArea className="h-full">
                  <div className="space-y-1 pr-4">
                    {providers.map((p) => {
                      const isSelected = p.provider_id === selectedProviderId;
                      return (
                        <button
                          key={p.provider_id}
                          type="button"
                          onClick={() => handleSelect(p.provider_id)}
                          className={`
                            w-full text-left px-3 py-2 rounded-lg border transition-colors
                            ${isSelected
                              ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 border-primary-200 dark:border-primary-800'
                              : 'hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 border-transparent'
                            }
                            [data-skin='niho']:bg-[rgba(0,0,0,0.35)]
                            [data-skin='niho']:border-[var(--niho-text-border)]
                            [data-skin='niho']:hover:border-[rgba(143,183,201,0.28)]
                            [data-skin='niho']:hover:bg-[rgba(143,183,201,0.06)]
                            ${isSelected ? "[data-skin='niho']:!bg-[rgba(42,15,63,0.55)] [data-skin='niho']:!border-[rgba(0,255,136,0.35)] [data-skin='niho']:shadow-[0_0_14px_rgba(0,255,136,0.10)]" : ''}
                          `}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-5 h-5 rounded flex items-center justify-center overflow-hidden flex-shrink-0">
                                {p.icon}
                              </div>
                              <div className="min-w-0">
                                <div className="text-sm font-medium truncate [data-skin='niho']:text-[#e8f5f0]">
                                  {p.name}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-400 truncate [data-skin='niho']:text-[var(--niho-skyblue-gray)]">
                                  {p.provider_type}
                                </div>
                              </div>
                            </div>
                            {isSelected && (
                              <Check className="w-4 h-4 text-primary-600 dark:text-primary-400 flex-shrink-0 [data-skin='niho']:text-[var(--color-accent)]" />
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

          {/* 底部 */}
          <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 flex-shrink-0 [data-skin='niho']:border-[var(--niho-text-border)] [data-skin='niho']:text-[var(--text-secondary)]">
            <span>
              共 {providers.length} 个供应商
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


