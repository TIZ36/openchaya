/**
 * LLM客户端服务
 * 支持多种LLM提供商，并与MCP工具集成
 * 
 * @deprecated 此文件将在未来版本中废弃
 * 请使用新的分层架构:
 * - import { createProvider, ILLMProvider } from './services/providers/llm'
 * - import { LLMMessage, LLMResponse } from './services/providers/llm'
 * 
 * 新架构提供更好的模块化、类型安全和扩展性
 */

import { llmConfigManager, LLMConfig } from './llmConfig';
import { mcpManager, MCPClient, MCPTool } from './mcpClient';
import { GoogleGenAI, Content, Part } from '@google/genai';
import { extractMCPMedia, mightContainMedia, ExtractedMedia } from '../utils/mcpMediaExtractor';
import { getBackendUrl } from '../utils/backendUrl';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  // 多模态内容支持
  parts?: Array<{
    text?: string;
    inlineData?: {
      mimeType: string;
      data: string; // base64 编码的数据
    };
    fileData?: {
      mimeType: string;
      fileUri: string;
    };
    thoughtSignature?: string; // 思维签名（在 part 级别）
  }>;
  // 思维签名（用于 Gemini，整个消息的签名）
  thoughtSignature?: string;
  // 工具调用中的思维签名（用于多步调用）
  // 格式：{ toolCallId: signature }
  toolCallSignatures?: Record<string, string>;
  // DeepSeek 思考模式的推理内容
  reasoning_content?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  thinking?: string; // 思考过程（用于 o1 等思考模型）
  tool_calls?: LLMToolCall[];
  finish_reason?: string;
  thoughtSignature?: string; // 思维签名（用于 Gemini）
  toolCallSignatures?: Record<string, string>; // 工具调用的思维签名映射
  // 多模态输出支持（图片生成等）
  media?: Array<{
    type: 'image' | 'video';
    mimeType: string;
    data: string; // base64 编码的数据
  }>;
}

/**
 * 将MCP工具转换为LLM Function定义
 * 遵循 OpenAI Function Calling API 规范
 */
