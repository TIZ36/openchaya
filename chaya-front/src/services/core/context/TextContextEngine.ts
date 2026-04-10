/**
 * TextContextEngine - 文字上下文引擎
 * 管理文字消息的上下文构建，支持多种策略
 */

import type { Message } from '../message/types';
import type {
  ContextConfig,
  ContextResult,
  TokenBudget,
  IContextStrategy,
  ContextStrategyType,
} from './types';
import { DEFAULT_CONTEXT_CONFIG } from './types';
import { SlidingWindowStrategy, SummaryStrategy, RAGStrategy } from './strategies';
import { createLogger } from '../shared/utils';

const logger = createLogger('TextContextEngine');

/**
 * 文字上下文引擎
 */
export class TextContextEngine {
  private strategies: Map<ContextStrategyType, IContextStrategy>;
  private config: ContextConfig;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
    
    // 初始化策略
    this.strategies = new Map<ContextStrategyType, IContextStrategy>([
      ['sliding_window', new SlidingWindowStrategy()],
      ['summary', new SummaryStrategy()],
      ['rag', new RAGStrategy()],
    ]);
  }

  /**
   * 设置配置
   */
  setConfig(config: Partial<ContextConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 注册策略
   */
  registerStrategy(strategy: IContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * 构建上下文
   */
  async buildContext(
    sessionId: string,
    newMessage: string,
    history: Message[],
    options: {
      systemPrompt?: string;
      tools?: { name: string; description: string }[];
      config?: Partial<ContextConfig>;
    } = {}
  ): Promise<ContextResult> {
    const config = { ...this.config, ...options.config };
    
    // 1. 计算 token 预算
    const budget = this.calculateBudget(config, options.systemPrompt, options.tools);
    logger.debug('Token budget calculated', { budget });

    // 2. 获取策略
    const strategy = this.strategies.get(config.strategy);
    if (!strategy) {
      throw new Error(`Unknown strategy: ${config.strategy}`);
    }

    // 3. 选择消息
    const selectedMessages = await strategy.select(history, newMessage, budget, config);
    logger.debug('Messages selected', { count: selectedMessages.length });

    // 4. 优化多模态内容
    const optimizedMessages = this.optimizeMedia(selectedMessages, config);

    // 5. 计算实际 token 使用
    const historyTokens = this.estimateTokens(optimizedMessages);
    
    return {
      messages: optimizedMessages,
      tokenUsage: {
        system: budget.system,
        history: historyTokens,
        tools: budget.tools,
        total: budget.system + historyTokens + budget.tools,
        budget: budget.total,
      },
      metadata: {
        truncatedCount: history.length - selectedMessages.length,
        summarizedCount: 0, // 由策略决定
        ragRetrievedCount: 0, // 由策略决定
      },
    };
  }

  /**
   * 计算 token 预算
   */
  private calculateBudget(
    config: ContextConfig,
    systemPrompt?: string,
    tools?: { name: string; description: string }[]
  ): TokenBudget {
    const total = config.maxTokens;
    const reservedForResponse = config.reservedForResponse;
    
    // 估算系统提示词 token
    const system = systemPrompt ? Math.ceil(systemPrompt.length / 3) : 0;
    
    // 估算工具描述 token
    let toolTokens = 0;
    if (tools) {
      for (const tool of tools) {
        toolTokens += Math.ceil((tool.name.length + (tool.description?.length || 0)) / 3);
        toolTokens += 50; // 格式开销
      }
    }
    
    const available = total - reservedForResponse - system - toolTokens;
    
    return {
      total,
      system,
      tools: toolTokens,
      available: Math.max(0, available),
      reservedForResponse,
    };
  }

  /**
   * 优化多模态内容
   */
  private optimizeMedia(messages: Message[], config: ContextConfig): Message[] {
    const mediaConfig = config.media;
    if (!mediaConfig) return messages;

    let imageCount = 0;
    
    return messages.map((msg) => {
      if (!msg.media || msg.media.length === 0) return msg;

      const optimizedMedia = msg.media.filter((item) => {
        if (item.type === 'image') {
          imageCount++;
          return imageCount <= mediaConfig.maxImages;
        }
        return true;
      });

      return { ...msg, media: optimizedMedia };
    });
  }

  /**
   * 估算消息列表的 token 数
   */
  private estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, msg) => {
      const content = msg.content || '';
      let tokens = Math.ceil(content.length / 3);
      tokens += 10; // 格式开销
      
      if (msg.toolCalls) {
        tokens += msg.toolCalls.length * 50;
      }
      
      if (msg.media) {
        tokens += msg.media.length * (this.config.media?.imageTokenEstimate || 1000);
      }
      
      return sum + tokens;
    }, 0);
  }

  /**
   * 设置摘要回调
   */
  setSummaryCallback(callback: (messages: Message[]) => Promise<string>): void {
    const summaryStrategy = this.strategies.get('summary') as SummaryStrategy | undefined;
    if (summaryStrategy) {
      summaryStrategy.setSummaryCallback(callback);
    }
  }

  /**
   * 设置嵌入向量回调
   */
  setEmbeddingCallback(callback: (text: string) => Promise<number[]>): void {
    const ragStrategy = this.strategies.get('rag') as RAGStrategy | undefined;
    if (ragStrategy) {
      ragStrategy.setEmbeddingCallback(callback);
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let textContextEngineInstance: TextContextEngine | null = null;

/**
 * 获取文字上下文引擎单例
 */
export function getTextContextEngine(config?: Partial<ContextConfig>): TextContextEngine {
  if (!textContextEngineInstance) {
    textContextEngineInstance = new TextContextEngine(config);
  }
  return textContextEngineInstance;
}
