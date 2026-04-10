/**
 * ProviderFactory - LLM Provider 工厂
 * 根据配置创建对应的 Provider 实例
 */

import type { LLMProviderConfig, LLMProviderType, ILLMProvider, ProviderMetadata } from './types';
import { BaseProvider } from './BaseProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { GeminiProvider } from './GeminiProvider';
import { OllamaProvider } from './OllamaProvider';
import { LLMError, LLMErrorCode } from '../../core/shared/errors';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('ProviderFactory');

// ============================================================================
// Provider Registry - Provider 注册表
// ============================================================================

type ProviderConstructor = new (config: LLMProviderConfig) => BaseProvider;

/**
 * Provider 注册表
 */
const providerRegistry = new Map<LLMProviderType, ProviderConstructor>([
  ['openai', OpenAIProvider],
  ['deepseek', OpenAIProvider], // DeepSeek 使用 OpenAI 兼容 API
  ['anthropic', AnthropicProvider],
  ['gemini', GeminiProvider],
  ['google', GeminiProvider], // Google 别名
  ['ollama', OllamaProvider],
  ['local', OllamaProvider], // 本地 Ollama
]);

/**
 * Provider 元数据
 */
const providerMetadata: Map<LLMProviderType, ProviderMetadata> = new Map([
  ['openai', {
    type: 'openai',
    name: 'OpenAI',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1', 'o1-mini'],
    defaultModel: 'gpt-4o',
    capabilities: { streaming: true, tools: true, vision: true, thinking: true },
  }],
  ['deepseek', {
    type: 'deepseek',
    name: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    capabilities: { streaming: true, tools: true, vision: false, thinking: true },
  }],
  ['anthropic', {
    type: 'anthropic',
    name: 'Anthropic',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],
    defaultModel: 'claude-3-5-sonnet-20241022',
    capabilities: { streaming: true, tools: true, vision: true, thinking: true },
  }],
  ['gemini', {
    type: 'gemini',
    name: 'Google Gemini',
    models: ['gemini-2.0-flash-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    defaultModel: 'gemini-2.0-flash-exp',
    capabilities: { streaming: true, tools: true, vision: true, thinking: true },
  }],
  ['ollama', {
    type: 'ollama',
    name: 'Ollama',
    models: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5'],
    defaultModel: 'llama3.2',
    capabilities: { streaming: true, tools: true, vision: true, thinking: false },
  }],
]);

// ============================================================================
// Factory Functions - 工厂函数
// ============================================================================

/**
 * 创建 Provider 实例
 */
export function createProvider(config: LLMProviderConfig): ILLMProvider {
  const ProviderClass = providerRegistry.get(config.provider);
  
  if (!ProviderClass) {
    throw new LLMError(
      `Unknown provider: ${config.provider}`,
      config.provider,
      { code: LLMErrorCode.PROVIDER_NOT_FOUND }
    );
  }

  logger.info('Creating provider', { type: config.provider, model: config.model });
  return new ProviderClass(config);
}

/**
 * 注册自定义 Provider
 */
export function registerProvider(
  type: LLMProviderType | string,
  constructor: ProviderConstructor,
  metadata?: ProviderMetadata
): void {
  providerRegistry.set(type as LLMProviderType, constructor);
  
  if (metadata) {
    providerMetadata.set(type as LLMProviderType, metadata);
  }
  
  logger.info('Provider registered', { type });
}

/**
 * 取消注册 Provider
 */
export function unregisterProvider(type: LLMProviderType | string): boolean {
  const deleted = providerRegistry.delete(type as LLMProviderType);
  providerMetadata.delete(type as LLMProviderType);
  
  if (deleted) {
    logger.info('Provider unregistered', { type });
  }
  
  return deleted;
}

/**
 * 获取所有已注册的 Provider 类型
 */
export function getRegisteredProviders(): LLMProviderType[] {
  return Array.from(providerRegistry.keys());
}

/**
 * 获取 Provider 元数据
 */
export function getProviderMetadata(type: LLMProviderType): ProviderMetadata | undefined {
  return providerMetadata.get(type);
}

/**
 * 获取所有 Provider 元数据
 */
export function getAllProviderMetadata(): ProviderMetadata[] {
  return Array.from(providerMetadata.values());
}

/**
 * 检查 Provider 是否已注册
 */
export function isProviderRegistered(type: LLMProviderType | string): boolean {
  return providerRegistry.has(type as LLMProviderType);
}

// ============================================================================
// Utility Functions - 工具函数
// ============================================================================

/**
 * 根据 URL 推断 Provider 类型
 */
export function inferProviderFromUrl(url: string): LLMProviderType | null {
  const urlLower = url.toLowerCase();
  
  if (urlLower.includes('openai.com')) return 'openai';
  if (urlLower.includes('deepseek')) return 'deepseek';
  if (urlLower.includes('anthropic.com')) return 'anthropic';
  if (urlLower.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (urlLower.includes('localhost:11434') || urlLower.includes('ollama')) return 'ollama';
  
  return null;
}

/**
 * 根据模型名称推断 Provider 类型
 */
export function inferProviderFromModel(model: string): LLMProviderType | null {
  const modelLower = model.toLowerCase();
  
  if (modelLower.startsWith('gpt-') || modelLower.startsWith('o1')) return 'openai';
  if (modelLower.startsWith('deepseek')) return 'deepseek';
  if (modelLower.startsWith('claude')) return 'anthropic';
  if (modelLower.startsWith('gemini')) return 'gemini';
  if (modelLower.startsWith('llama') || modelLower.startsWith('mistral') || modelLower.startsWith('qwen')) {
    return 'ollama';
  }
  
  return null;
}

/**
 * 创建带自动推断的 Provider
 */
export function createProviderAuto(config: Partial<LLMProviderConfig> & { model: string }): ILLMProvider {
  let provider = config.provider;
  
  if (!provider && config.apiUrl) {
    provider = inferProviderFromUrl(config.apiUrl) ?? undefined;
  }
  
  if (!provider && config.model) {
    provider = inferProviderFromModel(config.model) ?? undefined;
  }
  
  if (!provider) {
    throw new LLMError(
      'Cannot infer provider type. Please specify provider explicitly.',
      'unknown',
      { code: LLMErrorCode.PROVIDER_NOT_FOUND }
    );
  }
  
  return createProvider({ ...config, provider } as LLMProviderConfig);
}
