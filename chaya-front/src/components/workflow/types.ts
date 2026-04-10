/**
 * Workflow 组件相关的类型定义
 */


/** 多模态附件 */
export interface MultimodalAttachment {
  id: string;
  type: 'image' | 'audio' | 'video' | 'file';
  name: string;
  mimeType: string;
  /** base64 数据或 URL */
  data: string;
  size?: number;
}

/** 可执行组件 */
export interface ExecutableComponent {
  id: string;
  type: 'plugin' | 'batch' | 'mcp_call';
  name: string;
  config: any;
  status?: 'idle' | 'running' | 'completed' | 'error';
  result?: any;
}

/** 消息内的 MCP 详情 */
export interface MCPDetail {
  mcpServer?: string;
  toolName?: string;
  arguments?: any;
  result?: any;
  status?: string;
  duration?: number;
}

/** 扩展的消息类型 - 统一的工作流消息类型定义 */
export interface Message {
  id: string;
  message_id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  content: string;
  // Topic/多Agent消息元信息（可选）
  sender_id?: string;
  sender_avatar?: string;  // Agent 头像 URL
  sender_name?: string;    // Agent 名称
  sender_type?: 'user' | 'agent' | 'system';
  thinking?: string;
  toolCalls?: Array<{ name: string; arguments: any; result?: any }> | {
    isSystemPrompt?: boolean;
    batchName?: string;
    item?: any;
    canRetry?: boolean;
    errorType?: 'network' | 'timeout' | 'api' | 'unknown';
    [key: string]: any;
  };
  isStreaming?: boolean;
  isThinking?: boolean;
  currentStep?: string;
  toolType?: 'mcp';
  isSummary?: boolean;
  media?: Array<{
    type: 'image' | 'video' | 'audio';
    mimeType: string;
    data: string;
    url?: string;
  }>;
  thoughtSignature?: string;
  toolCallSignatures?: Record<string, string>;
  mcpdetail?: any;
  processMessages?: any[]; // ProcessMessage[] - 从 ../../types/processMessage 导入（避免循环依赖）
  executionLogs?: Array<{ id: string; timestamp: number; type: string; message: string; detail?: string; duration?: number }>;
  avatarUrl?: string; // Add avatarUrl for assistant messages
  agentName?: string; // Add agentName for assistant messages
  ext?: any; // 扩展字段（用于 reaction/引用等装饰）
  
  // 兼容旧字段（可选）
  timestamp?: Date;
  thinkingContent?: string;
  components?: ExecutableComponent[];
  isEditing?: boolean;
  editedContent?: string;
  isResending?: boolean;
  quotedMessage?: { id: string; content: string };
  status?: 'sending' | 'sent' | 'error';
  errorMessage?: string;
  /** 多模态附件（兼容旧字段） */
  multimodal?: MultimodalAttachment[];
  /** MCP 工具调用详情（兼容旧字段） */
  mcpDetails?: MCPDetail[];
  
  // 工作流相关字段
  workflowId?: string;
  workflowName?: string;
  workflowStatus?: 'pending' | 'running' | 'completed' | 'error';
}

/** Workflow 组件的 Props */
export interface WorkflowProps {
  sessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
}

/** 删除目标信息 */
export interface DeleteTarget {
  id: string;
  name: string;
}
