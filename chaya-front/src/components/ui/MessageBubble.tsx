/**
 * 统一的消息气泡组件
 * 用于会话、Agent、Meeting 等场景的消息展示
 * 确保所有场景的消息样式一致
 */

import React from 'react';
import { User, Bot, Wrench, Plug, Workflow as WorkflowIcon, Brain } from 'lucide-react';
import { cn } from '../../utils/cn';

/** 消息角色类型 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 工具类型 */
export type ToolType = 'workflow' | 'mcp' | 'general';

/** 消息气泡样式配置 */
export interface MessageBubbleStyleConfig {
  /** 是否使用紧凑模式 */
  compact?: boolean;
  /** 是否显示圆角方向（如 rounded-tr-none） */
  cornerDirection?: 'tl' | 'tr' | 'bl' | 'br' | 'none';
}

/** 消息气泡 Props */
export interface MessageBubbleProps {
  /** 消息角色 */
  role: MessageRole;
  /** 工具类型（仅 role='tool' 时有效） */
  toolType?: ToolType;
  /** 子内容 */
  children: React.ReactNode;
  /** 额外的类名 */
  className?: string;
  /** 样式配置 */
  styleConfig?: MessageBubbleStyleConfig;
}

/**
 * 获取消息气泡的背景样式类
 */
export function getMessageBubbleClasses(
  role: MessageRole,
  toolType?: ToolType,
  styleConfig?: MessageBubbleStyleConfig
): string {
  const { compact = false, cornerDirection = 'none' } = styleConfig || {};
  
  // 基础样式
  const baseClasses = cn(
    'transition-all duration-200',
    // assistant 和 tool 消息全屏显示，减少圆角和内边距
    role === 'assistant' || role === 'tool' 
      ? 'rounded-none px-3 py-2' 
      : cn('rounded-lg', compact ? 'px-2 py-1.5' : 'p-2'),
    // 圆角方向（仅对非 assistant/tool 消息生效）
    role !== 'assistant' && role !== 'tool' && cornerDirection === 'tl' && 'rounded-tl-none',
    role !== 'assistant' && role !== 'tool' && cornerDirection === 'tr' && 'rounded-tr-none',
    role !== 'assistant' && role !== 'tool' && cornerDirection === 'bl' && 'rounded-bl-none',
    role !== 'assistant' && role !== 'tool' && cornerDirection === 'br' && 'rounded-br-none',
  );
  
  // 角色特定样式 - 统一配色方案
  const roleClasses = {
    user: 'bg-[var(--color-accent-bg)] text-[var(--text-primary)] border rounded-2xl px-3 py-2 shadow-none',
    assistant: 'bg-transparent text-[var(--text-primary)] border-none rounded-none px-0 py-0 shadow-none',
    system: 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border border-[var(--border-default)] rounded-full px-3 py-1.5 shadow-none',
    tool: getToolClasses(toolType),
  };
  
  return cn(baseClasses, roleClasses[role]);
}

/**
 * 获取工具消息的样式类
 */
function getToolClasses(toolType?: ToolType): string {
  switch (toolType) {
    case 'workflow':
      return 'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-xl';
    case 'mcp':
      return 'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-xl';
    default:
      return 'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border-default)] rounded-xl';
  }
}

/**
 * 消息气泡组件
 */
export const MessageBubble: React.FC<MessageBubbleProps> = ({
  role,
  toolType,
  children,
  className,
  styleConfig,
}) => {
  const bubbleClasses = getMessageBubbleClasses(role, toolType, styleConfig);
  
  return (
    <div
      className={cn(bubbleClasses, className, `message-bubble-${role}`)}
      style={{
        fontSize: 'var(--chat-message-font-size, 12px)',
        lineHeight: 'var(--chat-message-line-height, 1.5)',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      }}
    >
      {children}
    </div>
  );
};

/** 头像 Props */
export interface MessageAvatarProps {
  /** 消息角色 */
  role: MessageRole;
  /** 工具类型（仅 role='tool' 时有效） */
  toolType?: ToolType;
  /** 头像 URL */
  avatarUrl?: string;
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg';
  /** 额外的类名 */
  className?: string;
}

/**
 * 获取头像的背景样式类
 */
