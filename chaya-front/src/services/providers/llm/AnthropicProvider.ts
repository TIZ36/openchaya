/**
 * AnthropicProvider - Claude Provider 实现
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
 * Anthropic (Claude) Provider
 */
export class AnthropicProvider extends BaseProvider {
  readonly type: LLMProviderType = 'anthropic';
  readonly name: string = 'Anthropic';

  /**
   * 非流式聊天
   */
  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    this.emitStart(messages.length);

    try {
      const url = this.normalizeUrl(this.config.apiUrl, PROVIDER_DEFAULT_URLS.anthropic);
      const body = this.buildRequestBody(messages, options, false);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders({
          'x-api-key': this.config.apiKey || '',
          'anthropic-version': '2023-06-01',
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
      const url = this.normalizeUrl(this.config.apiUrl, PROVIDER_DEFAULT_URLS.anthropic);
      const body = this.buildRequestBody(messages, options, true);

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.createHeaders({
          'x-api-key': this.config.apiKey || '',
          'anthropic-version': '2023-06-01',
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
    // 分离系统消息
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: this.formatMessages(nonSystemMessages),
      max_tokens: options.maxTokens || 4096,
      stream,
    };

    // 系统消息
    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n');
    }

    // 可选参数
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }
    if (options.stop) {
      body.stop_sequences = options.stop;
    }

    // 工具
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    // 思考模式 (Claude 3.5 Sonnet)
    if (options.thinkingMode) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget || 10000,
      };
    }

    return body;
  }

  /**
   * 格式化消息（Anthropic 格式）
   */
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    return messages.map((msg) => {
      // 工具结果消息
      if (msg.role === 'tool') {
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        };
      }

      // 带工具调用的助手消息
      if (msg.role === 'assistant' && msg.tool_calls) {
        const content: unknown[] = [];
        
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
        
        return { role: 'assistant', content };
      }

      // 普通消息
      const formatted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      // 多模态内容
      if (msg.parts && msg.parts.length > 0) {
        formatted.content = msg.parts.map((part) => {
          if (part.text) {
            return { type: 'text', text: part.text };
          }
          if (part.inlineData) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.inlineData.mimeType,
                data: part.inlineData.data,
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
    let content = '';
    let thinking = '';
    const toolCalls: LLMToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        thinking += block.thinking;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content,
      thinking: thinking || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: data.stop_reason,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
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
    const toolCalls: LLMToolCall[] = [];
    let finishReason: string | undefined;
    let usage: LLMResponse['usage'] | undefined;

    // 当前工具调用
    let currentToolUse: { id: string; name: string; input: string } | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));

            switch (data.type) {
              case 'content_block_start':
                if (data.content_block?.type === 'tool_use') {
                  currentToolUse = {
                    id: data.content_block.id,
                    name: data.content_block.name,
                    input: '',
                  };
                }
                break;

              case 'content_block_delta':
                if (data.delta?.type === 'text_delta') {
                  fullContent += data.delta.text;
                  callbacks.onContent?.(data.delta.text);
                  eventBus.emit('llm:chunk', { content: data.delta.text });
                } else if (data.delta?.type === 'thinking_delta') {
                  fullThinking += data.delta.thinking;
                  callbacks.onThinking?.(data.delta.thinking);
                  eventBus.emit('llm:thinking', { content: data.delta.thinking });
                } else if (data.delta?.type === 'input_json_delta' && currentToolUse) {
                  currentToolUse.input += data.delta.partial_json;
                }
                break;

              case 'content_block_stop':
                if (currentToolUse) {
                  const toolCall: LLMToolCall = {
                    id: currentToolUse.id,
                    type: 'function',
                    function: {
                      name: currentToolUse.name,
                      arguments: currentToolUse.input,
                    },
                  };
                  toolCalls.push(toolCall);
                  callbacks.onToolCall?.(toolCall);
                  eventBus.emit('llm:tool_call', {
                    id: toolCall.id,
                    name: toolCall.function.name,
                    arguments: JSON.parse(toolCall.function.arguments || '{}'),
                  });
                  currentToolUse = null;
                }
                break;

              case 'message_delta':
                if (data.delta?.stop_reason) {
                  finishReason = data.delta.stop_reason;
                }
                if (data.usage) {
                  usage = {
                    promptTokens: data.usage.input_tokens || 0,
                    completionTokens: data.usage.output_tokens || 0,
                    totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
                  };
                  callbacks.onUsage?.(usage);
                }
                break;
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
      thinking: fullThinking || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: finishReason,
      usage,
    };
  }
}
