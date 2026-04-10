/**
 * BaseProvider - LLM Provider 抽象基类
 * 提供公共方法和模板方法
 */

import type {
  LLMProviderConfig,
  LLMProviderType,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  MCPTool,
  OpenAIFunction,
  ChatOptions,
  StreamCallbacks,
  ILLMProvider,
  ToolNameMapping,
} from './types';
import { DEFAULT_PROVIDER_CONFIG } from './types';
import { LLMError, LLMErrorCode } from '../../core/shared/errors';
import { createLogger, normalizeToolName, hashString } from '../../core/shared/utils';
import { eventBus } from '../../core/shared/events';

/**
 * LLM Provider 抽象基类
 */
export abstract class BaseProvider implements ILLMProvider {
  protected config: LLMProviderConfig;
  protected logger: ReturnType<typeof createLogger>;
  protected toolNameMap: Map<string, string> = new Map(); // normalized -> original

  abstract readonly type: LLMProviderType;
  abstract readonly name: string;

  constructor(config: LLMProviderConfig) {
    this.config = { ...DEFAULT_PROVIDER_CONFIG, ...config };
    this.logger = createLogger(`LLM:${this.name}`);
  }

  // ============================================================================
  // Abstract Methods - 必须实现的方法
  // ============================================================================

  /**
   * 非流式聊天（子类必须实现）
   */
  abstract chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse>;

  /**
   * 流式聊天（子类必须实现）
   */
  abstract chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
    callbacks: StreamCallbacks
  ): Promise<LLMResponse>;

  // ============================================================================
  // Capability Methods - 能力检查方法
  // ============================================================================

  /**
   * 是否支持工具调用
   */
  supportsTools(): boolean {
    return this.config.modelConfig?.supportsTools ?? true;
  }

  /**
   * 是否支持流式
   */
  supportsStreaming(): boolean {
    return this.config.modelConfig?.supportsStreaming ?? true;
  }

  /**
   * 是否支持视觉
   */
  supportsVision(): boolean {
    return this.config.modelConfig?.supportsVision ?? false;
  }

  // ============================================================================
  // Tool Methods - 工具相关方法
  // ============================================================================

  /**
   * 转换 MCP 工具为 OpenAI 函数格式
   */
  protected convertToolsToOpenAIFormat(tools: MCPTool[]): OpenAIFunction[] {
    this.toolNameMap.clear();

    return tools.map((tool) => {
      const normalized = normalizeToolName(tool.name);
      this.toolNameMap.set(normalized, tool.name);

      return {
        type: 'function' as const,
        function: {
          name: normalized,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      };
    });
  }

  /**
   * 恢复原始工具名称
   */
  protected restoreToolName(normalizedName: string): string {
    return this.toolNameMap.get(normalizedName) || normalizedName;
  }

  /**
   * 恢复工具调用中的原始名称
   */
  protected restoreToolCalls(toolCalls?: LLMToolCall[]): LLMToolCall[] | undefined {
    if (!toolCalls) return undefined;

    return toolCalls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        name: this.restoreToolName(call.function.name),
      },
    }));
  }

  // ============================================================================
  // URL Methods - URL 处理方法
  // ============================================================================

  /**
   * 规范化 API URL
   */
  protected normalizeUrl(userUrl: string | undefined, defaultUrl: string): string {
    if (!userUrl) return defaultUrl;

    try {
      const userUrlObj = new URL(userUrl);
      const defaultUrlObj = new URL(defaultUrl);
      const defaultPath = defaultUrlObj.pathname;
      let userPath = userUrlObj.pathname || '/';

      // 如果用户只提供了 host
      if (!userPath || userPath === '/') {
        return `${userUrlObj.protocol}//${userUrlObj.host}${defaultPath}`;
      }

      // 如果用户 path 是默认 path 的前缀
      const userPathNormalized = userPath.endsWith('/') && userPath !== '/'
        ? userPath.slice(0, -1)
        : userPath;

      if (defaultPath.startsWith(userPathNormalized) && defaultPath !== userPathNormalized) {
        const remainingPath = defaultPath.substring(userPathNormalized.length);
        return `${userUrlObj.protocol}//${userUrlObj.host}${userPath}${remainingPath.startsWith('/') ? remainingPath.substring(1) : remainingPath}`;
      }

      return userUrl;
    } catch {
      return userUrl || defaultUrl;
    }
  }

  // ============================================================================
  // Error Handling - 错误处理
  // ============================================================================

  /**
   * 创建 LLM 错误
   */
  protected createError(
    message: string,
    options: {
      code?: LLMErrorCode;
      statusCode?: number;
      retryable?: boolean;
      cause?: Error;
    } = {}
  ): LLMError {
    return new LLMError(message, this.type, {
      code: options.code,
      model: this.config.model,
      statusCode: options.statusCode,
      retryable: options.retryable,
      cause: options.cause,
    });
  }

  /**
   * 处理 HTTP 响应错误
   */
  protected async handleResponseError(response: Response): Promise<never> {
    let message = `Request failed with status ${response.status}`;
    
    try {
      const errorBody = await response.json();
      message = errorBody.error?.message || errorBody.message || message;
    } catch {
      // 忽略解析错误
    }

    throw LLMError.fromStatusCode(response.status, this.type, message);
  }

  // ============================================================================
  // Event Emission - 事件发送
  // ============================================================================

  /**
   * 发送开始事件
   */
  protected emitStart(messageCount: number): void {
    eventBus.emit('llm:start', {
      provider: this.type,
      model: this.config.model,
      messageCount,
    });
  }

  /**
   * 发送结束事件
   */
  protected emitEnd(finishReason?: string, usage?: LLMResponse['usage']): void {
    eventBus.emit('llm:end', {
      provider: this.type,
      model: this.config.model,
      finishReason,
      usage,
    });
  }

  /**
   * 发送错误事件
   */
  protected emitError(error: Error): void {
    eventBus.emit('llm:error', {
      provider: this.type,
      model: this.config.model,
      error,
    });
  }

  // ============================================================================
  // Request Helpers - 请求辅助方法
  // ============================================================================

  /**
   * 创建请求头
   */
  protected createHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...additionalHeaders,
    };
  }

  /**
   * 带超时的 fetch
   */
  protected async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout?: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = timeout || this.config.timeout || 60000;

    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal || controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================================
  // Message Helpers - 消息辅助方法
  // ============================================================================

  /**
   * 格式化消息（子类可覆盖）
   */
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
      ...(msg.name && { name: msg.name }),
      ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
    }));
  }
}