export function getAvatarClasses(
  role: MessageRole,
  toolType?: ToolType,
  size: 'sm' | 'md' | 'lg' = 'md'
): string {
  const sizeClasses = {
    sm: 'w-5 h-5',
    md: 'w-7 h-7',
    lg: 'w-8 h-8',
  };
  
  const baseClasses = cn(
    'rounded-md flex items-center justify-center shadow-sm overflow-hidden',
    sizeClasses[size]
  );
  
  // 统一的颜色方案
  const colorClasses = {
    user: 'bg-primary-500 text-white',
    assistant: 'bg-primary-500 text-white',
    system: 'bg-gray-400 text-white',
    tool: getToolAvatarClasses(toolType),
  };
  
  return cn(baseClasses, colorClasses[role]);
}

/**
 * 获取工具头像的颜色类
 */
function getToolAvatarClasses(toolType?: ToolType): string {
  switch (toolType) {
    case 'workflow':
      return 'bg-primary-500 text-white';
    case 'mcp':
      return 'bg-green-500 text-white';
    default:
      return 'bg-gray-500 text-white';
  }
}

/**
 * 消息头像组件
 */
export const MessageAvatar: React.FC<MessageAvatarProps> = ({
  role,
  toolType,
  avatarUrl,
  size = 'md',
  className,
}) => {
  const avatarClasses = getAvatarClasses(role, toolType, size);
  
  const iconSize = size === 'sm' ? 'w-3 h-3' : size === 'lg' ? 'w-5 h-5' : 'w-4 h-4';
  
  const renderIcon = () => {
    if (role === 'user') {
      return <User className={iconSize} />;
    }
    
    if (role === 'assistant') {
      if (avatarUrl) {
        return <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />;
      }
      return <Bot className={iconSize} />;
    }
    
    if (role === 'tool') {
      switch (toolType) {
        case 'workflow':
          return <WorkflowIcon className={iconSize} />;
        case 'mcp':
          return <Plug className={iconSize} />;
        default:
          return <Wrench className={iconSize} />;
      }
    }
    
    return <Bot className={iconSize} />;
  };
  
  return (
    <div className={cn(avatarClasses, className, `avatar-${role}`)}>
      {renderIcon()}
    </div>
  );
};

/** 思考/流式状态指示器 Props */
export interface MessageStatusIndicatorProps {
  /** 是否正在思考 */
  isThinking?: boolean;
  /** 是否正在流式输出 */
  isStreaming?: boolean;
  /** 是否有内容 */
  hasContent?: boolean;
  /** 当前执行步骤 */
  currentStep?: string;
  /** LLM 提供商 */
  llmProvider?: string;
}

/**
 * 消息状态指示器组件
 */
export const MessageStatusIndicator: React.FC<MessageStatusIndicatorProps> = ({
  isThinking,
  isStreaming,
  hasContent,
  currentStep,
  llmProvider,
}) => {
  // 思考中动画（只有思考，还没有内容）
  if (isThinking && !hasContent) {
    return (
      <div className="flex items-center space-x-2">
        <div className="relative">
          <Brain className="w-4 h-4 text-primary-500 animate-pulse" />
          <div className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-primary-400 rounded-full animate-ping opacity-75" />
        </div>
        <div className="flex items-center space-x-1">
          <div className="flex space-x-0.5 ml-1">
            <div className="w-1 h-1 bg-primary-500 rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '1s' }} />
            <div className="w-1 h-1 bg-primary-500 rounded-full animate-bounce" style={{ animationDelay: '200ms', animationDuration: '1s' }} />
            <div className="w-1 h-1 bg-primary-500 rounded-full animate-bounce" style={{ animationDelay: '400ms', animationDuration: '1s' }} />
          </div>
          {currentStep && currentStep.trim() && (
            <span className="text-xs text-gray-400 dark:text-[#808080] font-normal truncate max-w-[200px]">
              {currentStep}
            </span>
          )}
        </div>
      </div>
    );
  }

  // 等待响应动画（流式模式但还没有内容）
  if (isStreaming && !hasContent) {
    // 不再在气泡内显示黄色“等待响应”动画（与思维链图标动画重复）
    return null;
  }

  // 回答中动画（正在流式输出内容）
  if (isStreaming) {
    return (
      <div className="flex items-center space-x-1.5">
        <div className="flex space-x-0.5">
          <div className="w-1.5 h-1.5 bg-primary-500 rounded-full animate-pulse" style={{ animationDelay: '0ms' }} />
          <div className="w-1.5 h-1.5 bg-primary-500 rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
          <div className="w-1.5 h-1.5 bg-primary-500 rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
        </div>
        {currentStep && currentStep.trim() && (
          <span className="text-xs text-gray-400 dark:text-[#808080] font-normal truncate max-w-[200px]">
            {currentStep}
          </span>
        )}
      </div>
    );
  }

  // 当前执行步骤
  if (currentStep && currentStep.trim()) {
    return (
      <span className="text-xs text-gray-400 dark:text-[#808080] font-normal">
        {currentStep}
      </span>
    );
  }

  return null;
};

