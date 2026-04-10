/**
 * SimpleLogViewer - 简洁执行日志组件
 * 朴素的小灰字风格，放在AI头像下方
 * 正式输出时默认折叠，有小三角可以展开
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ExecutionLogEntry } from './ExecutionLogViewer';

export interface SimpleLogViewerProps {
  logs: ExecutionLogEntry[];
  /** 是否正在执行中 */
  isActive?: boolean;
  /** 默认是否折叠（正式输出时为 true） */
  defaultCollapsed?: boolean;
  /** 最大高度 */
  maxHeight?: number;
  className?: string;
}

export const SimpleLogViewer: React.FC<SimpleLogViewerProps> = ({
  logs,
  isActive = false,
  defaultCollapsed = false,
  maxHeight = 200,
  className = '',
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 当正在执行时自动展开
  useEffect(() => {
    if (isActive) {
      setIsCollapsed(false);
    }
  }, [isActive]);

  // 当不再执行时自动折叠
  useEffect(() => {
    if (!isActive && logs.length > 0) {
      setIsCollapsed(true);
    }
  }, [isActive]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current && !isCollapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isCollapsed]);

  // 没有日志时不显示
  if (!logs.length && !isActive) {
    return null;
  }

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };

  // 格式化持续时间
  const formatDuration = (ms?: number) => {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // 过滤掉无意义的日志
  const meaningfulLogs = logs.filter(log => {
    const msg = log.message?.trim() || '';
    if (!msg) return false;
    // 如果是 thinking 类型且有 detail（思考内容），不过滤
    if (log.type === 'thinking' && log.detail) return true;
    // 过滤掉其他无意义的占位消息
    if (msg === '思考中...' || msg === '执行中...' || msg === '处理中...') return false;
    return true;
  });

  if (meaningfulLogs.length === 0 && !isActive) {
    return null;
  }

  const lastLog = meaningfulLogs[meaningfulLogs.length - 1];

  return (
    <div className={`simple-log-viewer ${className}`}>
      {/* 折叠/展开按钮 */}
      <div
        className="flex items-center gap-1 cursor-pointer text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400 transition-colors select-none"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        {isCollapsed ? (
          <ChevronRight className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
        <span className="text-[10px]">
          {isCollapsed 
            ? (isActive ? '执行中...' : `${meaningfulLogs.length} 条日志`) 
            : '执行日志'
          }
        </span>
        {isActive && !isCollapsed && (
          <span className="inline-block w-1 h-2 bg-gray-400/60 animate-pulse ml-1" />
        )}
      </div>

      {/* 展开时的日志列表 */}
      {!isCollapsed && (
        <div
          ref={scrollRef}
          className="mt-1 overflow-y-auto no-scrollbar"
          style={{ maxHeight: `${maxHeight}px` }}
        >
          {meaningfulLogs.map((log, index) => (
            <div
              key={`${log.id || 'log'}-${index}-${log.timestamp}`}
              className="flex items-start gap-1.5 text-[10px] text-gray-400 dark:text-gray-500 leading-relaxed py-0.5"
            >
              {/* 时间戳 */}
              <span className="text-gray-300 dark:text-gray-600 font-mono shrink-0">
                {formatTime(log.timestamp)}
              </span>
              {/* 日志内容 */}
              {log.type === 'thinking' && log.detail ? (
                // 思考内容：显示完整的思考过程，保持换行但行间距较小
                <div className="flex-1 min-w-0">
                  <span className="text-blue-400 dark:text-blue-500 font-medium">思考：</span>
                  <pre 
                    className="ml-1 whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400 font-sans leading-tight"
                    style={{ margin: 0 }}
                  >
                    {typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail, null, 2)}
                  </pre>
                </div>
              ) : (
                // 普通日志
                <span className="truncate" title={log.message}>
                  {log.message}
                  {log.duration != null && (
                    <span className="ml-1 text-gray-300 dark:text-gray-600">
                      ({formatDuration(log.duration)})
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SimpleLogViewer;
