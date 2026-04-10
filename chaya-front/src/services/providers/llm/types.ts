/**
 * LLM Provider Types
 * LLM 提供者模块类型定义
 */

import type { MediaItem, LLMProviderType, MessageRole } from '../../core/shared/types';

// ============================================================================
// Provider Types - Provider 类型
// ============================================================================

/**
 * Provider 配置
 */
export interface LLMProviderConfig {
  provider: LLMProviderType;
  apiKey?: string;
  apiUrl?: string;
  model: string;
  
  // 可选配置
  organizationId?: string;
  projectId?: string;
  
  // 请求配置
  timeout?: number;
  maxRetries?: number;
  
  // 模型特定配置
  modelConfig?: {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsStreaming?: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
}

// ============================================================================
// Message Types - 消息类型
// ============================================================================

/**
 * LLM 消息
 */
export interface LLMMessage {
  role: MessageRole;
  content: string;
  
  // 工具相关
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  
  // 多模态内容支持
  parts?: MessagePart[];
  
  // 思维签名（用于 Gemini）
  thoughtSignature?: string;
  toolCallSignatures?: Record<string, string>;
  
  // DeepSeek 思考模式的推理内容
  reasoning_content?: string;
}

/**
 * 消息部分（多模态）
 */
export interface MessagePart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  thoughtSignature?: string;
}

/**
 * 工具调用
 */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ============================================================================
// Tool Types - 工具类型
// ============================================================================

/**
 * MCP 工具定义
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * OpenAI 函数定义格式
 */
export interface OpenAIFunction {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ============================================================================
// Response Types - 响应类型
// ============================================================================

/**
 * LLM 响应
 */
export interface LLMResponse {
  content: string;
  thinking?: string;
  tool_calls?: LLMToolCall[];
  finish_reason?: string;
  thoughtSignature?: string;
  toolCallSignatures?: Record<string, string>;
  media?: ResponseMedia[];
  
  // 使用统计
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * 响应媒体
 */
export interface ResponseMedia {
  type: 'image' | 'video';
  mimeType: string;
  data: string;
}

// ============================================================================
// Chat Options - 聊天选项
// ============================================================================

/**
 * 聊天选项
 */
export interface ChatOptions {
  tools?: MCPTool[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  signal?: AbortSignal;
  
  // 思考模式
  thinkingMode?: boolean;
  thinkingBudget?: number;
  
  // 响应格式
  responseFormat?: {
    type: 'text' | 'json_object';
  };
}

/**
 * 流式回调
 */
export interface StreamCallbacks {
  onContent?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onToolCall?: (toolCall: LLMToolCall) => void;
  onMedia?: (media: ResponseMedia) => void;
  onUsage?: (usage: LLMResponse['usage']) => void;
}

// ============================================================================
// Provider Interface - Provider 接口
// ============================================================================

/**
 * LLM Provider 接口
 */
export interface ILLMProvider {
  /**
   * Provider 类型
   */
  readonly type: LLMProviderType;
  
  /**
   * Provider 名称
   */
  readonly name: string;
  
  /**
   * 非流式聊天
   */
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse>;
  
  /**
   * 流式聊天
   */
  chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
    callbacks: StreamCallbacks
  ): Promise<LLMResponse>;
  
  /**
   * 检查是否支持工具
   */
  supportsTools(): boolean;
  
  /**
   * 检查是否支持流式
   */
  supportsStreaming(): boolean;
  
  /**
   * 检查是否支持视觉
   */
  supportsVision(): boolean;
}

// ============================================================================
// Utility Types - 工具类型
// ============================================================================

/**
 * 工具名称映射
 */
export interface ToolNameMapping {
  original: string;
  normalized: string;
}

/**
 * Provider 元数据
 */
export interface ProviderMetadata {
  type: LLMProviderType;
  name: string;
  version?: string;
  models: string[];
  defaultModel: string;
  capabilities: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
    thinking: boolean;
  };
}

// ============================================================================
// Constants - 常量
// ============================================================================

/**
 * 默认 Provider 配置
 */
export const DEFAULT_PROVIDER_CONFIG: Partial<LLMProviderConfig> = {
  timeout: 60000,
  maxRetries: 3,
};

/**
 * Provider 默认 URL
 */
export const PROVIDER_DEFAULT_URLS: Record<LLMProviderType, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com',
  google: 'https://generativelanguage.googleapis.com',
  ollama: 'http://localhost:11434/api/chat',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  local: 'http://localhost:8080/v1/chat/completions',
};
