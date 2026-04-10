/**
 * LLMNode - LLM 调用节点
 */

import { BaseNode } from './BaseNode';
import type { NodeType, NodeContext, NodeResult } from '../types';
import { createProvider, type LLMProviderConfig, type LLMMessage } from '../../providers/llm';

/**
 * LLM 节点配置
 */
export interface LLMNodeConfig {
  provider: string;
  model: string;
  apiKey?: string;
  apiUrl?: string;
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

/**
 * LLM 节点
 */
export class LLMNode extends BaseNode {
  readonly type: NodeType = 'llm';

  /**
   * 执行节点
   */
  async execute(context: NodeContext): Promise<NodeResult> {
    const startTime = Date.now();
    const config = this.config as LLMNodeConfig;

    try {
      // 渲染提示词
      const systemPrompt = config.systemPrompt
        ? this.renderTemplate(config.systemPrompt, context.variables)
        : undefined;
      const userPrompt = this.renderTemplate(config.userPrompt, context.variables);

      // 构建消息
      const messages: LLMMessage[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: userPrompt });

      // 创建 Provider
      const provider = createProvider({
        provider: config.provider as LLMProviderConfig['provider'],
        model: config.model,
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
      });

      // 调用 LLM
      const response = await provider.chat(messages, {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal: context.signal,
      });

      const duration = Date.now() - startTime;

      this.logger.debug('LLM call completed', {
        nodeId: this.id,
        duration,
        contentLength: response.content.length,
      });

      return this.success(
        {
          content: response.content,
          thinking: response.thinking,
          tool_calls: response.tool_calls,
          usage: response.usage,
        },
        duration,
        {
          model: config.model,
          provider: config.provider,
        }
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error('LLM call failed', { nodeId: this.id, error });
      return this.failure(error as Error, duration);
    }
  }

  /**
   * 验证配置
   */
  validate(): string[] {
    const errors = super.validate();
    const config = this.config as LLMNodeConfig;

    if (!config.provider) {
      errors.push('LLM provider is required');
    }
    if (!config.model) {
      errors.push('LLM model is required');
    }
    if (!config.userPrompt) {
      errors.push('User prompt is required');
    }

    return errors;
  }
}
