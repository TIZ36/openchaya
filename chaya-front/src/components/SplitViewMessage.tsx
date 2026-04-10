/**
 * 分栏消息视图组件
 * 左边显示消息主要内容，右边显示AI思考过程、MCP调用和工作流执行过程
 */

import React, { useRef, useState } from 'react';
import {
  CheckSquare,
  Square,
  Edit2,
  RotateCw,
  Plug,
  Quote,
  BookOpen,
  SquareStop,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import type { ExecutionLogEntry } from './ui/ExecutionLogViewer';
import type { ProcessMessage } from '../types/processMessage';
import { Button } from './ui/Button';
import { 
  MessageBubble, 
  MessageAvatar, 
  type MessageRole,
  type ToolType
} from './ui/MessageBubble';
import type { MCPDetail } from '../services/chat';
import type { WorkflowNode, WorkflowConnection } from '../types';

/** 多模态媒体内容类型 */
export interface MediaItem {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string; // base64 编码的数据
  url?: string; // 如果是 URL
}

export interface SplitViewMessageProps {
  /** 消息ID */
  id: string;
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 消息内容 */
  content: string;
  /** 思考过程 */
  thinking?: string;
  /** 是否正在思考 */
  isThinking?: boolean;
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 当前执行步骤 */
  currentStep?: string;
  /** 工具类型 */
  toolType?: 'workflow' | 'mcp';
  /** 工作流ID */
  workflowId?: string;
  /** 工作流名称 */
  workflowName?: string;
  /** 工作流状态 */
  workflowStatus?: 'pending' | 'running' | 'completed' | 'error';
  /** 工作流结果 */
  workflowResult?: string;
  /** 工作流配置 */
  workflowConfig?: { nodes: WorkflowNode[]; connections: WorkflowConnection[] };
  /** 工具调用 */
  toolCalls?: Array<{ name: string; arguments: any; result?: any }>;
  /** MCP 执行详情 */
  mcpDetail?: MCPDetail;
  /** 思维签名 */
  thoughtSignature?: string;
  /** 多模态媒体内容（图片、视频、音频） */
  media?: MediaItem[];
  /** 头像URL */
  avatarUrl?: string;
  /** 是否被选中（技能包选择模式） */
  isSelected?: boolean;
  /** 是否在选择模式 */
  selectionMode?: boolean;
  /** 是否正在加载 */
  isLoading?: boolean;
  /** 消息内容渲染器 */
  renderContent: (message: any) => React.ReactNode;
  /** 选择切换回调 */
  onToggleSelection?: () => void;
  /** 引用消息回调 */
  onQuote?: () => void;
  /** 编辑消息回调 */
  onEdit?: () => void;
  /** 重新发送回调 */
  onResend?: () => void;
  /** MCP详情查看回调 */
  onViewMCPDetail?: () => void;
  /** 重试回调 */
  onRetry?: () => void;
  /** LLM 提供商 */
  llmProvider?: string;
  /** 过程消息（新协议） */
  processMessages?: ProcessMessage[];
  /** 执行日志（持久化） */
  executionLogs?: ExecutionLogEntry[];
  /** 保存到知识库回调 */
  onSaveToKB?: () => void;
  /** 打断生成回调（处理中时在思维链右侧显示打断按钮） */
  onInterrupt?: () => void;
  /** 回滚到此消息之后（与用户消息「回滚」一致：删除本条之后的所有消息） */
  onRollback?: () => void;
  /** 当前对助手回复的评价（来自 message.ext） */
  assistantFeedback?: 'up' | 'down' | null;
  /** 点赞/点踩/清除（再点同一按钮可清除） */
  onAssistantFeedback?: (next: 'up' | 'down' | null) => void;
}

export const SplitViewMessage: React.FC<SplitViewMessageProps> = ({
  id,
  role,
  content,
  thinking,
  isThinking,
  isStreaming,
  currentStep,
  toolType,
  workflowId,
  workflowName,
  workflowStatus,
  workflowResult,
  workflowConfig,
  toolCalls,
  mcpDetail,
  thoughtSignature,
  media,
  avatarUrl,
  isSelected,
  selectionMode,
  isLoading,
  renderContent,
  onToggleSelection,
  onQuote,
  onEdit,
  onResend,
  onViewMCPDetail,
  onRetry,
  onSaveToKB,
  processMessages,
  executionLogs,
  onInterrupt,
  onRollback,
  assistantFeedback,
  onAssistantFeedback,
}) => {
  const leftRef = useRef<HTMLDivElement>(null);

  // 判断是否需要显示右侧面板（只有assistant消息且有额外内容时显示）
  const hasThinking = thinking && thinking.trim().length > 0;
  // MCPDetail 在本项目里可能是：
  // - 旧结构：tool_calls/tool_results
  // - 新结构：execution 记录（raw_result/logs/component_type/status）
  const hasMCPDetail = !!mcpDetail && (() => {
    const anyDetail = mcpDetail as any;
    if (Array.isArray(anyDetail?.tool_calls) && anyDetail.tool_calls.length > 0) return true;
    if (Array.isArray(anyDetail?.tool_results) && anyDetail.tool_results.length > 0) return true;
    if (anyDetail?.raw_result) return true;
    if (Array.isArray(anyDetail?.logs) && anyDetail.logs.length > 0) return true;
    // execution 记录本身存在也认为有过程可展示（至少有状态/错误）
    if (anyDetail?.status) return true;
    return false;
  })();
  const hasToolCalls = toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0;
  // 保留变量引用用于未来扩展
  void hasThinking; void hasMCPDetail; void hasToolCalls;

  // 用户消息不显示分栏
  const isUserMessage = role === 'user';

  // 构造消息对象传给 renderContent
  const messageObj = {
    id,
    role,
    content,
    thinking,
    isThinking,
    isStreaming,
    currentStep,
    toolType,
    workflowId,
    workflowName,
    workflowStatus,
    workflowResult,
    workflowConfig,
    toolCalls,
    mcpDetail,
    thoughtSignature,
    media, // 多模态媒体内容
  };

  // AG 消息靠左，用户消息靠右（与常见对话布局一致）
  const isAssistantMessage = role === 'assistant' || role === 'tool';

  return (
    <div 
      data-message-id={id}
      onClick={selectionMode ? onToggleSelection : undefined}
      className={`fade-in-up stagger-item ${
        isAssistantMessage
          ? 'w-full flex'
          : 'flex w-full items-start space-x-2 justify-end'
      } ${
        selectionMode 
          ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-[#404040] rounded-lg p-2 -m-2 transition-all duration-200' 
          : ''
      } ${
        isSelected && selectionMode
          ? 'bg-primary-50 dark:bg-primary-900/20 ring-2 ring-primary-300 dark:ring-primary-700 rounded-lg p-2 -m-2' 
          : ''
      }`}
    >
      {/* 选择复选框（仅在选择模式下显示） */}
      {selectionMode && (
        <div className="flex-shrink-0 mt-0.5 mr-1.5">
          {isSelected ? (
            <CheckSquare className="w-4 h-4 text-primary-500" />
          ) : (
            <Square className="w-4 h-4 text-gray-400" />
          )}
        </div>
      )}

      {/* 头像 - 非用户消息保留原布局 */}
      {!isAssistantMessage && !isUserMessage && (
        <div className="flex-shrink-0 flex items-start">
          <MessageAvatar 
            role={role as MessageRole} 
            toolType={toolType as ToolType} 
            avatarUrl={avatarUrl}
            size="md"
          />
        </div>
      )}

      {/* 消息内容区域 */}
      <div
        className={`group relative min-w-0 ${
          isAssistantMessage ? 'w-full max-w-full flex flex-col' : 'flex-1'
        }`}
      >
        {isAssistantMessage ? (
          /* AI 消息：头像行 → 后端过程日志 → 输出（整体靠左） */
          <AssistantMessageLayout
            role={role}
            content={content}
            toolType={toolType}
            toolCalls={toolCalls}
            mcpDetail={mcpDetail}
            avatarUrl={avatarUrl}
            isThinking={isThinking}
            isStreaming={isStreaming}
            isLoading={isLoading}
            processMessages={processMessages}
            executionLogs={executionLogs}
            onQuote={onQuote}
            onSaveToKB={onSaveToKB}
            onViewMCPDetail={onViewMCPDetail}
            onRetry={onRetry}
            onInterrupt={onInterrupt}
            onRollback={onRollback}
            assistantFeedback={assistantFeedback}
            onAssistantFeedback={onAssistantFeedback}
            leftRef={leftRef}
            renderContent={renderContent}
            messageObj={messageObj}
          />
        ) : (
          /* 用户消息：右侧头像 + 操作，气泡在右下 */
          <div ref={leftRef} className="min-w-0 space-y-2 w-full flex flex-col items-end">
            <div className="flex items-center justify-end gap-1 flex-row-reverse">
              <MessageAvatar 
                role={role as MessageRole} 
                toolType={toolType as ToolType} 
                avatarUrl={avatarUrl}
                size="md"
              />
              {!isLoading && (onEdit || onResend) && (
                <div className="flex items-center gap-0.5 bg-muted/70 rounded-md border border-border px-0.5 py-0">
                  {onEdit && (
                    <Button
                      onClick={onEdit}
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-muted-foreground hover:text-primary-600 dark:hover:text-primary-400"
                      title="编辑消息"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {onResend && (
                    <Button
                      onClick={onResend}
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-muted-foreground hover:text-green-600 dark:hover:text-green-400"
                      title="重新发送"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </div>
            <MessageBubble role={role as MessageRole} toolType={toolType as ToolType}>
              {renderContent(messageObj)}
            </MessageBubble>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * AI 消息布局：头像 + 内联日志流 + 输出
 * 所有过程信息（思考、MCP、决策、执行日志）统一为一条日志流，用颜色区分类型
 */
const AssistantMessageLayout: React.FC<{
  role: string;
  content: string;
  toolType?: string;
  toolCalls?: any;
  mcpDetail?: any;
  avatarUrl?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isLoading?: boolean;
  processMessages?: ProcessMessage[];
  executionLogs?: ExecutionLogEntry[];
  onQuote?: () => void;
  onSaveToKB?: () => void;
  onViewMCPDetail?: () => void;
  onRetry?: () => void;
  onInterrupt?: () => void;
  onRollback?: () => void;
  assistantFeedback?: 'up' | 'down' | null;
  onAssistantFeedback?: (next: 'up' | 'down' | null) => void;
  leftRef: React.RefObject<HTMLDivElement | null>;
  renderContent: (msg: any) => React.ReactNode;
  messageObj: any;
}> = ({
  role, content, toolType, toolCalls, mcpDetail, avatarUrl,
  isThinking, isStreaming, isLoading,
  processMessages, executionLogs,
  onQuote, onSaveToKB, onViewMCPDetail, onRetry, onInterrupt, onRollback,
  assistantFeedback,
  onAssistantFeedback,
  leftRef, renderContent, messageObj,
}) => {
  const isActive = isThinking || isStreaming;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [logsExpanded, setLogsExpanded] = useState(isActive);
  const [expandedLogDetails, setExpandedLogDetails] = useState<Record<number, boolean>>({});

  // 合并 processMessages + executionLogs → 统一日志流
  const logStream = React.useMemo(() => {
    const items: Array<{ ts: number; label: string; detail?: string; color: string }> = [];

    // processMessages → 日志条目
    if (processMessages) {
      for (const pm of processMessages) {
        const t = pm.type || '';
        const title = (typeof pm.title === 'string' ? pm.title : '').trim();
        const body = (typeof pm.content === 'string' ? pm.content : '').trim();
        if (!title && !body) continue;
        // 跳过占位
        if (title === '思考中' || title === '输出中') continue;

        let color = 'text-gray-400 dark:text-gray-500'; // 默认
        if (t === 'thinking' || t === 'llm_generating') color = 'text-blue-400';
        else if (t === 'mcp_call' || t === 'ag_use_mcp' || t === 'workflow') color = 'text-emerald-400';
        else if (t === 'llm_decision' || t === 'agent_decision' || t === 'agent_deciding') color = 'text-amber-400';
        else if (t === 'output' || t === 'agent_will_reply') color = 'text-purple-400';
        else if (t === 'load_llm_tool' || t === 'prepare_context' || t === 'msg_classify' || t === 'msg_pre_deal' || t === 'msg_deal' || t === 'post_msg_deal') color = 'text-gray-400 dark:text-gray-500';

        items.push({ ts: pm.timestamp || 0, label: title || body.slice(0, 60), detail: body || undefined, color });
      }
    }

    // executionLogs → 日志条目
    if (executionLogs) {
      for (const log of executionLogs) {
        const msg = log.message?.trim();
        if (!msg) continue;
        if (msg === '思考中...' || msg === '执行中...' || msg === '处理中...') continue;

        const color = 'text-gray-400 dark:text-gray-500';

        items.push({ ts: log.timestamp || 0, label: msg, detail: log.detail || undefined, color });
      }
    }

    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [processMessages, executionLogs]);

  const hasLogs = logStream.length > 0;

  // 自动滚动
  React.useEffect(() => {
    if (scrollRef.current && isActive) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logStream.length, isActive]);

  React.useEffect(() => {
    if (isActive) {
      setLogsExpanded(true);
    }
  }, [isActive]);

  return (
    <div className="flex w-full flex-col space-y-1">
      {/* 头像行（AG 在左侧） */}
      <div className="flex w-full flex-wrap items-center justify-start gap-1">
        <MessageAvatar role={role as MessageRole} toolType={toolType as ToolType} avatarUrl={avatarUrl} size="sm" />

        {/* 打断 */}
        {isActive && onInterrupt && (
          <Button variant="ghost" size="icon" onClick={onInterrupt} title="打断"
            className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-red-400 hover:text-red-500 hover:bg-red-500/10">
            <SquareStop className="w-3.5 h-3.5" />
          </Button>
        )}

        {/* 动作按钮（完成后显示；回滚不依赖 content，与用户消息一致） */}
        {!isActive && (
          <>
            {role === 'assistant' && onAssistantFeedback && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onAssistantFeedback(assistantFeedback === 'up' ? null : 'up')}
                  title={assistantFeedback === 'up' ? '取消点赞' : '有用'}
                  className={`h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 ${
                    assistantFeedback === 'up'
                      ? 'text-emerald-500 hover:text-emerald-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
                  }`}
                >
                  <ThumbsUp className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onAssistantFeedback(assistantFeedback === 'down' ? null : 'down')}
                  title={assistantFeedback === 'down' ? '取消点踩' : '需改进'}
                  className={`h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 ${
                    assistantFeedback === 'down'
                      ? 'text-rose-500 hover:text-rose-400'
                      : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'
                  }`}
                >
                  <ThumbsDown className="w-3.5 h-3.5" />
                </Button>
              </>
            )}
            {content && (
              <>
                {onQuote && (
                  <Button variant="ghost" size="icon" onClick={onQuote} title="引用"
                    className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
                    <Quote className="w-3.5 h-3.5" />
                  </Button>
                )}
                {onSaveToKB && role === 'assistant' && (
                  <Button variant="ghost" size="icon" onClick={onSaveToKB} title="存入知识库"
                    className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
                    <BookOpen className="w-3.5 h-3.5" />
                  </Button>
                )}
                {mcpDetail && onViewMCPDetail && (
                  <Button variant="ghost" size="icon" onClick={onViewMCPDetail} title="MCP 详情"
                    className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-emerald-500 hover:text-emerald-400">
                    <Plug className="w-3.5 h-3.5" />
                  </Button>
                )}
              </>
            )}
            {onRollback && (
              <Button variant="ghost" size="icon" onClick={onRollback} title="回滚到此消息"
                className="h-6 w-6 min-h-0 min-w-0 shrink-0 p-0 text-gray-400 hover:text-green-600 dark:text-gray-500 dark:hover:text-green-400">
                <RotateCw className="w-3.5 h-3.5" />
              </Button>
            )}
          </>
        )}
      </div>

      {/* 后端过程日志流（WS execution_log / processMessages 合并） */}
      {(hasLogs || isActive) && (
        <div className="w-full max-w-full">
          <button
            type="button"
            onClick={() => setLogsExpanded(v => !v)}
            className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/90 hover:text-foreground transition-colors"
          >
            <span>后端过程</span>
            <span>{logsExpanded ? '收起' : `查看 ${logStream.length} 条`}</span>
          </button>
          {logsExpanded && (
            <div
              ref={scrollRef}
              className={`mr-0 max-w-full overflow-y-auto no-scrollbar text-left transition-all ${
                isActive ? 'max-h-[180px]' : 'max-h-[180px]'
              }`}
            >
              {logStream.map((item, i) => (
                <div
                  key={i}
                  className={`flex flex-col text-[10px] leading-relaxed py-px ${item.color}`}
                >
                  <div className="flex items-start justify-start gap-1.5">
                    <span className="min-w-0 break-words text-left">{item.label}</span>
                    {item.detail && (
                      <button
                        type="button"
                        className="shrink-0 rounded px-1 py-[1px] text-[9px] border border-blue-400/40 text-blue-400 opacity-90 hover:opacity-100"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setExpandedLogDetails(prev => ({ ...prev, [i]: !prev[i] }));
                        }}
                        title={expandedLogDetails[i] ? '收起详情' : '查看详情'}
                      >
                        {expandedLogDetails[i] ? '收起' : '查看'}
                      </button>
                    )}
                    <span className="shrink-0 opacity-50 font-mono">
                      {item.ts ? new Date(item.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                    </span>
                  </div>
                  {item.detail && expandedLogDetails[i] && (
                    <div className="w-full mt-1 ml-1 text-[10px] text-foreground/80 whitespace-pre-wrap break-words border-l border-current/30 pl-2">
                      {item.detail}
                    </div>
                  )}
                </div>
              ))}
              {isActive && (
                <div className="flex items-center justify-start gap-1 text-[10px] text-blue-400 py-px">
                  <span>{isThinking ? '思考中' : '生成中'}</span>
                  <span className="inline-block h-2.5 w-1 bg-blue-400/60 animate-pulse" />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 输出：与聊天区同宽，避免仅挤在右半屏 */}
      <div ref={leftRef} className="relative min-w-0 w-full max-w-full">
        <MessageBubble role={role as MessageRole} toolType={toolType as ToolType} className="w-full">
          {renderContent(messageObj)}
        </MessageBubble>

        {content?.includes('❌ 错误') && toolCalls && typeof toolCalls === 'object' &&
          (toolCalls as any).canRetry === true && onRetry && (
          <div className="absolute -top-8 left-0">
            <button onClick={onRetry} disabled={isLoading}
              className="px-2.5 py-1 text-xs font-medium text-white bg-primary-500 hover:bg-primary-600 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg transition-all flex items-center space-x-1.5 shadow-md">
              <RotateCw className="w-3.5 h-3.5" />
              <span>重试</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SplitViewMessage;
