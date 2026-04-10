import React from 'react';
import { Loader } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export type HistoryLoadTopHintMode = 'click' | 'hybrid';

export type HistoryLoadTopProps = {
  visible: boolean;
  hasMore: boolean;
  isLoading?: boolean;
  onLoadMore: () => void;
  hintMode?: HistoryLoadTopHintMode;
  className?: string;
};

export const HistoryLoadTop: React.FC<HistoryLoadTopProps> = ({
  visible,
  hasMore,
  isLoading = false,
  onLoadMore,
  hintMode = 'hybrid',
  className,
}) => {
  const active = visible && hasMore;

  const label = isLoading
    ? '加载中...'
    : hintMode === 'click'
      ? '↑ 加载更多历史'
      : '↑ 加载更多历史（上拉或点击）';

  return (
    <div className={`sticky top-0 z-20 h-0 ${className || ''}`}>
      {/* overlay：不占布局，避免出现/消失推挤消息导致跳动 */}
      <div
        className={`absolute inset-x-0 top-0 transition-all duration-200 ease-out ${
          active ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1 pointer-events-none'
        }`}
        aria-hidden={!active}
      >
        {/* 迷雾渐变效果 */}
        <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-white via-white/80 to-transparent dark:from-[#2d2d2d] dark:via-[#2d2d2d]/80 dark:to-transparent pointer-events-none" />
        <div className="relative flex justify-center pt-2 pb-4 pointer-events-none">
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoading}
            className="pointer-events-auto bg-white/95 dark:bg-[#2d2d2d]/95 backdrop-blur-sm shadow-sm border border-gray-200 dark:border-[#404040]"
          >
            {isLoading ? <Loader className="w-3.5 h-3.5 mr-2 animate-spin" /> : null}
            {label}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default HistoryLoadTop;