/** 系统通知消息 Props */
export interface SystemNotificationProps {
  /** 消息内容 */
  content: string;
  /** 额外的类名 */
  className?: string;
}

/**
 * 系统通知消息组件（居中显示的提示消息）
 */
export const SystemNotification: React.FC<SystemNotificationProps> = ({
  content,
  className,
}) => {
  return (
    <div className={cn('flex justify-center my-2', className)}>
      <div className="text-xs text-gray-500 dark:text-[#b0b0b0] px-3 py-1.5 bg-gray-100 dark:bg-[#2d2d2d] rounded-full">
        {content}
      </div>
    </div>
  );
};

/** 流式响应区域 Props */
export interface StreamingResponseProps {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName?: string;
  /** Agent 头像 */
  agentAvatar?: string;
  /** 流式内容 */
  streamContent?: string;
  /** 思考内容 */
  streamThinking?: string;
  /** 取消回调 */
  onCancel?: () => void;
  /** 渲染内容的组件 */
  renderContent?: (content: string) => React.ReactNode;
}

/**
 * 流式响应区域组件（用于显示正在生成的响应）
 */
export const StreamingResponse: React.FC<StreamingResponseProps> = ({
  agentId,
  agentName = '智能体',
  agentAvatar,
  streamContent,
  streamThinking,
  onCancel,
  renderContent,
}) => {
  return (
    <div className="p-3 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center space-x-2">
          <div className="relative w-5 h-5 rounded-full overflow-hidden border border-gray-200 dark:border-[#404040] flex items-center justify-center bg-purple-100 dark:bg-purple-900/30">
            {agentAvatar ? (
              <img src={agentAvatar} alt={agentName} className="w-full h-full object-cover" />
            ) : (
              <Bot className="w-3 h-3 text-purple-500" />
            )}
            {/* 加载动画 */}
            <div className="absolute inset-0 bg-blue-500/20 animate-pulse rounded-full" />
          </div>
          <span className="text-xs font-medium text-gray-900 dark:text-white">
            {agentName}
          </span>
          <div className="flex items-center space-x-1">
            <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1 h-1 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-xs text-blue-500">正在思考...</span>
        </div>
        
        {/* 取消按钮 */}
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-xs px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 flex items-center"
          >
            取消
          </button>
        )}
      </div>
      
      {/* 思考内容 */}
      {streamThinking && (
        <div className="mb-2 p-2 bg-gray-100 dark:bg-[#2d2d2d] rounded text-xs text-gray-500 italic">
          💭 {streamThinking.substring(0, 200)}{streamThinking.length > 200 ? '...' : ''}
        </div>
      )}
      
      {/* 流式内容 */}
      {streamContent && (
        <div className="text-gray-700 dark:text-gray-300">
          {renderContent ? renderContent(streamContent) : (
            <span className="text-sm whitespace-pre-wrap">{streamContent}</span>
          )}
          <span className="inline-block w-1 h-4 bg-blue-500 animate-pulse ml-0.5" />
        </div>
      )}
    </div>
  );
};

/**
 * 消息气泡容器组件（简化的包装器）
 * 只提供样式包装，不包含头像和状态指示器
 */
export interface MessageBubbleContainerProps {
  /** 消息角色 */
  role: MessageRole;
  /** 工具类型（仅 role='tool' 时有效） */
  toolType?: ToolType;
  /** 子内容 */
  children: React.ReactNode;
  /** 额外的类名 */
  className?: string;
}

export const MessageBubbleContainer: React.FC<MessageBubbleContainerProps> = ({
  role,
  toolType,
  children,
  className,
}) => {
  const bubbleClasses = getMessageBubbleClasses(role, toolType);
  
  return (
    <div
      className={cn(bubbleClasses, className, `message-bubble-${role}`)}
      style={{
        fontSize: 'var(--chat-message-font-size, 12px)',
        lineHeight: 'var(--chat-message-line-height, 1.5)',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      }}
    >
      {children}
    </div>
  );
};

export default MessageBubble;
