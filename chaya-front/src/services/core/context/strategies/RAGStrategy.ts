/**
 * RAGStrategy - RAG 检索策略
 * 基于语义相似度检索相关历史片段
 */

import type { Message } from '../../message/types';
import type { IContextStrategy, TokenBudget, ContextConfig } from '../types';

/**
 * 嵌入向量回调
 */
export type EmbeddingCallback = (text: string) => Promise<number[]>;

/**
 * RAG 策略
 */
export class RAGStrategy implements IContextStrategy {
  name: 'rag' = 'rag';

  private embeddingCallback?: EmbeddingCallback;
  private embeddingCache: Map<string, number[]> = new Map();

  /**
   * 设置嵌入向量回调
   */
  setEmbeddingCallback(callback: EmbeddingCallback): void {
    this.embeddingCallback = callback;
  }

  async select(
    history: Message[],
    newMessage: string,
    budget: TokenBudget,
    config: ContextConfig
  ): Promise<Message[]> {
    if (history.length === 0) return [];

    const ragConfig = config.rag ?? { enabled: true, topK: 5, minSimilarity: 0.7 };
    const windowConfig = config.window ?? { recentCount: 10, importantRoles: ['system'] };

    // 分离系统消息
    const systemMessages = history.filter((m) => m.role === 'system');
    const nonSystemMessages = history.filter((m) => m.role !== 'system');

    // 保留最近几条消息
    const recentMessages = nonSystemMessages.slice(-windowConfig.recentCount);
    const olderMessages = nonSystemMessages.slice(0, -windowConfig.recentCount);

    // 如果没有嵌入回调或没有旧消息，使用简单选择
    if (!this.embeddingCallback || olderMessages.length === 0) {
      return this.simpleSelect(systemMessages, recentMessages, budget);
    }

    // 获取查询嵌入
    const queryEmbedding = await this.getEmbedding(newMessage);

    // 计算相似度并排序
    const scoredMessages = await Promise.all(
      olderMessages.map(async (msg) => {
        const embedding = await this.getEmbedding(msg.content);
        const similarity = this.cosineSimilarity(queryEmbedding, embedding);
        return { message: msg, similarity };
      })
    );

    // 过滤并排序
    const relevantMessages = scoredMessages
      .filter((item) => item.similarity >= ragConfig.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, ragConfig.topK)
      .map((item) => item.message);

    // 组装结果
    const result: Message[] = [];
    let usedTokens = 0;

    // 添加系统消息
    for (const msg of systemMessages) {
      const tokens = this.estimateMessageTokens(msg);
      if (usedTokens + tokens <= budget.available) {
        result.push(msg);
        usedTokens += tokens;
      }
    }

    // 添加 RAG 检索的消息
    for (const msg of relevantMessages) {
      const tokens = this.estimateMessageTokens(msg);
      if (usedTokens + tokens <= budget.available) {
        result.push(msg);
        usedTokens += tokens;
      }
    }

    // 添加最近消息
    for (const msg of recentMessages) {
      const tokens = this.estimateMessageTokens(msg);
      if (usedTokens + tokens <= budget.available) {
        result.push(msg);
        usedTokens += tokens;
      }
    }

    // 按时间排序
    result.sort((a, b) => a.timestamp - b.timestamp);

    return result;
  }

  /**
   * 简单选择（无 RAG）
   */
  private simpleSelect(
    systemMessages: Message[],
    recentMessages: Message[],
    budget: TokenBudget
  ): Message[] {
    const result: Message[] = [];
    let usedTokens = 0;

    for (const msg of systemMessages) {
      const tokens = this.estimateMessageTokens(msg);
      if (usedTokens + tokens <= budget.available) {
        result.push(msg);
        usedTokens += tokens;
      }
    }

    for (const msg of recentMessages) {
      const tokens = this.estimateMessageTokens(msg);
      if (usedTokens + tokens <= budget.available) {
        result.push(msg);
        usedTokens += tokens;
      }
    }

    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  /**
   * 获取嵌入向量（带缓存）
   */
  private async getEmbedding(text: string): Promise<number[]> {
    const cacheKey = text.slice(0, 100);
    if (this.embeddingCache.has(cacheKey)) {
      return this.embeddingCache.get(cacheKey)!;
    }

    if (!this.embeddingCallback) {
      return [];
    }

    const embedding = await this.embeddingCallback(text);
    this.embeddingCache.set(cacheKey, embedding);

    // 限制缓存大小
    if (this.embeddingCache.size > 1000) {
      const firstKey = this.embeddingCache.keys().next().value;
      if (firstKey) this.embeddingCache.delete(firstKey);
    }

    return embedding;
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private estimateMessageTokens(message: Message): number {
    const content = message.content || '';
    let tokens = Math.ceil(content.length / 3);
    tokens += 10;
    if (message.toolCalls) {
      tokens += message.toolCalls.length * 50;
    }
    if (message.media) {
      tokens += message.media.length * 1000;
    }
    return tokens;
  }
}
