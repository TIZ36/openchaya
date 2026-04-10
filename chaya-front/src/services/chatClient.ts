/**
 * 可靠的聊天客户端服务
 * 处理消息发送、接收、重试、超时等异常情况
 */

import { LLMClient, LLMMessage } from './llmClient';
import { MCPTool } from './mcpClient';
import { saveMessage } from './chat';

export interface ChatRequest {
  userMessage: string;
  systemPrompt: string;
  tools?: MCPTool[];
  messageHistory?: LLMMessage[];
  sessionId?: string;
  messageId?: string; // 用于重试时保持相同的消息ID
  model?: string;
}

export interface ChatResponse {
  content: string;
  thinking?: string;
  toolCalls?: any[];
  finishReason?: string;
}

export interface ChatError {
  type: 'network' | 'timeout' | 'api' | 'unknown';
  message: string;
  retryable: boolean; // 是否可重试
  originalError?: Error;
}

export type ChatStatus = 'idle' | 'sending' | 'streaming' | 'completed' | 'error' | 'retrying';

export interface ChatState {
  status: ChatStatus;
  error?: ChatError;
  retryCount: number;
  lastRequest?: ChatRequest;
  abortController?: AbortController;
}

/**
 * 可靠的聊天客户端类
 */
export class ReliableChatClient {
  private llmClient: LLMClient;
  private state: ChatState = {
    status: 'idle',
    retryCount: 0,
  };
  
  // 配置
  private maxRetries = 3; // 最大重试次数
  private retryDelay = 1000; // 重试延迟（毫秒）
  private requestTimeout = 10 * 60 * 1000; // 请求超时（10分钟）
  private streamTimeout = 30 * 1000; // 流式读取超时（30秒）
  
