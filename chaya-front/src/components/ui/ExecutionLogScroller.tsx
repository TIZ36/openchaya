/**
 * ExecutionLogScroller - 执行日志垂直滚动显示（类似 Cursor）
 * 显示在思维链图标右侧，上下滚动、最新在底部
 */

import React, { useEffect, useRef } from 'react';
import type { ExecutionLogEntry } from './ExecutionLogViewer';

export interface ExecutionLogScrollerProps {
  logs: ExecutionLogEntry[];
  isActive?: boolean;
  className?: string;
  /** 最大高度（px），超出后垂直滚动，默认 120 */
  maxHeight?: number;
}

// 格式化日志消息，提取关键信息
function formatLogMessage(log: ExecutionLogEntry): string {
  // 思考过程 - 提取思考内容
  if (log.type === 'thinking') {
    let thinkingText = '';
    if (log.detail) {
      thinkingText = typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail);
    } else if (log.message) {
      thinkingText = log.message;
    }
    // 提取前30个字符
    const shortText = thinkingText.length > 30 ? thinkingText.substring(0, 30) + '...' : thinkingText;
    return `💭 ${shortText}`;
  }
  
  // MCP调用 - 提取工具名称和参数信息
  if (log.type === 'tool') {
    let toolName = '';
    let toolInfo = '';
    
    // 从 message 中提取工具名称
    const toolMatch = log.message.match(/(?:工具|调用|使用)[：:：]\s*(.+?)(?:[，,。]|$)/);
    if (toolMatch) {
      toolName = toolMatch[1].trim();
    } else {
      toolName = log.message;
    }
    
    // 从 detail 中提取参数信息
    if (log.detail) {
      const detail = typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail);
      
      // 如果 detail 以 "参数:" 开头，直接使用
      if (detail.startsWith('参数:') || detail.startsWith('参数：')) {
        // 截取参数部分，显示更长一些（80字符）
        const paramsText = detail.replace(/^参数[：:]?\s*/, '');
        toolInfo = paramsText.length > 80 ? paramsText.substring(0, 80) + '...' : paramsText;
      } else {
        try {
          const detailObj = typeof log.detail === 'object' ? log.detail : JSON.parse(detail);
          // 提取工具名称
          if (detailObj.tool_name || detailObj.name) {
            toolName = detailObj.tool_name || detailObj.name;
          }
          // 提取参数摘要
          if (detailObj.arguments || detailObj.params) {
            const args = detailObj.arguments || detailObj.params;
            const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
            toolInfo = argsStr.length > 60 ? argsStr.substring(0, 60) + '...' : argsStr;
          }
          // 提取响应摘要
          if (detailObj.result || detailObj.response) {
            const result = detailObj.result || detailObj.response;
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            toolInfo = resultStr.length > 60 ? resultStr.substring(0, 60) + '...' : resultStr;
          }
        } catch (e) {
          // 如果解析失败，直接使用字符串（显示更长）
          toolInfo = detail.length > 80 ? detail.substring(0, 80) + '...' : detail;
        }
      }
    }
    
    return `🔧 ${toolName}${toolInfo ? `\n   ${toolInfo}` : ''}`;
  }
  
  // 重要决策 - 包括是否使用MCP、使用什么MCP、是否自迭代
  if (log.type === 'step' || log.type === 'llm') {
    const msg = log.message || '';
    if (msg.includes('决策') || msg.includes('选择') || msg.includes('自迭代') || msg.includes('MCP') || msg.includes('工具')) {
      // 提取决策关键信息
      let decisionText = msg;
      if (msg.includes('自迭代')) {
        decisionText = '🔄 自迭代';
      } else if (msg.includes('MCP') || msg.includes('工具')) {
        // 提取MCP名称
        const mcpMatch = msg.match(/(?:使用|选择|调用)(?:MCP|工具)[：:：]\s*(.+?)(?:[，,。]|$)/);
        if (mcpMatch) {
          decisionText = `⚡ 选择MCP: ${mcpMatch[1].trim()}`;
        } else {
          decisionText = `⚡ ${msg}`;
        }
      } else {
        decisionText = `⚡ ${msg}`;
      }
      return decisionText;
    }
    // LLM生成
    if (log.type === 'llm') {
      return `🤖 ${msg}`;
    }
  }
  
  // 默认
  return log.message || '';
}

// 根据日志类型获取样式类
function getLogStyle(type: ExecutionLogEntry['type']) {
  switch (type) {
    case 'error':
      return 'text-red-500/80 dark:text-red-400/80';
    case 'success':
      return 'text-green-600/80 dark:text-green-400/80';
    case 'thinking':
      return 'text-purple-600/80 dark:text-purple-400/80';
    case 'tool':
      return 'text-blue-600/80 dark:text-blue-400/80';
    case 'llm':
      return 'text-indigo-600/80 dark:text-indigo-400/80';
    case 'step':
      return 'text-amber-600/80 dark:text-amber-400/80';
    default:
      return 'text-muted-foreground/70 dark:text-muted-foreground/70';
  }
}

export const ExecutionLogScroller: React.FC<ExecutionLogScrollerProps> = ({
  logs,
  isActive = false,
  className = '',
  maxHeight = 120,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚动到底部（最新日志）
  useEffect(() => {
    if (scrollRef.current && isActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isActive]);

  if (!logs.length) {
    return null;
  }

  // 无意义占位文案，不展示
  const MEANINGLESS_MESSAGES = new Set([
    '思考中...',
    '执行中...',
    '处理中...',
    '模型生成中...',
    '调用工具中...',
  ]);
  const isMeaningless = (msg: string) =>
    MEANINGLESS_MESSAGES.has(msg?.trim() || '') || /^(.+\s+)?思考中\.\.\.$/.test(msg?.trim() || '');

  // 过滤并格式化关键日志，排除无意义文案；step/thinking/llm/tool 有实质内容即展示
  const importantLogs = logs
    .filter(log => {
      if (isMeaningless(log.message || '')) return false;
      return (
        log.type === 'thinking' ||
        log.type === 'tool' ||
        log.type === 'llm' ||
        log.type === 'step' ||
        log.type === 'success' ||
        log.type === 'info'
      );
    })
    .map(log => ({
      ...log,
      formattedMessage: formatLogMessage(log),
    }));

  if (importantLogs.length === 0) {
    return null;
  }

  return (
    <div
      ref={scrollRef}
      className={`execution-log-scroller flex flex-col gap-0.5 overflow-y-auto no-scrollbar scroll-smooth min-w-0 ${className}`}
      style={{ maxHeight: `${maxHeight}px`, scrollBehavior: 'smooth' }}
    >
      {importantLogs.map((log, index) => (
        <div
          key={log.id || index}
          className={`${getLogStyle(log.type)} text-[10px] font-medium pr-1 ${log.type === 'tool' ? 'whitespace-pre-wrap' : 'truncate'}`}
          title={log.detail ? (typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail)) : log.message}
        >
          {log.formattedMessage}
        </div>
      ))}
      {isActive && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          <span className="inline-block w-1 h-3 bg-primary-500/60 animate-pulse" />
          <span>进行中…</span>
        </div>
      )}
    </div>
  );
};

export default ExecutionLogScroller;