export function convertMCPToolToLLMFunction(tool: MCPTool): any {
  return {
    type: 'function', // OpenAI API 要求必须包含 type 字段
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * DeepSeek(OpenAI兼容) 对工具名校验更严格：仅允许 [a-zA-Z0-9_-]
 * 这里做一个稳定的规范化，以避免 tools[].function.name 400。
 */
function normalizeToolNameForOpenAI(name: string): string {
  const raw = (name || '').trim();
  let normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  normalized = normalized.replace(/_+/g, '_');
  if (!normalized) normalized = 'tool';

  const maxLen = 64;
  if (normalized.length > maxLen) {
    const suffix = Math.abs(hashString(raw)).toString(36).slice(0, 8);
    normalized = `${normalized.slice(0, maxLen - 9)}_${suffix}`;
  }
  return normalized;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * 规范化 OpenAI 兼容的 API URL
 * 统一处理所有兼容OpenAI的模型URL拼接逻辑：
 * - 如果用户只提供了 host（如 https://api-inference.modelscope.cn），则拼接完整的默认 path
 * - 如果用户提供了部分 path（如 /v1），则拼接剩余部分（如 /chat/completions）
 * - 如果用户提供了完整的 path，则直接使用
 * 
 * @param userUrl 用户提供的 URL（可能只有 host 或部分 path）
 * @param defaultUrl 默认的完整 URL（包含完整 path，如 https://api.openai.com/v1/chat/completions）
 * @returns 规范化后的完整 URL
 */
function normalizeOpenAIUrl(userUrl: string | undefined, defaultUrl: string): string {
  if (!userUrl) {
    return defaultUrl;
  }

  try {
    const userUrlObj = new URL(userUrl);
    const defaultUrlObj = new URL(defaultUrl);

    // 获取默认URL的完整path（如 /v1/chat/completions）
    const defaultPath = defaultUrlObj.pathname;
    
    // 获取用户URL的path（可能为空、/、/v1、/v1/ 等）
    let userPath = userUrlObj.pathname || '/';
    // 规范化：移除尾部的斜杠以便比较（但保留用于拼接）
    const userPathNormalized = userPath.endsWith('/') && userPath !== '/' 
      ? userPath.slice(0, -1) 
      : userPath;
    
    // 如果用户path为空或只有根路径，使用默认的完整path
    if (!userPath || userPath === '/') {
      return `${userUrlObj.protocol}//${userUrlObj.host}${defaultPath}${userUrlObj.search}`;
    }
    
    // 如果用户path是默认path的前缀（如 /v1 是 /v1/chat/completions 的前缀），拼接剩余部分
    // 检查：defaultPath 是否以 userPathNormalized 开头（考虑斜杠）
    if (defaultPath === userPathNormalized) {
      // 完全匹配，直接使用（虽然这种情况应该很少见）
      return userUrl;
    }
    
    // 检查是否是前缀关系（考虑斜杠）
    const isPrefix = defaultPath.startsWith(userPathNormalized + '/') || 
                     defaultPath.startsWith(userPathNormalized);
    
    if (isPrefix && defaultPath !== userPathNormalized) {
      // 提取剩余部分（如 /chat/completions）
      const remainingPath = defaultPath.substring(userPathNormalized.length);
      // 确保拼接正确（避免双斜杠或缺少斜杠）
      let finalPath: string;
      if (userPath.endsWith('/')) {
        // 用户path以斜杠结尾，直接拼接剩余部分（去掉剩余部分开头的斜杠）
        finalPath = `${userPath}${remainingPath.startsWith('/') ? remainingPath.substring(1) : remainingPath}`;
      } else {
        // 用户path不以斜杠结尾，直接拼接剩余部分
        finalPath = `${userPath}${remainingPath}`;
      }
      return `${userUrlObj.protocol}//${userUrlObj.host}${finalPath}${userUrlObj.search}`;
    }
    
    // 如果用户path已经包含完整路径（如 /v1/chat/completions），直接使用
    // 或者用户path与默认path不同但完整，也直接使用（允许自定义路径）
    return userUrl;
  } catch (error) {
    // 如果 URL 解析失败，尝试简单处理
    try {
      const defaultUrlObj = new URL(defaultUrl);
      const defaultPath = defaultUrlObj.pathname;
      
      // 如果用户URL不包含 /v1/chat/completions 这样的完整路径，尝试拼接
      if (!userUrl.includes('/chat/completions') && !userUrl.includes('/messages')) {
        // 检查是否以 /v1 结尾，如果是则拼接剩余部分
        if (userUrl.endsWith('/v1') || userUrl.endsWith('/v1/')) {
          const remainingPath = defaultPath.replace('/v1', '');
          return `${userUrl}${remainingPath}`;
        }
        // 如果URL没有path或path不完整，添加默认path
        if (!userUrl.includes(defaultPath)) {
          return `${userUrl}${defaultPath}`;
        }
      }
    } catch (e) {
      // 如果都失败了，返回用户提供的URL（让fetch来处理错误）
    }
    
    return userUrl;
  }
}

/**
 * LLM客户端类
 */
export class LLMClient {
  private config: LLMConfig;
  private allowedTools: MCPTool[] = []; // 允许使用的工具列表
  private allowedToolNames: Set<string> = new Set(); // 允许使用的工具名称集合
  private onToolStream?: (toolName: string, chunk: any) => void; // 工具流式输出回调
  private toolNameMapLlmToOriginal: Map<string, string> = new Map();
  private toolNameMapOriginalToLlm: Map<string, string> = new Map();

  constructor(config: LLMConfig) {
    this.config = config;
  }
  
  /**
   * 设置允许使用的工具列表
   */
  setAllowedTools(tools: MCPTool[]) {
    this.allowedTools = tools;
    this.allowedToolNames = new Set(tools.map(t => t.name));
  }
  
  /**
   * 设置工具流式输出回调
   */
  setOnToolStream(callback: (toolName: string, chunk: any) => void) {
    this.onToolStream = callback;
  }

  /**
   * 调用LLM API
   * @param messages 消息列表
   * @param tools 工具列表（可选）
   * @param stream 是否使用流式响应（可选，默认false）
   * @param onChunk 流式响应回调函数（可选，接收 content chunk）
   * @param onThinking 思考过程回调函数（可选，用于流式模式下传递 thinking）
   */
  async chat(
    messages: LLMMessage[], 
    tools?: any[], 
    stream: boolean = false,
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    switch (this.config.provider) {
      case 'openai':
      case 'deepseek':  // DeepSeek 使用 OpenAI 兼容 API
        return stream 
          ? this.callOpenAIStream(messages, tools, onChunk, onThinking)
          : this.callOpenAI(messages, tools);
      case 'anthropic':
        return stream
          ? this.callAnthropicStream(messages, tools, onChunk, onThinking)
          : this.callAnthropic(messages, tools);
      case 'ollama':
        return stream
          ? this.callOllamaStream(messages, tools, onChunk, onThinking)
          : this.callOllama(messages, tools);
      case 'gemini':
        return stream
          ? this.callGeminiStream(messages, tools, onChunk, onThinking)
          : this.callGemini(messages, tools);
      case 'local':
        return this.callLocal(messages, tools);
      default:
        throw new Error(`Unsupported LLM provider: ${this.config.provider}`);
    }
  }

  /**
   * 检查是否需要使用代理（外部域名需要代理以避免 CORS）
   */
  private shouldUseProxy(apiUrl: string): boolean {
    try {
      const url = new URL(apiUrl);
      const hostname = url.hostname;
      // 如果是 localhost、127.0.0.1 或同源，不需要代理
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
        return false;
      }
      // 检查是否是当前页面的同源
      if (typeof window !== 'undefined') {
        const currentOrigin = window.location.origin;
        const apiOrigin = `${url.protocol}//${url.host}`;
        if (currentOrigin === apiOrigin) {
          return false;
        }
      }
      // 其他情况使用代理
      return true;
    } catch {
      // URL 解析失败，不使用代理
      return false;
    }
  }

  /**
   * 调用OpenAI API（流式响应）
   */
  private async callOpenAIStream(
    messages: LLMMessage[], 
    tools?: MCPTool[], 
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const defaultUrl = 'https://api.openai.com/v1/chat/completions';
    const apiUrl = normalizeOpenAIUrl(this.config.apiUrl, defaultUrl);
    const model = this.config.model || 'gpt-4';

    console.log(`[LLM] Using OpenAI Stream API URL: ${apiUrl}`);

    // 检查是否需要使用代理（外部域名需要代理以避免 CORS）
    const useProxy = this.shouldUseProxy(apiUrl);
    if (useProxy) {
      console.log(`[LLM] Using backend proxy for external API: ${apiUrl}`);
      return this.callOpenAIStreamViaProxy(apiUrl, messages, tools, onChunk, onThinking);
    }

    const controller = new AbortController();
    // 流式响应需要更长的超时时间（10分钟），因为AI可能需要较长时间生成内容
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    try {
      const openAiTools = tools ? this.prepareToolsForOpenAI(tools) : undefined;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(msg => {
            const message: any = {
              role: msg.role,
              content: msg.content,
            };
            if (msg.tool_call_id) message.tool_call_id = msg.tool_call_id;
            if (msg.name) message.name = msg.name;
            if (msg.tool_calls) message.tool_calls = msg.tool_calls;
            // DeepSeek 思考模式需要 reasoning_content
            if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
            return message;
          }),
          tools: openAiTools,
          tool_choice: openAiTools && openAiTools.length > 0 ? 'auto' : undefined,
          stream: true,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
      }

      // 处理流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullThinking = ''; // 思考过程
      let toolCalls: LLMToolCall[] = [];
      let finishReason: string | undefined;
      let lastChunkTime = Date.now(); // 记录最后一次收到数据的时间

      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      // 设置流式读取的超时保护（如果30秒内没有收到新数据，认为超时）
      const streamTimeoutDuration = 30 * 1000; // 30秒
      let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
      
      const resetStreamTimeout = () => {
        if (streamTimeoutId) {
          clearTimeout(streamTimeoutId);
        }
        streamTimeoutId = setTimeout(() => {
          reader.cancel();
          throw new Error(`Stream timeout: no data received for ${streamTimeoutDuration / 1000}s`);
        }, streamTimeoutDuration);
      };
      
      resetStreamTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // 重置流式读取超时
        resetStreamTimeout();

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              continue;
            }

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              const choice = json.choices?.[0];
              
              // 处理思考过程（o1 模型）
              // reasoning_content 可能在 delta 中流式返回，也可能在 message 中一次性返回
              if (delta?.reasoning_content) {
                fullThinking += delta.reasoning_content;
                // 实时传递思考过程
                onThinking?.(fullThinking);
              } else if (choice?.message?.reasoning_content) {
                // 如果 message 中有完整的 reasoning_content，直接使用
                fullThinking = choice.message.reasoning_content;
                onThinking?.(fullThinking);
              } else if (json.reasoning_content) {
                // 某些情况下可能在根级别
                fullThinking = json.reasoning_content;
                onThinking?.(fullThinking);
              }
              
              if (delta?.content) {
                fullContent += delta.content;
                onChunk?.(delta.content);
              }

              // 处理工具调用
              if (delta?.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  const index = toolCall.index;
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: toolCall.id || '',
                      type: 'function',
                      function: {
                        name: '',
                        arguments: '',
                      },
                    };
                  }
                  if (toolCall.function?.name) {
                    toolCalls[index].function.name = toolCall.function.name;
                  }
                  if (toolCall.function?.arguments) {
                    toolCalls[index].function.arguments += toolCall.function.arguments;
                  }
                }
              }

              if (json.choices?.[0]?.finish_reason) {
                finishReason = json.choices[0].finish_reason;
              }
            } catch (e) {
              // 忽略JSON解析错误
              console.warn('[LLM] Failed to parse SSE chunk:', e);
            }
          }
        }
      }
      
      // 清理流式读取超时
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
      }

      return {
        content: fullContent,
        thinking: fullThinking || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: finishReason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 通过后端代理调用 OpenAI API（流式响应）
   */
  private async callOpenAIStreamViaProxy(
    apiUrl: string,
    messages: LLMMessage[], 
    tools?: MCPTool[],
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    const model = this.config.model || 'gpt-4';
    const openAiTools = tools ? this.prepareToolsForOpenAI(tools) : undefined;

    const backendUrl = getBackendUrl();
    const proxyUrl = `${backendUrl}/api/llm/proxy`;

    const requestBody = {
      api_url: apiUrl,
      api_key: this.config.apiKey,
      headers: {},
      body: {
        model,
        messages: messages.map(msg => {
          const message: any = {
            role: msg.role,
            content: msg.content,
          };
          if (msg.tool_call_id) message.tool_call_id = msg.tool_call_id;
          if (msg.name) message.name = msg.name;
          if (msg.tool_calls) message.tool_calls = msg.tool_calls;
          if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
          return message;
        }),
        tools: openAiTools,
        tool_choice: openAiTools && openAiTools.length > 0 ? 'auto' : undefined,
      },
      stream: true,
    };

    const controller = new AbortController();
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);

    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`LLM Proxy error: ${error.error || response.statusText}`);
      }

      // 处理流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullThinking = '';
      let toolCalls: LLMToolCall[] = [];
      let finishReason: string | undefined;

      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      // 设置流式读取的超时保护（如果30秒内没有收到新数据，认为超时）
      const streamTimeoutDuration = 30 * 1000; // 30秒
      let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const resetStreamTimeout = () => {
        if (streamTimeoutId) {
          clearTimeout(streamTimeoutId);
        }
        streamTimeoutId = setTimeout(() => {
          reader.cancel();
          throw new Error(`Stream timeout: no data received for ${streamTimeoutDuration / 1000}s`);
        }, streamTimeoutDuration);
      };

      resetStreamTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetStreamTimeout();

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              continue;
            }

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;
              const choice = json.choices?.[0];

              // 处理思考过程（o1 模型）
              if (delta?.reasoning_content) {
                fullThinking += delta.reasoning_content;
                console.log(`[LLM Proxy] 收到思考内容 (delta):`, fullThinking.length, '字符');
                onThinking?.(fullThinking);
              } else if (choice?.message?.reasoning_content) {
                fullThinking = choice.message.reasoning_content;
                console.log(`[LLM Proxy] 收到思考内容 (choice.message):`, fullThinking.length, '字符');
                onThinking?.(fullThinking);
              } else if (json.reasoning_content) {
                fullThinking = json.reasoning_content;
                console.log(`[LLM Proxy] 收到思考内容 (json):`, fullThinking.length, '字符');
                onThinking?.(fullThinking);
              }

              if (delta?.content) {
                fullContent += delta.content;
                onChunk?.(delta.content);
              }

              // 处理工具调用
              if (delta?.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  const index = toolCall.index;
                  if (!toolCalls[index]) {
                    toolCalls[index] = {
                      id: toolCall.id || '',
                      type: 'function',
                      function: {
                        name: '',
                        arguments: '',
                      },
                    };
                  }
                  if (toolCall.function?.name) {
                    toolCalls[index].function.name = toolCall.function.name;
                  }
                  if (toolCall.function?.arguments) {
                    toolCalls[index].function.arguments += toolCall.function.arguments;
                  }
                }
              }

              if (json.choices?.[0]?.finish_reason) {
                finishReason = json.choices[0].finish_reason;
              }
            } catch (e) {
              console.warn('[LLM] Failed to parse SSE chunk:', e);
            }
          }
        }
      }

      // 清理流式读取超时
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
      }

      return {
        content: fullContent,
        thinking: fullThinking || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: finishReason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 通过后端代理调用 OpenAI API（非流式响应）
   */
  private async callOpenAIViaProxy(
    apiUrl: string,
    messages: LLMMessage[], 
    tools?: MCPTool[]
  ): Promise<LLMResponse> {
    const model = this.config.model || 'gpt-4';
    const openAiTools = tools ? this.prepareToolsForOpenAI(tools) : undefined;
    
    const backendUrl = getBackendUrl();
    const proxyUrl = `${backendUrl}/api/llm/proxy`;
    
    const requestBody = {
      api_url: apiUrl,
      api_key: this.config.apiKey,
      headers: {},
      body: {
        model,
        messages: messages.map(msg => {
          const message: any = {
            role: msg.role,
            content: msg.content,
          };
          if (msg.tool_call_id) message.tool_call_id = msg.tool_call_id;
          if (msg.name) message.name = msg.name;
          if (msg.tool_calls) message.tool_calls = msg.tool_calls;
          if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
          return message;
        }),
        tools: openAiTools,
        tool_choice: openAiTools && openAiTools.length > 0 ? 'auto' : undefined,
      },
      stream: false,
    };

    const controller = new AbortController();
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`LLM Proxy error: ${error.error || response.statusText}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      
      return {
        content: choice?.message?.content || '',
        thinking: choice?.message?.reasoning_content || undefined,
        tool_calls: choice?.message?.tool_calls || undefined,
        finish_reason: choice?.finish_reason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用OpenAI API（非流式响应）
   */
  private async callOpenAI(messages: LLMMessage[], tools?: MCPTool[]): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    const defaultUrl = 'https://api.openai.com/v1/chat/completions';
    // 规范化 URL：如果用户只提供了 host，保留默认的 path
    const apiUrl = normalizeOpenAIUrl(this.config.apiUrl, defaultUrl);
    const model = this.config.model || 'gpt-4';

    // 检查是否需要使用代理（外部域名需要代理以避免 CORS）
    const useProxy = this.shouldUseProxy(apiUrl);
    if (useProxy) {
      console.log(`[LLM] Using backend proxy for external API: ${apiUrl}`);
      return this.callOpenAIViaProxy(apiUrl, messages, tools);
    }

    console.log(`[LLM] Using API URL: ${apiUrl} (original: ${this.config.apiUrl || 'default'})`);

    // 创建带超时的 fetch
    // 流式响应需要更长的超时时间（10分钟），因为AI可能需要较长时间生成内容
    const controller = new AbortController();
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    try {
      const openAiTools = tools ? this.prepareToolsForOpenAI(tools) : undefined;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map(msg => {
            const message: any = {
              role: msg.role,
              content: msg.content,
            };
            // 只在需要时添加可选字段
            if (msg.tool_call_id) message.tool_call_id = msg.tool_call_id;
            if (msg.name) message.name = msg.name;
            if (msg.tool_calls) message.tool_calls = msg.tool_calls;
            // DeepSeek 思考模式需要 reasoning_content
            if (msg.reasoning_content) message.reasoning_content = msg.reasoning_content;
            return message;
          }),
          tools: openAiTools,
          tool_choice: openAiTools && openAiTools.length > 0 ? 'auto' : undefined,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const choice = data.choices[0];

      return {
        content: choice.message.content || '',
        thinking: choice.message.reasoning_content || undefined, // 思考过程（o1 模型）
        tool_calls: choice.message.tool_calls?.map((tc: any) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
        finish_reason: choice.finish_reason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用Anthropic API（流式响应）
   */
  private async callAnthropicStream(
    messages: LLMMessage[], 
    tools?: any[], 
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const defaultUrl = 'https://api.anthropic.com/v1/messages';
    const apiUrl = normalizeOpenAIUrl(this.config.apiUrl, defaultUrl);
    const model = this.config.model || 'claude-3-5-sonnet-20241022';
    
    console.log(`[LLM] Using Anthropic Stream API URL: ${apiUrl}`);

    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const controller = new AbortController();
    // 流式响应需要更长的超时时间（10分钟）
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemMessages.map(m => m.content).join('\n'),
          messages: conversationMessages.map(msg => ({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          })),
          tools: tools ? tools.map(convertMCPToolToLLMFunction) : undefined,
          stream: true,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
      }

      // 处理流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let toolCalls: LLMToolCall[] = [];
      let finishReason: string | undefined;

      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      // 设置流式读取的超时保护（如果30秒内没有收到新数据，认为超时）
      const streamTimeoutDuration = 30 * 1000; // 30秒
      let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
      
      const resetStreamTimeout = () => {
        if (streamTimeoutId) {
          clearTimeout(streamTimeoutId);
        }
        streamTimeoutId = setTimeout(() => {
          reader.cancel();
          throw new Error(`Stream timeout: no data received for ${streamTimeoutDuration / 1000}s`);
        }, streamTimeoutDuration);
      };
      
      resetStreamTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // 重置流式读取超时
        resetStreamTimeout();

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              continue;
            }

            try {
              const json = JSON.parse(data);
              
              if (json.type === 'content_block_delta' && json.delta?.text) {
                fullContent += json.delta.text;
                onChunk?.(json.delta.text);
              }

              if (json.type === 'content_block_stop') {
                finishReason = 'stop';
              }

              if (json.type === 'message_stop') {
                finishReason = json.stop_reason || 'stop';
              }

              // 处理工具调用
              if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
                const toolUse = json.content_block;
                toolCalls.push({
                  id: toolUse.id,
                  type: 'function',
                  function: {
                    name: toolUse.name,
                    arguments: JSON.stringify(toolUse.input || {}),
                  },
                });
              }
            } catch (e) {
              console.warn('[LLM] Failed to parse SSE chunk:', e);
            }
          }
        }
      }
      
      // 清理流式读取超时
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
      }

      return {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: finishReason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用Anthropic API（非流式响应）
   */
  private async callAnthropic(messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const defaultUrl = 'https://api.anthropic.com/v1/messages';
    // 规范化 URL：如果用户只提供了 host，保留默认的 path
    const apiUrl = normalizeOpenAIUrl(this.config.apiUrl, defaultUrl);
    const model = this.config.model || 'claude-3-5-sonnet-20241022';
    
    console.log(`[LLM] Using API URL: ${apiUrl} (original: ${this.config.apiUrl || 'default'})`);

    // 转换消息格式（Anthropic使用不同的格式）
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    // 创建带超时的 fetch
    // 流式响应需要更长的超时时间（10分钟），因为AI可能需要较长时间生成内容
    const controller = new AbortController();
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemMessages.map(m => m.content).join('\n'),
          messages: conversationMessages.map(msg => ({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          })),
          tools: tools ? tools.map(convertMCPToolToLLMFunction) : undefined,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const content = data.content[0];

      return {
        content: content.text || '',
        tool_calls: content.tool_use ? [{
          id: content.id,
          type: 'function',
          function: {
            name: content.name,
            arguments: JSON.stringify(content.input),
          },
        }] : undefined,
        finish_reason: data.stop_reason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用Ollama API（流式响应）
   */
  private async callOllamaStream(
    messages: LLMMessage[], 
    tools?: any[], 
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    if (!this.config.apiUrl) {
      throw new Error('Ollama 服务器地址未配置');
    }

    let apiUrl: string;
    try {
      const userUrl = new URL(this.config.apiUrl);
      if (userUrl.pathname && userUrl.pathname !== '/' && !userUrl.pathname.includes('/api/chat')) {
        apiUrl = this.config.apiUrl;
      } else {
        userUrl.pathname = '/api/chat';
        apiUrl = userUrl.toString();
      }
    } catch {
      const baseUrl = this.config.apiUrl.replace(/\/+$/, '');
      apiUrl = `${baseUrl}/api/chat`;
    }

    const model = this.config.model || 'llama2';
    console.log(`[LLM] Using Ollama Stream API URL: ${apiUrl}`);

    const controller = new AbortController();
    // 流式响应需要更长的超时时间（10分钟）
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    
    try {
      const requestBody: any = {
        model,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        stream: true,
      };

      if (tools && tools.length > 0) {
        requestBody.tools = tools.map(convertMCPToolToLLMFunction);
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Ollama API error: ${error.error?.message || response.statusText}`);
      }

      // 处理流式响应
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let toolCalls: LLMToolCall[] = [];
      let finishReason: string | undefined;

      if (!reader) {
        throw new Error('Failed to get response stream');
      }

      // 设置流式读取的超时保护（如果30秒内没有收到新数据，认为超时）
      const streamTimeoutDuration = 30 * 1000; // 30秒
      let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
      
      const resetStreamTimeout = () => {
        if (streamTimeoutId) {
          clearTimeout(streamTimeoutId);
        }
        streamTimeoutId = setTimeout(() => {
          reader.cancel();
          throw new Error(`Stream timeout: no data received for ${streamTimeoutDuration / 1000}s`);
        }, streamTimeoutDuration);
      };
      
      resetStreamTimeout();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // 重置流式读取超时
        resetStreamTimeout();

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim() !== '');

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            
            if (json.message?.content) {
              fullContent += json.message.content;
              onChunk?.(json.message.content);
            }

            // 处理工具调用
            if (json.message?.tool_calls) {
              for (const tc of json.message.tool_calls) {
                toolCalls.push({
                  id: tc.id || `call_${Date.now()}_${Math.random()}`,
                  type: tc.type || 'function',
                  function: {
                    name: tc.function?.name || tc.name,
                    arguments: typeof tc.function?.arguments === 'string' 
                      ? tc.function.arguments 
                      : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
                  },
                });
              }
            }

            if (json.done) {
              finishReason = json.done_reason || 'stop';
            }
          } catch (e) {
            // 忽略JSON解析错误
            console.warn('[LLM] Failed to parse Ollama chunk:', e);
          }
        }
      }
      
      // 清理流式读取超时
      if (streamTimeoutId) {
        clearTimeout(streamTimeoutId);
      }

      return {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: finishReason,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用Ollama API（非流式响应）
   * 使用原生 /api/chat 端点
   */
  private async callOllama(messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
    if (!this.config.apiUrl) {
      throw new Error('Ollama 服务器地址未配置');
    }

    // Ollama 使用原生 /api/chat 端点
    // 规范化 URL：如果用户只提供了 host（如 http://10.104.4.16:11434），自动拼接 /api/chat
    let apiUrl: string;
    try {
      const userUrl = new URL(this.config.apiUrl);
      // 如果 URL 已经包含路径，检查是否是 /api/chat 或 /v1/chat/completions
      if (userUrl.pathname && userUrl.pathname !== '/' && !userUrl.pathname.includes('/api/chat')) {
        // 如果用户提供了其他路径，直接使用
        apiUrl = this.config.apiUrl;
      } else {
        // 否则使用 /api/chat
        userUrl.pathname = '/api/chat';
        apiUrl = userUrl.toString();
      }
    } catch {
      // URL 解析失败，尝试简单拼接
      const baseUrl = this.config.apiUrl.replace(/\/+$/, '');
      apiUrl = `${baseUrl}/api/chat`;
    }

    const model = this.config.model || 'llama2';

    console.log(`[LLM] Using Ollama API URL: ${apiUrl} (original: ${this.config.apiUrl || 'default'})`);

    // 创建带超时的 fetch
    // 流式响应需要更长的超时时间（10分钟），因为AI可能需要较长时间生成内容
    const controller = new AbortController();
    const timeoutDuration = 10 * 60 * 1000; // 10分钟
    const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
    
    // 构建请求头，API key 可选（Ollama 通常不需要）
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // 只在有 API key 时添加 Authorization header
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    
    try {
      // 构建请求体，适配 Ollama 的格式
      const requestBody: any = {
        model,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content,
        })),
        stream: false, // 非流式响应
      };

      // Ollama 支持 tools，但需要 stream: false
      if (tools && tools.length > 0) {
        requestBody.tools = tools.map(convertMCPToolToLLMFunction);
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        throw new Error(`Ollama API error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();
      
      // Ollama 响应格式：{ message: { role, content, tool_calls? }, done, ... }
      // 而不是 OpenAI 的 { choices: [{ message }] }
      const ollamaMessage = data.message || {};
      
      return {
        content: ollamaMessage.content || '',
        tool_calls: ollamaMessage.tool_calls?.map((tc: any) => ({
          id: tc.id || `call_${Date.now()}_${Math.random()}`,
          type: tc.type || 'function',
          function: {
            name: tc.function?.name || tc.name,
            arguments: typeof tc.function?.arguments === 'string' 
              ? tc.function.arguments 
              : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
          },
        })),
        finish_reason: data.done_reason || (data.done ? 'stop' : undefined),
      };
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`API request timeout (${timeoutDuration / 1000}s)`);
      }
      throw error;
    }
  }

  /**
   * 调用Gemini API（流式响应）- 使用官方 @google/genai SDK
   */
  private async callGeminiStream(
    messages: LLMMessage[], 
    tools?: any[], 
    onChunk?: (chunk: string) => void,
    onThinking?: (thinking: string) => void
  ): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('Gemini API key not configured');
    }

    const model = this.config.model || 'gemini-2.5-flash';
    console.log(`[LLM] Using Gemini SDK with model: ${model}`);

    try {
      // 初始化 Gemini SDK
      const ai = new GoogleGenAI({ apiKey: this.config.apiKey });
      
      // 转换消息格式为 Gemini 格式
      const contents = this.convertMessagesToGeminiContents(messages);
      
      // 调试日志：检查是否有多模态内容
      for (const content of contents) {
        if (content.parts) {
          for (const part of content.parts) {
            if ((part as any).inlineData) {
              const inlineData = (part as any).inlineData;
              console.log(`[LLM] Gemini 多模态内容: mimeType=${inlineData.mimeType}, data长度=${inlineData.data?.length || 0}`);
            }
          }
        }
      }
      
      // 提取 system 消息作为 systemInstruction
      const systemMessages = messages.filter(m => m.role === 'system');
      const systemInstruction = systemMessages.length > 0
        ? systemMessages.map(m => m.content).join('\n\n')
        : undefined;
      
      // 检查模型是否支持图片生成
      // 支持的图片生成模型名称：
      // - gemini-2.0-flash-exp-image-generation (实验性)
      // - gemini-2.5-flash-image (较新)
      // - 或其他包含 'image' 的模型名称
      const supportsImageGeneration = model.toLowerCase().includes('image');
      
      if (supportsImageGeneration) {
        console.log(`[LLM] 📷 检测到图片生成模型: ${model}`);
        // 验证模型名称是否正确
        const validImageModels = [
          'gemini-2.0-flash-exp-image-generation',
          'gemini-2.5-flash-image',
          'gemini-2.0-flash-exp',
        ];
        const isKnownModel = validImageModels.some(m => model.toLowerCase().includes(m.toLowerCase()));
        if (!isKnownModel) {
          console.warn(`[LLM] ⚠️ 模型名称 "${model}" 可能不正确！`);
          console.warn(`[LLM] ⚠️ 推荐的图片生成模型: ${validImageModels.join(', ')}`);
        }
      }
      
      // 如果是图片生成模式，需要重新转换消息，清理 thoughtSignature
      // 因为图片生成模式不支持 thinking，带有 thoughtSignature 的消息会导致 API 报错
      const finalContents = supportsImageGeneration 
        ? this.convertMessagesToGeminiContents(messages, true) // 清理 thoughtSignature
        : contents;
      
      // 构建配置
      const config: any = {
        systemInstruction: systemInstruction,
      };
      
      if (supportsImageGeneration) {
        // 图片生成模式：启用文本和图片输出，禁用 thinking（图片模型不支持）
        config.responseModalities = ['Text', 'Image'];
        console.log(`[LLM] Gemini 图片生成模式已启用 (responseModalities: ['Text', 'Image'])`);
      } else {
        // 非图片生成模式：配置 thinking
        // 默认禁用 thinking 模式，避免 thought_signature 问题
        // 如果需要 thinking，用户可以在 metadata 中设置 enableThinking: true
        config.thinkingConfig = this.config.metadata?.enableThinking 
          ? { thinkingBudget: this.config.metadata?.thinkingBudget || 1024 }
          : { thinkingBudget: 0 };
        console.log(`[LLM] Gemini thinking mode: ${this.config.metadata?.enableThinking ? 'enabled' : 'disabled'}`);
      }
      
      // 工具列表：可同时启用联网搜索 (Google Search Grounding) 与 MCP/Function 工具
      if (!supportsImageGeneration) {
        config.tools = [];
        if (this.config.metadata?.enableGoogleSearch) {
          config.tools.push({ googleSearch: {} });
          console.log(`[LLM] Gemini 联网搜索 (Google Search Grounding) 已启用`);
        }
        if (tools && tools.length > 0) {
          config.tools.push({
            functionDeclarations: tools.map((tool: any) => {
              if (tool.function) {
                return {
                  name: tool.function.name,
                  description: tool.function.description,
                  parameters: tool.function.parameters,
                };
              }
              return {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              };
            }),
          });
        }
      }
      
      console.log(`[LLM] Gemini 请求配置:`, JSON.stringify(config, null, 2));
      
      // 检查 contents 是否有效
      if (!finalContents || finalContents.length === 0) {
        console.error('[LLM] ❌ Gemini contents 为空，无法发送请求');
        throw new Error('Gemini API error: contents are required - no valid messages to send');
      }
      
      // 确保有用户消息
      const hasUserContent = finalContents.some(c => c.role === 'user' && c.parts && c.parts.length > 0);
      if (!hasUserContent) {
        console.error('[LLM] ❌ Gemini 没有有效的用户消息');
        console.error('[LLM] finalContents:', JSON.stringify(finalContents, null, 2));
        // 如果没有用户消息，添加一个默认消息以避免API错误
        finalContents.push({ role: 'user', parts: [{ text: '请继续' }] });
        console.log('[LLM] ⚠️ 已添加默认用户消息以避免API错误');
      }
      
      // 调用流式 API
      console.log(`[LLM] Gemini 开始流式调用...`);
      console.log(`[LLM] Gemini 请求内容 (contents):`, JSON.stringify(finalContents, (key, value) => {
        // 截断 base64 数据以避免日志过长
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return value.substring(0, 100) + `...(${value.length} chars)`;
        }
        return value;
      }, 2));
      
      const streamingResult = await ai.models.generateContentStream({
        model: model,
        contents: finalContents,
        config: config,
      });
      
      console.log(`[LLM] Gemini generateContentStream 返回成功，开始读取流...`);
      
      let fullContent = '';
      let fullThinking = '';
      let toolCalls: LLMToolCall[] = [];
      let finishReason: string | undefined;
      let thoughtSignature: string | undefined;
      const toolCallSignatures: Record<string, string> = {};
      // 多模态输出（图片等）
      const media: Array<{ type: 'image' | 'video'; mimeType: string; data: string }> = [];
      
      // 处理流式响应
      let chunkIndex = 0;
      for await (const chunk of streamingResult) {
        chunkIndex++;
        // 详细打印每个 chunk 的完整结构
        console.log(`[LLM] Gemini chunk #${chunkIndex} 原始数据:`, JSON.stringify(chunk, (key, value) => {
          // 截断 base64 数据
          if (key === 'data' && typeof value === 'string' && value.length > 100) {
            return value.substring(0, 100) + `...(${value.length} chars)`;
          }
          return value;
        }, 2));
        console.log(`[LLM] Gemini chunk #${chunkIndex}:`, 
          `hasText=${!!chunk.text}`,
          `hasCandidates=${!!chunk.candidates}`,
          chunk.candidates ? `parts=${chunk.candidates[0]?.content?.parts?.length || 0}` : ''
        );
        
        // 处理文本内容
        if (chunk.text) {
          fullContent += chunk.text;
          onChunk?.(chunk.text);
        }
        
        // 处理函数调用和多模态输出
        if (chunk.candidates && chunk.candidates[0]?.content?.parts) {
          const parts = chunk.candidates[0].content.parts;
          // 调试日志：显示 parts 的内容类型
          console.log(`[LLM] Gemini response parts count: ${parts.length}, types: ${parts.map(p => {
            if (p.text) return 'text';
            if (p.functionCall) return 'functionCall';
            if ((p as any).inlineData) return `inlineData(${(p as any).inlineData?.mimeType})`;
            return `unknown(${Object.keys(p).join(',')})`;
          }).join(', ')}`);
          
          for (const part of parts) {
            if (part.functionCall) {
              const toolCallId = part.functionCall.name || `call_${Date.now()}_${Math.random()}`;
              const existingIndex = toolCalls.findIndex(
                tc => tc.function.name === part.functionCall?.name
              );
              
              if (existingIndex < 0) {
                toolCalls.push({
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: part.functionCall.name || '',
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                });
              }
            }
            
            // 处理图片输出（inlineData）
            if ((part as any).inlineData) {
              const inlineData = (part as any).inlineData;
              if (inlineData.mimeType && inlineData.data) {
                const mediaType = inlineData.mimeType.startsWith('video/') ? 'video' : 'image';
                media.push({
                  type: mediaType,
                  mimeType: inlineData.mimeType,
                  data: inlineData.data,
                });
                console.log(`[LLM] Gemini 返回了 ${mediaType}: mimeType=${inlineData.mimeType}, 大小=${Math.round(inlineData.data.length / 1024)}KB`);
              }
            }
            
            // 处理思维签名（如果有）
            if ((part as any).thoughtSignature) {
              thoughtSignature = (part as any).thoughtSignature;
            }
          }
        }
        
        // 处理完成原因
        if (chunk.candidates && chunk.candidates[0]?.finishReason) {
          finishReason = chunk.candidates[0].finishReason;
        }
      }

      console.log(`[LLM] Gemini 流式响应完成: content长度=${fullContent.length}, media数量=${media.length}, toolCalls数量=${toolCalls.length}, chunkIndex=${chunkIndex}`);
      
      // 如果没有收到任何内容，打印警告
      if (fullContent.length === 0 && media.length === 0 && toolCalls.length === 0) {
        console.warn(`[LLM] ⚠️ Gemini 返回了空响应！总共收到 ${chunkIndex} 个 chunks`);
        console.warn(`[LLM] ⚠️ finishReason: ${finishReason}`);
      }
      
      const result = {
        content: fullContent,
        thinking: fullThinking || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: finishReason,
        thoughtSignature: thoughtSignature,
        toolCallSignatures: Object.keys(toolCallSignatures).length > 0 ? toolCallSignatures : undefined,
        media: media.length > 0 ? media : undefined,
      };
      
      console.log(`[LLM] Gemini 最终响应:`, JSON.stringify(result, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return value.substring(0, 100) + `...(${value.length} chars)`;
        }
        return value;
      }, 2));
      
      return result;
    } catch (error: any) {
      console.error('[LLM] ❌ Gemini 流式 API error:', error);
      console.error('[LLM] ❌ error.message:', error.message);
      console.error('[LLM] ❌ error.stack:', error.stack);
      
      // 打印请求上下文信息，帮助调试
      console.error('[LLM] ❌ 请求上下文:');
      console.error('[LLM]   - model:', model);
      console.error('[LLM]   - supportsImageGeneration:', model.toLowerCase().includes('image'));
      console.error('[LLM]   - messages count:', messages.length);
      
      // 检查是否是特定的错误类型
      if (error.message?.includes('500') || error.message?.includes('INTERNAL')) {
        console.error('[LLM] ❌ 这是 Gemini 服务器内部错误 (500)，可能的原因:');
        console.error('[LLM]   1. 模型名称不正确 - 当前使用: ' + model);
        console.error('[LLM]   2. 图片生成模型需要特定的模型名称，如: gemini-2.0-flash-exp-image-generation');
        console.error('[LLM]   3. 请求内容格式不正确');
        console.error('[LLM]   4. Gemini 服务暂时不可用');
        console.error('[LLM]   5. responseModalities 配置可能有问题');
      }
      
      throw new Error(`Gemini API error: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * 调用Gemini API（非流式响应）- 使用官方 @google/genai SDK
   */
  private async callGemini(messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      throw new Error('Gemini API key not configured');
    }

    const model = this.config.model || 'gemini-2.5-flash';
    console.log(`[LLM] Using Gemini SDK with model: ${model}`);

    try {
      // 初始化 Gemini SDK
      const ai = new GoogleGenAI({ apiKey: this.config.apiKey });
      
      // 转换消息格式为 Gemini 格式
      const contents = this.convertMessagesToGeminiContents(messages);
      
      // 提取 system 消息作为 systemInstruction
      const systemMessages = messages.filter(m => m.role === 'system');
      const systemInstruction = systemMessages.length > 0
        ? systemMessages.map(m => m.content).join('\n\n')
        : undefined;
      
      // 检查模型是否支持图片生成
      const supportsImageGeneration = model.toLowerCase().includes('image');
      
      if (supportsImageGeneration) {
        console.log(`[LLM] 📷 [非流式] 检测到图片生成模型: ${model}`);
        const validImageModels = [
          'gemini-2.0-flash-exp-image-generation',
          'gemini-2.5-flash-image',
          'gemini-2.0-flash-exp',
        ];
        const isKnownModel = validImageModels.some(m => model.toLowerCase().includes(m.toLowerCase()));
        if (!isKnownModel) {
          console.warn(`[LLM] ⚠️ 模型名称 "${model}" 可能不正确！推荐: ${validImageModels.join(', ')}`);
        }
      }
      
      // 如果是图片生成模式，需要重新转换消息，清理 thoughtSignature
      const finalContents = supportsImageGeneration 
        ? this.convertMessagesToGeminiContents(messages, true) // 清理 thoughtSignature
        : contents;
      
      // 构建配置
      const config: any = {
        systemInstruction: systemInstruction,
      };
      
      if (supportsImageGeneration) {
        // 图片生成模式：启用文本和图片输出，禁用 thinking（图片模型不支持）
        config.responseModalities = ['Text', 'Image'];
        console.log(`[LLM] Gemini 图片生成模式已启用 (responseModalities: ['Text', 'Image'])`);
      } else {
        // 非图片生成模式：配置 thinking
        config.thinkingConfig = this.config.metadata?.enableThinking 
          ? { thinkingBudget: this.config.metadata?.thinkingBudget || 1024 }
          : { thinkingBudget: 0 };
      }
      
      // 工具列表：可同时启用联网搜索与 MCP/Function 工具
      if (!supportsImageGeneration) {
        config.tools = [];
        if (this.config.metadata?.enableGoogleSearch) {
          config.tools.push({ googleSearch: {} });
          console.log(`[LLM] Gemini 联网搜索 (Google Search Grounding) 已启用`);
        }
        if (tools && tools.length > 0) {
          config.tools.push({
            functionDeclarations: tools.map((tool: any) => {
              if (tool.function) {
                return {
                  name: tool.function.name,
                  description: tool.function.description,
                  parameters: tool.function.parameters,
                };
              }
              return {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              };
            }),
          });
        }
      }
      
      // 调用非流式 API
      console.log(`[LLM] Gemini 开始非流式调用...`);
      console.log(`[LLM] Gemini 请求内容 (contents):`, JSON.stringify(finalContents, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return value.substring(0, 100) + `...(${value.length} chars)`;
        }
        return value;
      }, 2));
      
      const response = await ai.models.generateContent({
        model: model,
        contents: finalContents,
        config: config,
      });
      
      console.log(`[LLM] Gemini 非流式响应原始数据:`, JSON.stringify(response, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return value.substring(0, 100) + `...(${value.length} chars)`;
        }
        return value;
      }, 2));
      
      let fullContent = '';
      let toolCalls: LLMToolCall[] = [];
      let thoughtSignature: string | undefined;
      const toolCallSignatures: Record<string, string> = {};
      // 多模态输出（图片等）
      const media: Array<{ type: 'image' | 'video'; mimeType: string; data: string }> = [];
      
      // 处理响应文本
      if (response.text) {
        fullContent = response.text;
        console.log(`[LLM] Gemini 响应文本: ${response.text.substring(0, 200)}${response.text.length > 200 ? '...' : ''}`);
      } else {
        console.log(`[LLM] Gemini 响应没有文本内容`);
      }
      
      // 处理函数调用、图片输出和其他内容
      if (response.candidates && response.candidates[0]?.content?.parts) {
        const parts = response.candidates[0].content.parts;
        // 调试日志：显示 parts 的内容类型
        console.log(`[LLM] Gemini response parts count: ${parts.length}, types: ${parts.map(p => {
          if (p.text) return 'text';
          if (p.functionCall) return 'functionCall';
          if ((p as any).inlineData) return `inlineData(${(p as any).inlineData?.mimeType})`;
          return `unknown(${Object.keys(p).join(',')})`;
        }).join(', ')}`);
        
        for (const part of parts) {
          if (part.functionCall) {
            const toolCallId = part.functionCall.name || `call_${Date.now()}`;
            toolCalls.push({
              id: toolCallId,
              type: 'function',
              function: {
                name: part.functionCall.name || '',
                arguments: JSON.stringify(part.functionCall.args || {}),
              },
            });
          }
          
          // 处理图片输出（inlineData）
          if ((part as any).inlineData) {
            const inlineData = (part as any).inlineData;
            if (inlineData.mimeType && inlineData.data) {
              const mediaType = inlineData.mimeType.startsWith('video/') ? 'video' : 'image';
              media.push({
                type: mediaType,
                mimeType: inlineData.mimeType,
                data: inlineData.data,
              });
              console.log(`[LLM] Gemini 返回了 ${mediaType}: mimeType=${inlineData.mimeType}, 大小=${Math.round(inlineData.data.length / 1024)}KB`);
            }
          }
          
          // 处理思维签名（如果有）
          if ((part as any).thoughtSignature) {
            thoughtSignature = (part as any).thoughtSignature;
          }
        }
      }

      // 如果没有收到任何内容，打印警告
      if (fullContent.length === 0 && media.length === 0 && toolCalls.length === 0) {
        console.warn(`[LLM] ⚠️ Gemini 非流式返回了空响应！`);
        console.warn(`[LLM] ⚠️ finishReason: ${response.candidates?.[0]?.finishReason}`);
        console.warn(`[LLM] ⚠️ candidates: ${JSON.stringify(response.candidates)}`);
      }
      
      const result = {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        finish_reason: response.candidates?.[0]?.finishReason,
        thoughtSignature: thoughtSignature,
        toolCallSignatures: Object.keys(toolCallSignatures).length > 0 ? toolCallSignatures : undefined,
        media: media.length > 0 ? media : undefined,
      };
      
      console.log(`[LLM] Gemini 非流式最终响应:`, JSON.stringify(result, (key, value) => {
        if (key === 'data' && typeof value === 'string' && value.length > 100) {
          return value.substring(0, 100) + `...(${value.length} chars)`;
        }
        return value;
      }, 2));
      
      return result;
    } catch (error: any) {
      console.error('[LLM] ❌ Gemini 非流式 API error:', error);
      console.error('[LLM] ❌ error.message:', error.message);
      console.error('[LLM] ❌ error.stack:', error.stack);
      
      // 打印请求上下文信息
      console.error('[LLM] ❌ 请求上下文:');
      console.error('[LLM]   - model:', model);
      console.error('[LLM]   - supportsImageGeneration:', model.toLowerCase().includes('image'));
      
      if (error.message?.includes('500') || error.message?.includes('INTERNAL')) {
        console.error('[LLM] ❌ Gemini 500 错误，可能原因:');
        console.error('[LLM]   1. 模型名称不正确: ' + model);
        console.error('[LLM]   2. 正确的图片生成模型名称: gemini-2.0-flash-exp-image-generation');
      }
      
      throw new Error(`Gemini API error: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * 将 LLMMessage 格式转换为 Gemini SDK 的 Content 格式
   * @param messages 消息列表
   * @param stripThoughtSignatures 是否清理 thoughtSignature（图片生成模式需要）
   */
  private convertMessagesToGeminiContents(messages: LLMMessage[], stripThoughtSignatures: boolean = false): Content[] {
    console.log(`[LLM] convertMessagesToGeminiContents: 输入 ${messages.length} 条消息, stripThoughtSignatures=${stripThoughtSignatures}`);
    
    const contents: Content[] = [];
    let currentUserParts: Part[] = [];
    
    // 如果是图片生成模式，只保留最近的消息，避免 thought_signature 冲突
    // Gemini 图片生成模式不支持 thinking，如果历史消息中有 thinking 相关内容会导致 API 报错
    let processMessages = messages;
    if (stripThoughtSignatures) {
      // 找到最后一条用户消息的索引
      const lastUserIndex = messages.findLastIndex(m => m.role === 'user');
      if (lastUserIndex >= 0) {
        // 只保留 system 消息和最后一条用户消息
        processMessages = messages.filter((m, i) => m.role === 'system' || i === lastUserIndex);
        console.log(`[LLM] 图片生成模式: 简化历史消息，从 ${messages.length} 条减少到 ${processMessages.length} 条`);
      }
    }
    
    // 详细打印每条消息
    console.log(`[LLM] processMessages 详情:`);
    for (let i = 0; i < processMessages.length; i++) {
      const msg = processMessages[i];
      console.log(`[LLM]   [${i}] role=${msg.role}, content长度=${msg.content?.length || 0}, parts数量=${msg.parts?.length || 0}`);
      if (msg.parts && msg.parts.length > 0) {
        for (let j = 0; j < msg.parts.length; j++) {
          const part = msg.parts[j];
          console.log(`[LLM]     parts[${j}]: hasText=${!!part.text}, hasInlineData=${!!part.inlineData}`);
        }
      }
    }
    
    for (const msg of processMessages) {
      // 跳过 system 消息（它们会在调用 API 时作为 systemInstruction 处理）
      if (msg.role === 'system') {
        continue;
      }
      
      if (msg.role === 'user') {
        // 如果之前有累积的 user parts，先提交
        if (currentUserParts.length > 0) {
          contents.push({ role: 'user', parts: currentUserParts });
          currentUserParts = [];
        }
        
        // 处理多模态内容
        if (msg.parts && msg.parts.length > 0) {
          console.log(`[LLM] 处理用户消息的 ${msg.parts.length} 个 parts`);
          for (const part of msg.parts) {
            if (part.text && part.text.trim()) {
              currentUserParts.push({ text: part.text });
              console.log(`[LLM]   添加文本 part: ${part.text.substring(0, 50)}...`);
            }
            
            if (part.inlineData) {
              currentUserParts.push({
                inlineData: {
                  mimeType: part.inlineData.mimeType,
                  data: part.inlineData.data,
                },
              } as Part);
              console.log(`[LLM]   添加 inlineData part: mimeType=${part.inlineData.mimeType}, data长度=${part.inlineData.data?.length || 0}`);
            }
          }
        } else if (msg.content && msg.content.trim()) {
          currentUserParts.push({ text: msg.content });
          console.log(`[LLM] 处理用户消息 content: ${msg.content.substring(0, 50)}...`);
        } else {
          console.warn(`[LLM] ⚠️ 用户消息既没有有效 parts 也没有 content!`);
          console.warn(`[LLM]   msg.parts: ${JSON.stringify(msg.parts)}`);
          console.warn(`[LLM]   msg.content: "${msg.content}"`);
          // 添加一个占位文本以避免空消息
          currentUserParts.push({ text: '请继续执行任务' });
        }
      } else if (msg.role === 'assistant') {
        // 如果之前有累积的 user parts，先提交
        if (currentUserParts.length > 0) {
          contents.push({ role: 'user', parts: currentUserParts });
          currentUserParts = [];
        }
        
        const modelParts: Part[] = [];
        
        // 处理文本内容
        if (msg.content) {
          modelParts.push({ text: msg.content });
        }
        
        // 处理工具调用
        if (msg.tool_calls) {
          for (const toolCall of msg.tool_calls) {
            try {
              const args = JSON.parse(toolCall.function.arguments || '{}');
              modelParts.push({
                functionCall: {
                  name: toolCall.function.name,
                  args: args,
                },
              } as Part);
            } catch (e) {
              console.warn('[LLM] Failed to parse tool call arguments:', e);
            }
          }
        }
        
        if (modelParts.length > 0) {
          contents.push({ role: 'model', parts: modelParts });
        }
      } else if (msg.role === 'tool') {
        // 工具响应
        try {
          const response = JSON.parse(msg.content || '{}');
          currentUserParts.push({
            functionResponse: {
              name: msg.name || '',
              response: response,
            },
          } as Part);
        } catch (e) {
          console.warn('[LLM] Failed to parse tool response:', e);
          currentUserParts.push({
            functionResponse: {
              name: msg.name || '',
              response: { error: msg.content || 'Unknown error' },
            },
          } as Part);
        }
      }
    }
    
    // 处理剩余的 user parts
    if (currentUserParts.length > 0) {
      contents.push({ role: 'user', parts: currentUserParts });
    }
    
    // 打印最终的 contents 数组摘要
    console.log(`[LLM] convertMessagesToGeminiContents 结果: ${contents.length} 条消息`);
    for (let i = 0; i < contents.length; i++) {
      const c = contents[i];
      console.log(`[LLM]   [${i}] role=${c.role}, parts数量=${c.parts?.length || 0}`);
    }
    
    // 如果 contents 为空或者没有用户消息，打印警告
    if (contents.length === 0) {
      console.warn(`[LLM] ⚠️ convertMessagesToGeminiContents 返回空数组！`);
    }
    const hasUserMessage = contents.some(c => c.role === 'user');
    if (!hasUserMessage) {
      console.warn(`[LLM] ⚠️ convertMessagesToGeminiContents 结果中没有用户消息！`);
    }
    
    return contents;
  }
  

  /**
   * 调用本地模型（需要用户自己实现）
   */
  private async callLocal(messages: LLMMessage[], tools?: any[]): Promise<LLMResponse> {
    // 本地模型需要用户自己实现API端点
    if (!this.config.apiUrl) {
      throw new Error('Local model API URL not configured');
    }

    const response = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        tools,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }

  /**
   * 执行工具调用
   * 
   * 优化：直接尝试调用工具，不先列出工具列表
   * 这样可以避免重复的 listTools 调用和 schema 验证问题
   */
  async executeToolCall(toolCall: LLMToolCall): Promise<any> {
    const llmName = toolCall.function.name;
    const name = this.toolNameMapLlmToOriginal.get(llmName) ?? llmName;
    const { arguments: argsStr } = toolCall.function;
    const args = JSON.parse(argsStr);

    console.log(`[LLM] Executing tool call: ${name}`);
    console.log(`[LLM] Arguments:`, args);

    // 如果设置了允许的工具列表，检查工具是否在允许列表中
    if (this.allowedToolNames.size > 0 && !this.allowedToolNames.has(name)) {
      throw new Error(`Tool ${name} is not in the allowed tools list. Allowed tools: ${Array.from(this.allowedToolNames).join(', ')}`);
    }

    // 获取所有 MCP 客户端（包括并发连接）
    const clients = mcpManager.getAllClients();
    
    // 尝试在每个客户端上调用工具
    // 第一个成功的调用将被返回
    const errors: Error[] = [];
    
    for (const client of clients.values()) {
      try {
        // 如果设置了允许的工具列表，先检查该客户端是否有这个工具
        if (this.allowedToolNames.size > 0) {
          const clientTools = await client.listTools();
          const hasTool = clientTools.some(t => t.name === name);
          if (!hasTool) {
            console.log(`[LLM] Tool ${name} not found on ${client.getServerInfo().name}, skipping`);
            continue;
          }
        }
        
        console.log(`[LLM] Trying to call ${name} on ${client.getServerInfo().name}`);
        
        // 设置流式输出回调
        const streamCallback = this.onToolStream 
          ? (chunk: any) => {
              this.onToolStream!(name, chunk);
            }
          : undefined;
        
        const result = await client.callTool(name, args, streamCallback);
        console.log(`[LLM] Tool ${name} executed successfully`);
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn(`[LLM] Failed to call ${name} on ${client.getServerInfo().name}: ${err.message}`);
        errors.push(err);
      }
    }

    // 如果所有客户端都失败了
    if (errors.length > 0) {
      throw new Error(`Tool ${name} failed on all MCP servers. Last error: ${errors[errors.length - 1].message}`);
    } else {
      throw new Error(`Tool ${name} not found in any MCP server (no clients available)`);
    }
  }

  /**
   * 处理用户请求（自动调用MCP工具）
   * @param userInput 用户输入
   * @param systemPrompt 系统提示词（可选）
   * @param tools MCP工具列表（可选，如果不提供则不使用MCP工具）
   * @param stream 是否使用流式响应（可选，默认false）
   * @param onChunk 流式响应回调函数（可选，接收 content 和 thinking）
   */
  async handleUserRequest(
    userInput: string, 
    systemPrompt?: string, 
    tools?: MCPTool[],
    stream: boolean = false,
    onChunk?: (chunk: string, thinking?: string) => void
  ): Promise<string> {
    // 只有在明确传入工具列表时才使用MCP工具
    // 如果未传入工具列表，则不获取MCP客户端，避免不必要的连接
    const allTools: MCPTool[] = tools || [];
    
    // 设置允许使用的工具列表（用于限制executeToolCall只使用这些工具）
    this.setAllowedTools(allTools);

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt || (allTools.length > 0 
          ? `你是一个智能助手，可以使用以下工具帮助用户：
${allTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

当用户需要执行操作时，使用相应的工具。`
          : '你是一个智能助手，可以帮助用户完成各种任务。'),
      },
      {
        role: 'user',
        content: userInput,
      },
    ];

    // 增加迭代次数限制，并添加总时间限制（5分钟）
    let maxIterations = 10; // 从5次增加到10次
    let iteration = 0;
    const startTime = Date.now();
    const maxDuration = 5 * 60 * 1000; // 5分钟总超时

    while (iteration < maxIterations) {
      // 检查总时间是否超时
      if (Date.now() - startTime > maxDuration) {
        console.warn(`[LLM] Request timeout after ${maxDuration}ms (${iteration} iterations)`);
        return '处理超时，请重试。';
      }
      
      // 注意：handleUserRequest 方法不支持 thinking，只返回 content
      // 如果需要 thinking，请使用 handleUserRequestWithThinking
      const response = await this.chat(
        messages, 
        allTools.length > 0 ? allTools : undefined,
        stream,
        stream ? (chunk: string) => {
          // 流式模式下，onChunk 只接收 content
          onChunk?.(chunk);
        } : undefined,
        undefined // handleUserRequest 不支持 thinking
      );

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 添加 assistant 消息（包含 tool_calls 和 reasoning_content）
        const assistantMsg: LLMMessage = {
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
        };
        // DeepSeek 思考模式需要 reasoning_content
        if (response.thinking) {
          assistantMsg.reasoning_content = response.thinking;
        }
        messages.push(assistantMsg);

        // 执行工具调用
        const toolResults = await Promise.all(
          response.tool_calls.map(async (toolCall) => {
            try {
              console.log(`[LLM] Executing tool: ${toolCall.function.name}`);
              const result = await this.executeToolCall(toolCall);
              console.log(`[LLM] Tool result:`, result);
              return {
                tool_call_id: toolCall.id,
                role: 'tool' as const,
                name: toolCall.function.name,
                content: JSON.stringify(result),
              };
            } catch (error: any) {
              console.error(`[LLM] Tool execution error:`, error);
              return {
                tool_call_id: toolCall.id,
                role: 'tool' as const,
                name: toolCall.function.name,
                content: JSON.stringify({ error: error.message }),
              };
            }
          })
        );

        // 添加工具结果
        messages.push(...toolResults);

        iteration++;
      } else {
        // 没有工具调用，返回最终回复
        // 注意：这里只返回 content，thinking 需要通过其他方式传递
        // 由于返回类型是 string，我们需要修改返回类型或使用其他方式
        return response.content;
      }
    }

    return '处理超时，请重试。';
  }

  /**
   * MCP 调用信息，用于传递给回调
   */
  public static MCPCallInfo = {
    toolName: '',
    arguments: null as any,
    result: null as any,
    status: 'pending' as 'pending' | 'running' | 'completed' | 'error',
    duration: 0,
    mcpServer: '',
  };

  /**
   * 处理用户请求（返回完整响应，包括思考过程）
   * 用于需要获取思考过程的场景
   */
  async handleUserRequestWithThinking(
    userInput: string, 
    systemPrompt?: string, 
    tools?: MCPTool[],
    stream: boolean = false,
    onChunk?: (content: string, thinking?: string) => void,
    messageHistory?: LLMMessage[], // 添加消息历史参数
    onStepChange?: (step: string) => void, // 添加步骤变化回调
    onMCPCall?: (info: { toolName: string; arguments: any; result?: any; status: 'pending' | 'running' | 'completed' | 'error'; duration?: number; mcpServer?: string; error?: string; extractedMedia?: ExtractedMedia[] }) => void // MCP 调用回调
  ): Promise<{ content: string; thinking?: string; thoughtSignature?: string; toolCallSignatures?: Record<string, string>; media?: Array<{ type: 'image' | 'video' | 'audio'; mimeType: string; data: string }> }> {
    // 设置允许使用的工具列表
    const allTools: MCPTool[] = tools || [];
    this.setAllowedTools(allTools);

    // 构建消息数组：系统消息 + 历史消息 + 当前用户消息
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: systemPrompt || (allTools.length > 0 
          ? `你是一个智能助手，可以使用以下工具帮助用户：
${allTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

当用户需要执行操作时，使用相应的工具。`
          : '你是一个智能助手，可以帮助用户完成各种任务。'),
      },
    ];
    
    // 如果有历史消息，添加到消息数组中（排除系统消息）
    if (messageHistory && messageHistory.length > 0) {
      const historyMessages = messageHistory.filter(msg => msg.role !== 'system');
      messages.push(...historyMessages);
    }
    
    // 添加当前用户消息（支持多模态）
    // 注意：如果 messageHistory 中已经包含了用户消息（包含多模态内容），这里不需要重复添加
    // 检查最后一条消息是否是用户消息
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      // 如果没有用户消息，添加新的用户消息
    messages.push({
      role: 'user',
      content: userInput,
    });
    } else if (lastMessage.role === 'user' && !lastMessage.parts) {
      // 如果最后一条消息是用户消息但没有多模态内容，更新内容
      lastMessage.content = userInput;
    }
    // 如果最后一条消息已经是用户消息且包含多模态内容，则不需要添加（已在 messageHistory 中）

    let maxIterations = 10;
    let iteration = 0;
    const startTime = Date.now();
    const maxDuration = 5 * 60 * 1000;

    let accumulatedThinking = ''; // 移到循环外部，确保在多次迭代中保持
    const accumulatedMedia: ExtractedMedia[] = []; // 累积提取的媒体
    
    while (iteration < maxIterations) {
      if (Date.now() - startTime > maxDuration) {
        console.warn(`[LLM] Request timeout after ${maxDuration}ms (${iteration} iterations)`);
        return { content: '处理超时，请重试。', thinking: accumulatedThinking || undefined };
      }
      
      // 创建一个包装的 onThinking，用于在流式模式下传递 thinking
      const wrappedOnThinking = stream ? (thinking: string) => {
        console.log(`[LLM] onThinking 回调被调用，思考内容长度:`, thinking.length);
        accumulatedThinking = thinking;
        // 思考过程流式更新时，立即通过 onChunk 传递（传递空 content，只更新 thinking）
        onChunk?.('', thinking);
      } : undefined;
      
      // 创建一个包装的 onChunk，用于在流式模式下传递 content 和 thinking
      const wrappedOnChunk = stream ? (chunk: string) => {
        // 在流式模式下，每次收到 content chunk 时，同时传递当前的 thinking
        onChunk?.(chunk, accumulatedThinking || undefined);
      } : undefined;
      
      console.log(`[LLM] handleUserRequestWithThinking 调用 chat(), provider=${this.config.provider}, model=${this.config.model}, stream=${stream}, iteration=${iteration}`);
      
      const response = await this.chat(
        messages, 
        allTools.length > 0 ? allTools : undefined,
        stream,
        wrappedOnChunk,
        wrappedOnThinking
      );
      
      // 详细打印响应（用于调试）
      console.log(`[LLM] handleUserRequestWithThinking chat() 返回:`, {
        hasContent: !!response.content,
        contentLength: response.content?.length || 0,
        hasMedia: !!response.media,
        mediaCount: response.media?.length || 0,
        hasThinking: !!response.thinking,
        hasToolCalls: !!response.tool_calls,
        toolCallsCount: response.tool_calls?.length || 0,
        finishReason: response.finish_reason,
      });

      // 收集思考过程（优先使用 response 中的，否则使用流式过程中收集的）
      if (response.thinking) {
        accumulatedThinking = response.thinking;
        // 如果有新的 thinking，也通过 onChunk 通知（传递空 content chunk）
        if (stream && onChunk) {
          onChunk('', accumulatedThinking);
        }
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 构建 assistant 消息，包含思维签名
        const assistantMsg: LLMMessage = {
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
        };
        
        // 添加思维签名
        if (response.thoughtSignature) {
          assistantMsg.thoughtSignature = response.thoughtSignature;
        }
        
        // 添加工具调用的思维签名
        if (response.toolCallSignatures) {
          assistantMsg.toolCallSignatures = response.toolCallSignatures;
        }
        
        // 添加 DeepSeek reasoning_content（思考模式必需）
        if (response.thinking) {
          assistantMsg.reasoning_content = response.thinking;
        }
        
        messages.push(assistantMsg);

        const toolResults = await Promise.all(
          response.tool_calls.map(async (toolCall) => {
            const startTime = Date.now();
            const toolArgs = toolCall.function.arguments;
            
            // 解析参数（可能是字符串或对象）
            let parsedArgs: any;
            try {
              parsedArgs = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
            } catch {
              parsedArgs = toolArgs;
            }
            
            try {
              // 更新步骤：正在调用工具
              onStepChange?.(`正在调用工具: ${toolCall.function.name}`);
              
              // 通知 MCP 调用开始
              onMCPCall?.({
                toolName: toolCall.function.name,
                arguments: parsedArgs,
                status: 'running',
                mcpServer: this.extractMCPServerFromTool(toolCall.function.name),
              });
              
              console.log(`[LLM] Executing tool: ${toolCall.function.name}`);
              const result = await this.executeToolCall(toolCall);
              console.log(`[LLM] Tool result type:`, typeof result, 'isArray:', Array.isArray(result), 'hasContent:', !!(result as any)?.content, 'hasResult:', !!(result as any)?.result);
              
              // 详细记录结果结构，特别是 content 数组
              if (result && typeof result === 'object') {
                const content = (result as any)?.content || (result as any)?.result?.content;
                if (Array.isArray(content)) {
                  console.log(`[LLM] Tool result content 数组长度:`, content.length);
                  content.forEach((item: any, idx: number) => {
                    if (item?.type === 'image') {
                      console.log(`[LLM]   content[${idx}]: type=image, mimeType=${item.mimeType || item.mime_type}, dataLength=${item.data?.length || 0}, dataPreview=${item.data ? item.data.substring(0, 50) + '...' : 'no data'}`);
                    }
                  });
                }
              }
              
              const duration = Date.now() - startTime;
              
              // 提取媒体内容（避免将大量 base64 数据发送给 LLM）
              let cleanedResult = result;
              let extractedMedia: ExtractedMedia[] = [];
              
              if (mightContainMedia(result)) {
                console.log(`[LLM] 检测到可能包含媒体，开始提取...`);
                const extraction = extractMCPMedia(result);
                cleanedResult = extraction.cleanedContent;
                extractedMedia = extraction.media;
                
                if (extraction.hasMedia) {
                  console.log(`[LLM] 成功提取 ${extractedMedia.length} 个媒体文件，已从发送给 LLM 的内容中移除 base64 数据`);
                  extractedMedia.forEach((m, idx) => {
                    console.log(`[LLM]   媒体[${idx}]: type=${m.type}, mimeType=${m.mimeType}, dataLength=${m.data.length}, dataPreview=${m.data.substring(0, 50)}...`);
                  });
                  // 累积提取的媒体
                  accumulatedMedia.push(...extractedMedia);
                } else {
                  console.warn(`[LLM] 提取失败：hasMedia=false, media.length=${extraction.media.length}`);
                }
              } else {
                console.log(`[LLM] 未检测到媒体内容`);
              }
              
              // 工具调用完成，清除步骤提示
              onStepChange?.('');
              
              // 通知 MCP 调用完成（包含原始结果和提取的媒体）
              onMCPCall?.({
                toolName: toolCall.function.name,
                arguments: parsedArgs,
                result: result, // 原始结果（用于显示）
                status: 'completed',
                duration: duration,
                mcpServer: this.extractMCPServerFromTool(toolCall.function.name),
                extractedMedia: extractedMedia.length > 0 ? extractedMedia : undefined, // 提取的媒体
              });
              
              // 构建工具响应消息，使用清理后的内容（不含 base64）
              const toolMsg: LLMMessage = {
                tool_call_id: toolCall.id,
                role: 'tool' as const,
                name: toolCall.function.name,
                content: JSON.stringify(cleanedResult), // 使用清理后的内容
              };
              
              // 如果有工具调用的思维签名，添加到工具消息中
              if (response.toolCallSignatures && response.toolCallSignatures[toolCall.id]) {
                toolMsg.thoughtSignature = response.toolCallSignatures[toolCall.id];
              }
              
              return toolMsg;
            } catch (error: any) {
              console.error(`[LLM] Tool execution error:`, error);
              
              const duration = Date.now() - startTime;
              
              // 工具调用失败，清除步骤提示
              onStepChange?.('');
              
              // 通知 MCP 调用失败
              onMCPCall?.({
                toolName: toolCall.function.name,
                arguments: parsedArgs,
                status: 'error',
                duration: duration,
                mcpServer: this.extractMCPServerFromTool(toolCall.function.name),
                error: error.message,
              });
              
              // 构建错误响应，也包含思维签名（如果有）
              const toolMsg: LLMMessage = {
                tool_call_id: toolCall.id,
                role: 'tool' as const,
                name: toolCall.function.name,
                content: JSON.stringify({ error: error.message }),
              };
              
              if (response.toolCallSignatures && response.toolCallSignatures[toolCall.id]) {
                toolMsg.thoughtSignature = response.toolCallSignatures[toolCall.id];
              }
              
              return toolMsg;
            }
          })
        );

        messages.push(...toolResults);
        iteration++;
      } else {
        // 合并 LLM 返回的媒体和从 MCP 工具中提取的媒体
        const allMedia = [
          ...(response.media || []),
          ...accumulatedMedia,
        ];
        
        const result = {
          content: response.content,
          thinking: accumulatedThinking || response.thinking,
          thoughtSignature: response.thoughtSignature, // 返回思维签名
          toolCallSignatures: response.toolCallSignatures, // 返回工具调用的思维签名
          media: allMedia.length > 0 ? allMedia : undefined, // 返回所有媒体（包括从 MCP 提取的）
        };
        
        console.log(`[LLM] handleUserRequestWithThinking 最终返回:`, {
          hasContent: !!result.content,
          contentLength: result.content?.length || 0,
          hasMedia: !!result.media,
          mediaCount: result.media?.length || 0,
          accumulatedMediaCount: accumulatedMedia.length,
          hasThinking: !!result.thinking,
        });
        
        return result;
      }
    }

    console.warn(`[LLM] handleUserRequestWithThinking 超时，迭代次数=${iteration}`);
    return { content: '处理超时，请重试。' };
  }

  /**
   * 从工具名称中提取 MCP 服务器名称
   * 工具名称格式通常是: toolName 或 serverName__toolName
   */
  private extractMCPServerFromTool(toolName: string): string | undefined {
    // 检查是否有双下划线分隔符（MCP 工具命名约定）
    if (toolName.includes('__')) {
      const parts = toolName.split('__');
      return parts[0];
    }
    
    // 检查是否有其他常见的分隔符
    if (toolName.includes('-') && toolName.split('-').length > 1) {
      // 如果以 mcp- 开头，提取服务器名称
      const parts = toolName.split('-');
      if (parts[0].toLowerCase() === 'mcp' && parts.length > 1) {
        return parts[1];
      }
    }
    
    return undefined;
  }

  /**
   * OpenAI / DeepSeek 等 OpenAI 兼容接口对 tools.function.name 有格式限制。
   * 将 MCP 工具名做规范化并建立映射，保证：
   * - 发给模型的是合法 name
   * - 执行工具时能映射回原始 MCP 工具名
   */
  private prepareToolsForOpenAI(tools: MCPTool[]): any[] {
    this.toolNameMapLlmToOriginal.clear();
    this.toolNameMapOriginalToLlm.clear();

    const used = new Set<string>();
    const result: any[] = [];

    for (const tool of tools) {
      const originalName = tool.name;
      let llmName = normalizeToolNameForOpenAI(originalName);
      if (used.has(llmName)) {
        const suffix = Math.abs(hashString(originalName)).toString(36).slice(0, 6);
        llmName = `${llmName}_${suffix}`;
      }
      used.add(llmName);

      this.toolNameMapLlmToOriginal.set(llmName, originalName);
      this.toolNameMapOriginalToLlm.set(originalName, llmName);

      result.push({
        type: 'function',
        function: {
          name: llmName,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }

    return result;
  }
}

/**
 * 获取当前LLM客户端
 */
export function getCurrentLLMClient(): LLMClient | null {
  const config = llmConfigManager.getCurrentConfig();
  if (!config || !config.enabled) {
    return null;
  }
  return new LLMClient(config);
}
