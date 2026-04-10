/**
 * MemoryRetrieval - 记忆检索
 * 基于语义相似度检索相关记忆
 */

import type { MemoryItem, MemoryRetrievalResult } from '../types';
import { MemoryStore } from './MemoryStore';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('MemoryRetrieval');

/**
 * 检索配置
 */
export interface RetrievalConfig {
  topK: number;
  minSimilarity: number;
  recencyBoost: number;
  importanceBoost: number;
}

/**
 * 默认检索配置
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 5,
  minSimilarity: 0.5,
  recencyBoost: 0.1,
  importanceBoost: 0.2,
};

/**
 * 嵌入向量生成器
 */
export type EmbeddingGenerator = (text: string) => Promise<number[]>;

/**
 * 记忆检索器
 */
export class MemoryRetrieval {
  private store: MemoryStore;
  private config: RetrievalConfig;
  private embeddingGenerator?: EmbeddingGenerator;

  constructor(store: MemoryStore, config?: Partial<RetrievalConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  }

  /**
   * 设置嵌入向量生成器
   */
  setEmbeddingGenerator(generator: EmbeddingGenerator): void {
    this.embeddingGenerator = generator;
  }

  /**
   * 检索相关记忆
   */
  async retrieve(
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
    }
  ): Promise<MemoryRetrievalResult[]> {
    const topK = options?.topK ?? this.config.topK;
    const minSimilarity = options?.minSimilarity ?? this.config.minSimilarity;

    // 获取所有记忆
    const memories = this.store.getAll();
    if (memories.length === 0) {
      return [];
    }

    // 如果有嵌入向量生成器，使用向量相似度
    if (this.embeddingGenerator) {
      return this.retrieveByEmbedding(query, memories, topK, minSimilarity);
    }

    // 否则使用关键词匹配
    return this.retrieveByKeywords(query, memories, topK, minSimilarity);
  }

  /**
   * 检索并更新访问
   */
  async retrieveAndUpdate(
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
    }
  ): Promise<MemoryRetrievalResult[]> {
    const results = await this.retrieve(query, options);

    // 更新访问信息
    for (const result of results) {
      result.memory.accessCount++;
      result.memory.lastAccessTime = Date.now();
    }

    return results;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 基于嵌入向量检索
   */
  private async retrieveByEmbedding(
    query: string,
    memories: MemoryItem[],
    topK: number,
    minSimilarity: number
  ): Promise<MemoryRetrievalResult[]> {
    // 生成查询向量
    const queryEmbedding = await this.embeddingGenerator!(query);

    // 计算相似度
    const results: MemoryRetrievalResult[] = [];

    for (const memory of memories) {
      if (!memory.embedding) continue;

      const baseSimilarity = this.cosineSimilarity(queryEmbedding, memory.embedding);
      const adjustedSimilarity = this.adjustScore(memory, baseSimilarity);

      if (adjustedSimilarity >= minSimilarity) {
        results.push({ memory, similarity: adjustedSimilarity });
      }
    }

    // 排序并返回 top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * 基于关键词检索
   */
  private retrieveByKeywords(
    query: string,
    memories: MemoryItem[],
    topK: number,
    minSimilarity: number
  ): MemoryRetrievalResult[] {
    const queryWords = this.tokenize(query);
    const results: MemoryRetrievalResult[] = [];

    for (const memory of memories) {
      const memoryWords = this.tokenize(memory.content);
      const baseSimilarity = this.jaccardSimilarity(queryWords, memoryWords);
      const adjustedSimilarity = this.adjustScore(memory, baseSimilarity);

      if (adjustedSimilarity >= minSimilarity) {
        results.push({ memory, similarity: adjustedSimilarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  /**
   * 调整评分（加入时间和重要性因素）
   */
  private adjustScore(memory: MemoryItem, baseSimilarity: number): number {
    const now = Date.now();
    const hoursAgo = (now - memory.lastAccessTime) / (1000 * 60 * 60);
    
    // 时间衰减（最近访问的加分）
    const recencyBonus = Math.max(0, this.config.recencyBoost * (1 - hoursAgo / 24));
    
    // 重要性加分
    const importanceBonus = memory.importance * this.config.importanceBoost;

    return Math.min(1, baseSimilarity + recencyBonus + importanceBonus);
  }

  /**
   * 余弦相似度
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

  /**
   * Jaccard 相似度
   */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * 分词
   */
  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1)
    );
  }
}
