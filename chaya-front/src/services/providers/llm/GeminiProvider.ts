/**
 * GeminiProvider - Google Gemini Provider 实现
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
  ResponseMedia,
} from './types';
import { LLMErrorCode } from '../../core/shared/errors';
import { eventBus } from '../../core/shared/events';

/**
 * Gemini Provider
 */
export class GeminiProvider extends BaseProvider {
  readonly type: LLMProviderType = 'gemini';
  readonly name: string = 'Google Gemini';

  /**
   * 非流式聊天
   */
  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    this.emitStart(messages.length);

    try {
      const url = this.buildUrl(false);
      const body = this.buildRequestBody(messages, options);

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
      const url = this.buildUrl(true);
      const body = this.buildRequestBody(messages, options);

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

  /**
   * 是否支持视觉
   */
  supportsVision(): boolean {
    return true; // Gemini 支持多模态
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 构建 URL
   */
  private buildUrl(stream: boolean): string {
    const baseUrl = this.config.apiUrl || 'https://generativelanguage.googleapis.com';
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    return `${baseUrl}/v1beta/models/${this.config.model}:${action}?key=${this.config.apiKey}`;
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(
    messages: LLMMessage[],
    options: ChatOptions
  ): Record<string, unknown> {
    // 分离系统消息
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      contents: this.formatMessages(nonSystemMessages),
      generationConfig: {
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
        ...(options.topP !== undefined && { topP: options.topP }),
        ...(options.stop && { stopSequences: options.stop }),
      },
    };

    // 系统指令
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join('\n\n') }],
      };
    }

    // 工具
    if (options.tools && options.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
    }

    // 思考模式
    if (options.thinkingMode) {
      (body.generationConfig as Record<string, unknown>).thinkingConfig = {
        thinkingBudget: options.thinkingBudget || 10000,
      };
    }

    return body;
  }

  /**
   * 格式化消息（Gemini 格式）
   */
  protected formatMessages(messages: LLMMessage[]): unknown[] {
    const contents: unknown[] = [];

    for (const msg of messages) {
      // 工具结果消息
      if (msg.role === 'tool' && msg.tool_call_id) {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.name || msg.tool_call_id,
                response: { result: msg.content },
              },
            },
          ],
        });
        continue;
      }

      // 带工具调用的助手消息
      if (msg.role === 'assistant' && msg.tool_calls) {
        const parts: unknown[] = [];
        
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        
        for (const tc of msg.tool_calls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}'),
            },
          });
        }
        
        contents.push({ role: 'model', parts });
        continue;
      }

      // 普通消息
      const parts: unknown[] = [];

      if (msg.parts && msg.parts.length > 0) {
        for (const part of msg.parts) {
          if (part.text) {
            parts.push({ text: part.text });
          } else if (part.inlineData) {
            parts.push({
              inlineData: {
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data,
              },
            });
          }
        }
      } else if (msg.content) {
        parts.push({ text: msg.content });
      }

      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    return contents;
  }

  /**
   * 解析响应
   */
  private parseResponse(data: any): LLMResponse {
    const candidate = data.candidates?.[0];
    const content = candidate?.content;
    
    let textContent = '';
    let thinking = '';
    const toolCalls: LLMToolCall[] = [];
    const media: ResponseMedia[] = [];
    let thoughtSignature: string | undefined;

    for (const part of content?.parts || []) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.thought) {
        thinking += part.thought;
      }
      if (part.thoughtSignature) {
        thoughtSignature = part.thoughtSignature;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args),
          },
        });
      }
      if (part.inlineData) {
        media.push({
          type: part.inlineData.mimeType.startsWith('video/') ? 'video' : 'image',
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        });
      }
    }

    return {
      content: textContent,
      thinking: thinking || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: candidate?.finishReason,
      thoughtSignature,
      media: media.length > 0 ? media : undefined,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount || 0,
        completionTokens: data.usageMetadata.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata.totalTokenCount || 0,
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
    const media: ResponseMedia[] = [];
    let finishReason: string | undefined;
    let usage: LLMResponse['usage'] | undefined;
    let thoughtSignature: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // Gemini 返回 JSON 数组
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // 移除数组括号和逗号
          let jsonStr = trimmed;
          if (jsonStr.startsWith('[')) jsonStr = jsonStr.slice(1);
          if (jsonStr.startsWith(',')) jsonStr = jsonStr.slice(1);
          if (jsonStr.endsWith(']')) jsonStr = jsonStr.slice(0, -1);
          if (!jsonStr.trim()) continue;

          try {
            const data = JSON.parse(jsonStr);
            const candidate = data.candidates?.[0];
            const content = candidate?.content;

            for (const part of content?.parts || []) {
              if (part.text) {
                fullContent += part.text;
                callbacks.onContent?.(part.text);
                eventBus.emit('llm:chunk', { content: part.text });
              }
              if (part.thought) {
                fullThinking += part.thought;
                callbacks.onThinking?.(part.thought);
                eventBus.emit('llm:thinking', { content: part.thought });
              }
              if (part.thoughtSignature) {
                thoughtSignature = part.thoughtSignature;
              }
              if (part.functionCall) {
                const toolCall: LLMToolCall = {
                  id: `call_${Date.now()}_${toolCalls.length}`,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args),
                  },
                };
                toolCalls.push(toolCall);
                callbacks.onToolCall?.(toolCall);
                eventBus.emit('llm:tool_call', {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  arguments: part.functionCall.args,
                });
              }
              if (part.inlineData) {
                const mediaItem: ResponseMedia = {
                  type: part.inlineData.mimeType.startsWith('video/') ? 'video' : 'image',
                  mimeType: part.inlineData.mimeType,
                  data: part.inlineData.data,
                };
                media.push(mediaItem);
                callbacks.onMedia?.(mediaItem);
              }
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }

            if (data.usageMetadata) {
              usage = {
                promptTokens: data.usageMetadata.promptTokenCount || 0,
                completionTokens: data.usageMetadata.candidatesTokenCount || 0,
                totalTokens: data.usageMetadata.totalTokenCount || 0,
              };
              callbacks.onUsage?.(usage);
            }
          } catch (e) {
            this.logger.debug('Stream parse error', { line: jsonStr, error: e });
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
      thoughtSignature,
      media: media.length > 0 ? media : undefined,
      usage,
    };
  }
}