  // 回调函数
  private onStatusChange?: (status: ChatStatus) => void;
  private onError?: (error: ChatError) => void;
  private onRetry?: (retryCount: number) => void;
  
  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }
  
  /**
   * 设置状态变化回调
   */
  setOnStatusChange(callback: (status: ChatStatus) => void) {
    this.onStatusChange = callback;
  }
  
  /**
   * 设置错误回调
   */
  setOnError(callback: (error: ChatError) => void) {
    this.onError = callback;
  }
  
  /**
   * 设置重试回调
   */
  setOnRetry(callback: (retryCount: number) => void) {
    this.onRetry = callback;
  }
  
  /**
   * 更新状态
   */
  private updateStatus(status: ChatStatus, error?: ChatError) {
    this.state.status = status;
    if (error) {
      this.state.error = error;
    }
    this.onStatusChange?.(status);
    if (error) {
      this.onError?.(error);
    }
  }
  
  /**
   * 检测网络状态
   */
  private async checkNetworkStatus(): Promise<boolean> {
    try {
      // 尝试访问一个轻量级端点
      const response = await fetch('https://www.google.com/favicon.ico', {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-cache',
      });
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: any): boolean {
    // 网络错误
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true;
    }
    
    // 超时错误
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      return true;
    }
    
    // 5xx 服务器错误
    if (error.status >= 500 && error.status < 600) {
      return true;
    }
    
    // 429 限流错误
    if (error.status === 429) {
      return true;
    }
    
    // 网络连接错误
    if (error.message?.includes('network') || error.message?.includes('Failed to fetch')) {
      return true;
    }
    
    return false;
  }
  
  /**
   * 创建错误对象
   */
  private createError(error: any): ChatError {
    const isRetryable = this.isRetryableError(error);
    
    let type: ChatError['type'] = 'unknown';
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      type = 'timeout';
    } else if (error.message?.includes('network') || error.message?.includes('Failed to fetch')) {
      type = 'network';
    } else if (error.status || error.message?.includes('API')) {
      type = 'api';
    }
    
    return {
      type,
      message: error.message || String(error),
      retryable: isRetryable,
      originalError: error instanceof Error ? error : new Error(String(error)),
    };
  }
  
  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 发送聊天请求（带重试机制）
   */
  async sendMessage(
    request: ChatRequest,
    stream: boolean = true,
    onChunk?: (content: string, thinking?: string) => void
  ): Promise<ChatResponse> {
    // 保存请求用于重试
    this.state.lastRequest = request;
    
    // 重置状态
    this.state.retryCount = 0;
    this.state.error = undefined;
    
    // 检查网络状态
    const networkOk = await this.checkNetworkStatus();
    if (!networkOk) {
      const error: ChatError = {
        type: 'network',
        message: '网络连接不可用，请检查网络设置',
        retryable: true,
      };
      this.updateStatus('error', error);
      throw error;
    }
    
    // 执行请求（带重试）
    return this.executeWithRetry(request, stream, onChunk);
  }
  
  /**
   * 执行请求（带重试逻辑）
   */
  private async executeWithRetry(
    request: ChatRequest,
    stream: boolean,
    onChunk?: (content: string, thinking?: string) => void
  ): Promise<ChatResponse> {
    let lastError: ChatError | null = null;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        // 如果是重试，更新状态
        if (attempt > 0) {
          this.state.retryCount = attempt;
          this.updateStatus('retrying');
          this.onRetry?.(attempt);
          
          // 指数退避：延迟时间 = retryDelay * 2^(attempt-1)
          const delayMs = this.retryDelay * Math.pow(2, attempt - 1);
          await this.delay(delayMs);
          
          // 再次检查网络
          const networkOk = await this.checkNetworkStatus();
          if (!networkOk) {
            throw new Error('网络连接不可用');
          }
        }
        
        // 更新状态为发送中
        this.updateStatus('sending');
        
        // 创建 AbortController 用于超时控制
        const abortController = new AbortController();
        this.state.abortController = abortController;
        
        // 设置请求超时（使用可重置的超时机制）
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        
        const resetTimeout = () => {
          // 清除旧的超时
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          // 设置新的超时（每次收到响应时重置为0，重新开始计时）
          timeoutId = setTimeout(() => {
            abortController.abort();
          }, this.requestTimeout);
        };
        
        // 初始化超时
        resetTimeout();
        
        try {
          // 调用 LLM 客户端
          const response = await this.llmClient.handleUserRequestWithThinking(
            request.userMessage,
            request.systemPrompt,
            request.tools,
            stream,
            (chunk: string, thinking?: string) => {
              // 每次收到响应（content 或 thinking）时重置超时
              resetTimeout();
              
              // 更新状态为流式接收
              if (this.state.status === 'sending') {
                this.updateStatus('streaming');
              }
              onChunk?.(chunk, thinking);
            },
            request.messageHistory
          );
          
          // 清除超时
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          
          // 更新状态为完成
          this.updateStatus('completed');
          
          // 保存消息到数据库（如果提供了sessionId）
          if (request.sessionId) {
            try {
              await saveMessage(request.sessionId, {
                message_id: request.messageId || `msg-${Date.now()}`,
                role: 'assistant',
                content: response.content,
                thinking: response.thinking,
                model: request.model || 'gpt-4',
              });
            } catch (saveError) {
              console.error('[ChatClient] Failed to save message:', saveError);
              // 保存失败不影响主流程
            }
          }
          
          return {
            content: response.content,
            thinking: response.thinking,
            finishReason: 'stop',
          };
        } finally {
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          this.state.abortController = undefined;
        }
      } catch (error: any) {
        lastError = this.createError(error);
        
        // 如果是最后一次尝试，或者错误不可重试，抛出错误
        if (attempt >= this.maxRetries || !lastError.retryable) {
          this.updateStatus('error', lastError);
          throw lastError;
        }
        
        // 否则继续重试
        console.warn(`[ChatClient] Request failed (attempt ${attempt + 1}/${this.maxRetries + 1}):`, lastError.message);
      }
    }
    
    // 理论上不会到达这里
    throw lastError || new Error('Unknown error');
  }
  
  /**
   * 快速重试（使用上次的请求）
   */
  async quickRetry(stream: boolean = true, onChunk?: (content: string, thinking?: string) => void): Promise<ChatResponse> {
    if (!this.state.lastRequest) {
      throw new Error('No previous request to retry');
    }
    
    // 重置重试计数
    this.state.retryCount = 0;
    
    return this.executeWithRetry(this.state.lastRequest, stream, onChunk);
  }
  
  /**
   * 取消当前请求
   */
  cancel() {
    if (this.state.abortController) {
      this.state.abortController.abort();
      this.state.abortController = undefined;
    }
    this.updateStatus('idle');
  }
  
  /**
   * 获取当前状态
   */
  getState(): ChatState {
    return { ...this.state };
  }
  
  /**
   * 重置状态
   */
  reset() {
    this.cancel();
    this.state = {
      status: 'idle',
      retryCount: 0,
    };
  }
}
