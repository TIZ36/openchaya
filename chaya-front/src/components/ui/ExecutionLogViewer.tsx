/**
 * ExecutionLogViewer - 执行日志滚动区域
 * 紧跟 agent 头像，在输出气泡上方，无边框，纯文本，适配主题
 */

import React, { useEffect, useRef, useState } from 'react';

export interface ExecutionLogEntry {
  id: string;
  timestamp: number;
  type: 'info' | 'step' | 'tool' | 'llm' | 'success' | 'error' | 'thinking';
  message: string;
  detail?: string;
  duration?: number;
  /** Agent ID (用于多 Agent 场景) */
  agent_id?: string;
  /** Agent 名称 (用于多 Agent 场景) */
  agent_name?: string;
}

export interface ExecutionLogViewerProps {
  logs: ExecutionLogEntry[];
  isActive?: boolean;
  maxHeight?: number;
  collapsed?: boolean;
  className?: string;
}

const formatDuration = (ms?: number) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

export const ExecutionLogViewer: React.FC<ExecutionLogViewerProps> = ({
  logs,
  isActive = false,
  maxHeight = 100,
  collapsed: defaultCollapsed = false,
  className = '',
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    if (bottomRef.current && !isCollapsed) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [logs, isCollapsed]);

  // 当有新日志时自动展开
  useEffect(() => {
    if (logs.length > 0 && isActive) {
      setIsCollapsed(false);
    }
  }, [logs.length, isActive]);

  // 当 defaultCollapsed 变化时更新状态
  useEffect(() => {
    setIsCollapsed(defaultCollapsed);
  }, [defaultCollapsed]);

  // 如果没有日志且不在执行中，返回 null
  // 但如果日志存在（即使不在执行中），也要显示（折叠状态）
  if (!logs.length && !isActive) {
    return null;
  }

  const lastLog = logs[logs.length - 1];
  
  // 如果没有最后一条日志但正在执行，显示默认提示
  if (!lastLog && isActive) {
    return (
      <div className={`execution-log-viewer text-[11px] leading-relaxed ${className}`}>
        <div className="text-muted-foreground/65 dark:text-muted-foreground/65 italic">
          思考中...
        </div>
      </div>
    );
  }

  // 根据日志类型获取样式类
  const getLogStyle = (type: ExecutionLogEntry['type']) => {
    switch (type) {
      case 'error':
        return 'text-red-500/70 dark:text-red-400/70';
      case 'success':
        return 'text-green-600/70 dark:text-green-400/70';
      case 'thinking':
        return 'text-purple-600/70 dark:text-purple-400/70';
      case 'tool':
        return 'text-blue-600/70 dark:text-blue-400/70';
      case 'llm':
        return 'text-indigo-600/70 dark:text-indigo-400/70';
      case 'step':
        return 'text-amber-600/70 dark:text-amber-400/70';
      default:
        return 'text-muted-foreground/65 dark:text-muted-foreground/65';
    }
  };

  return (
    <div className={`execution-log-viewer text-[11px] leading-relaxed ${className}`}>
      {/* 折叠时只显示最后一条 */}
      {isCollapsed ? (
        <div 
          className={`cursor-pointer ${getLogStyle(lastLog?.type || 'info')} hover:opacity-100 transition-opacity truncate`}
          onClick={() => setIsCollapsed(false)}
        >
          {lastLog?.message || (isActive ? '执行中...' : '已完成')}
          {lastLog?.duration != null && (
            <span className="ml-1 opacity-70">({formatDuration(lastLog.duration)})</span>
          )}
        </div>
      ) : (
        <div
          className="overflow-y-auto overflow-x-hidden space-y-0.5 no-scrollbar cursor-pointer"
          style={{ maxHeight: `${maxHeight}px` }}
          onClick={() => setIsCollapsed(true)}
        >
          {logs.map((log, index) => (
            <div
              key={log.id || index}
              className={`${getLogStyle(log.type)} transition-opacity hover:opacity-100`}
            >
              {log.type === 'thinking' && log.detail ? (
                <>
                  <span className="font-medium">思考内容：</span>
                  <span className="ml-1 opacity-90">
                    {log.detail.length > 200 ? `${log.detail.slice(0, 200)}…` : log.detail}
                  </span>
                </>
              ) : (
                <>
                  {log.message}
                  {log.duration != null && (
                    <span className="ml-1 opacity-70">
                      ({formatDuration(log.duration)})
                    </span>
                  )}
                  {/* MCP 工具调用时显示参数详情（独立一行） */}
                  {log.detail && log.type === 'tool' && (
                    <div className="mt-0.5 ml-2 text-[10px] opacity-75 text-blue-500/80 dark:text-blue-400/80 whitespace-pre-wrap break-all">
                      {log.detail}
                    </div>
                  )}
                  {/* 其他类型的 detail 显示 */}
                  {log.detail && log.type !== 'thinking' && log.type !== 'tool' && (
                    <span className="ml-1 opacity-60 text-[10px]">
                      {log.detail}
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
          
          {/* 活动状态时显示光标 */}
          {isActive && (
            <span className="inline-block w-1 h-3 bg-muted-foreground/40 animate-pulse" />
          )}
          
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};

export default ExecutionLogViewer;
