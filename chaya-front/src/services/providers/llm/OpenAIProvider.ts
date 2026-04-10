/**
 * OpenAIProvider - OpenAI/DeepSeek Provider 实现
 * 支持 OpenAI API 兼容的服务（OpenAI、DeepSeek、ModelScope 等）
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
 * OpenAI Provider
 */
export class OpenAIProvider extends BaseProvider {
  readonly type: LLMProviderType = 'openai';
  readonly name: string = 'OpenAI';

  constructor(config: LLMProviderConfig) {
    super(config);
    
    // 根据 URL 调整类型和名称
    if (config.apiUrl?.includes('deepseek')) {
      (this as { type: LLMProviderType }).type = 'deepseek';
      (this as { name: string }).name = 'DeepSeek';
    }
  }

  /**
   * 非流式聊天
   */
  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    this.emitStart(messages.length);

    try {
      const url = this.normalizeUrl(this.config.apiUrl, PROVIDER_DEFAULT_URLS.openai);
      const body = this.buildRequestBody(messages, options, false);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders({
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...(this.config.organizationId && { 'OpenAI-Organization': this.config.organizationId }),
        }),
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
      const url = this.normalizeUrl(this.config.apiUrl, PROVIDER_DEFAULT_URLS.openai);
      const body = this.buildRequestBody(messages, options, true);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders({
          'Authorization': `Bearer ${this.config.apiKey}`,
          ...(this.config.organizationId && { 'OpenAI-Organization': this.config.organizationId }),
        }),
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

    // 可选参数
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options.frequencyPenalty !== undefined) {
      body.frequency_penalty = options.frequencyPenalty;
    }
    if (options.presencePenalty !== undefined) {
      body.presence_penalty = options.presencePenalty;
    }
    if (options.stop) {
      body.stop = options.stop;
    }
    if (options.responseFormat) {
      body.response_format = options.responseFormat;
    }

    // 工具
    if (options.tools && options.tools.length > 0) {
      body.tools = this.convertToolsToOpenAIFormat(options.tools);
      body.tool_choice = 'auto';
    }

    // DeepSeek 思考模式 - 移除不支持的参数
    // DeepSeek 的 reasoning_effort 参数可能不被支持
    if (this.type === 'deepseek' && options.thinkingMode && this.config.model === 'deepseek-reasoner') {
      // DeepSeek reasoning 模型不需要特殊的参数设置
      // 它会自动启用思考模式
    }

    // 流式选项
    if (stream) {
      body.stream_options = { include_usage: true };
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

      if (msg.tool_call_id) {
        formatted.tool_call_id = msg.tool_call_id;
      }
      if (msg.name) {
        formatted.name = msg.name;
      }
      if (msg.tool_calls) {
        formatted.tool_calls = msg.tool_calls;
      }

      // 多模态内容
      if (msg.parts && msg.parts.length > 0) {
        formatted.content = msg.parts.map((part) => {
          if (part.text) {
            return { type: 'text', text: part.text };
          }
          if (part.inlineData) {
            return {
              type: 'image_url',
              image_url: {
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
              },
            };
          }
          return null;
        }).filter(Boolean);
      }

      return formatted;
    });
  }

  /**
   * 解析响应
   */
  private parseResponse(data: any): LLMResponse {
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content || '',
      thinking: message?.reasoning_content, // DeepSeek 思考内容
      tool_calls: this.restoreToolCalls(message?.tool_calls),
      finish_reason: choice?.finish_reason,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
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
    let fullThinking = '';
    let toolCalls: LLMToolCall[] = [];
    let finishReason: string | undefined;
    let usage: LLMResponse['usage'] | undefined;

    // 用于累积工具调用
    const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;
            const choice = data.choices?.[0];

            // 内容
            if (delta?.content) {
              fullContent += delta.content;
              callbacks.onContent?.(delta.content);
              eventBus.emit('llm:chunk', { content: delta.content });
            }

            // DeepSeek 思考内容
            if (delta?.reasoning_content) {
              fullThinking += delta.reasoning_content;
              callbacks.onThinking?.(delta.reasoning_content);
              eventBus.emit('llm:thinking', { content: delta.reasoning_content });
            }

            // 工具调用
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index ?? 0;
                let accumulated = toolCallAccumulator.get(index);
                
                if (!accumulated) {
                  accumulated = { id: tc.id || '', name: '', arguments: '' };
                  toolCallAccumulator.set(index, accumulated);
                }

                if (tc.id) accumulated.id = tc.id;
                if (tc.function?.name) accumulated.name += tc.function.name;
                if (tc.function?.arguments) accumulated.arguments += tc.function.arguments;
              }
            }

            // 完成原因
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // 使用统计
            if (data.usage) {
              usage = {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              };
              callbacks.onUsage?.(usage);
            }
          } catch (e) {
            // 忽略解析错误
            this.logger.debug('Stream parse error', { line: trimmed, error: e });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 转换累积的工具调用
    toolCallAccumulator.forEach((tc) => {
      if (tc.id && tc.name) {
        const toolCall: LLMToolCall = {
          id: tc.id,
          type: 'function',
          function: {
            name: this.restoreToolName(tc.name),
            arguments: tc.arguments,
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
    });

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
      usage,
    };
  }
}
