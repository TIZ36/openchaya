/**
 * OllamaProvider - Ollama 本地 LLM Provider 实现
 */

import { BaseProvider } from './BaseProvider';
import type {
  LLMProviderType,
  LLMProviderConfig,
  LLMMessage,
  LLMResponse,
  LLMToolCall,
  ChatOptions,
  StreamCallbacks,
} from './types';
import { PROVIDER_DEFAULT_URLS } from './types';
import { LLMErrorCode } from '../../core/shared/errors';
import { eventBus } from '../../core/shared/events';

/**
 * Ollama Provider
 */
export class OllamaProvider extends BaseProvider {
  readonly type: LLMProviderType = 'ollama';
  readonly name: string = 'Ollama';

  /**
   * 非流式聊天
   */
  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    this.emitStart(messages.length);

    try {
      const url = this.config.apiUrl || PROVIDER_DEFAULT_URLS.ollama;
      const body = this.buildRequestBody(messages, options, false);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders(),
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        await this.handleResponseError(response);
      }

      const data = await response.json();
      const result = this.parseResponse(data);

      this.emitEnd(result.finish_reason, result.usage);
      return result;
    } catch (error) {
      this.emitError(error as Error);
      throw error;
    }
  }

  /**
   * 流式聊天
   */
  async chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
    callbacks: StreamCallbacks
  ): Promise<LLMResponse> {
    this.emitStart(messages.length);

    try {
      const url = this.config.apiUrl || PROVIDER_DEFAULT_URLS.ollama;
      const body = this.buildRequestBody(messages, options, true);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders(),
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        await this.handleResponseError(response);
      }

      const result = await this.processStream(response, callbacks);

      this.emitEnd(result.finish_reason, result.usage);
      return result;
    } catch (error) {
      this.emitError(error as Error);
      throw error;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 构建请求体
   */
  private buildRequestBody(
    messages: LLMMessage[],
    options: ChatOptions,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.formatMessages(messages),
      stream,
    };

    // Ollama 选项
    const ollamaOptions: Record<string, unknown> = {};

    if (options.temperature !== undefined) {
      ollamaOptions.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      ollamaOptions.top_p = options.topP;
    }
    if (options.maxTokens !== undefined) {
      ollamaOptions.num_predict = options.maxTokens;
    }
    if (options.stop) {
      ollamaOptions.stop = options.stop;
    }

    if (Object.keys(ollamaOptions).length > 0) {
      body.options = ollamaOptions;
    }

    // 工具（Ollama 较新版本支持）
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    return body;
  }

  /**
   * 格式化消息
   */
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    return messages.map((msg) => {
      const formatted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      // 多模态内容
      if (msg.parts && msg.parts.length > 0) {
        const images: string[] = [];
        let textContent = '';

        for (const part of msg.parts) {
          if (part.text) {
            textContent += part.text;
          } else if (part.inlineData) {
            images.push(part.inlineData.data);
          }
        }

        formatted.content = textContent;
        if (images.length > 0) {
          formatted.images = images;
        }
      }

      // 工具调用
      if (msg.tool_calls) {
        formatted.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      return formatted;
    });
  }

  /**
   * 解析响应
   */
  private parseResponse(data: any): LLMResponse {
    const message = data.message;

    return {
      content: message?.content || '',
      tool_calls: message?.tool_calls?.map((tc: any) => ({
        id: tc.id || `call_${Date.now()}`,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
        },
      })),
      finish_reason: data.done ? 'stop' : undefined,
      usage: data.prompt_eval_count !== undefined ? {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      } : undefined,
    };
  }

  /**
   * 处理流式响应
   */
  private async processStream(
    response: Response,
    callbacks: StreamCallbacks
  ): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw this.createError('No response body', { code: LLMErrorCode.STREAM_ERROR });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    const toolCalls: LLMToolCall[] = [];
    let finishReason: string | undefined;
    let usage: LLMResponse['usage'] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed);

            // 内容
            if (data.message?.content) {
              fullContent += data.message.content;
              callbacks.onContent?.(data.message.content);
              eventBus.emit('llm:chunk', { content: data.message.content });
            }

            // 工具调用
            if (data.message?.tool_calls) {
              for (const tc of data.message.tool_calls) {
                const toolCall: LLMToolCall = {
                  id: tc.id || `call_${Date.now()}_${toolCalls.length}`,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                      ? tc.function.arguments
                      : JSON.stringify(tc.function.arguments),
                  },
                };
                toolCalls.push(toolCall);
                callbacks.onToolCall?.(toolCall);
                eventBus.emit('llm:tool_call', {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: JSON.parse(toolCall.function.arguments || '{}'),
                });
              }
            }

            // 完成
            if (data.done) {
              finishReason = 'stop';
              
              if (data.prompt_eval_count !== undefined) {
                usage = {
                  promptTokens: data.prompt_eval_count || 0,
                  completionTokens: data.eval_count || 0,
                  totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
                };
                callbacks.onUsage?.(usage);
              }
            }
          } catch (e) {
            this.logger.debug('Stream parse error', { line: trimmed, error: e });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: fullContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
      usage,
    };
  }
}
