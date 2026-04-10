/**
 * MemoryConsolidation - 记忆整合
 * 定期整理、合并和强化记忆
 */

import type { MemoryItem, MemoryType } from '../types';
import { MemoryStore } from './MemoryStore';
import { createLogger, generateId } from '../../core/shared/utils';

const logger = createLogger('MemoryConsolidation');

/**
 * 整合配置
 */
export interface ConsolidationConfig {
  interval: number;           // 整合间隔（ms）
  similarityThreshold: number; // 合并相似度阈值
  minAccessForRetention: number; // 保留的最小访问次数
  maxAge: number;             // 最大年龄（ms）
}

/**
 * 默认整合配置
 */
export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  interval: 24 * 60 * 60 * 1000, // 每天
  similarityThreshold: 0.8,
  minAccessForRetention: 1,
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
};

/**
 * 整合结果
 */
export interface ConsolidationResult {
  merged: number;
  pruned: number;
  strengthened: number;
}

/**
 * 记忆整合器
 */
export class MemoryConsolidation {
  private store: MemoryStore;
  private config: ConsolidationConfig;
  private timer?: ReturnType<typeof setInterval>;
  private summarizer?: (memories: MemoryItem[]) => Promise<string>;

  constructor(store: MemoryStore, config?: Partial<ConsolidationConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
  }

  /**
   * 设置摘要器
   */
  setSummarizer(summarizer: (memories: MemoryItem[]) => Promise<string>): void {
    this.summarizer = summarizer;
  }

  /**
   * 开始定期整合
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.consolidate().catch((error) => {
        logger.error('Consolidation failed', { error });
      });
    }, this.config.interval);

    logger.info('Consolidation started', { interval: this.config.interval });
  }

  /**
   * 停止定期整合
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('Consolidation stopped');
    }
  }

  /**
   * 执行整合
   */
  async consolidate(): Promise<ConsolidationResult> {
    logger.debug('Starting consolidation');

    const result: ConsolidationResult = {
      merged: 0,
      pruned: 0,
      strengthened: 0,
    };

    // 1. 合并相似记忆
    result.merged = await this.mergeSimilarMemories();

    // 2. 剪枝过期和低价值记忆
    result.pruned = this.pruneOldMemories();

    // 3. 强化重要记忆
    result.strengthened = this.strengthenImportantMemories();

    logger.info('Consolidation completed', result);
    return result;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 合并相似记忆
   */
  private async mergeSimilarMemories(): Promise<number> {
    const memories = this.store.getAll();
    const merged = new Set<string>();
    let mergeCount = 0;

    for (let i = 0; i < memories.length; i++) {
      if (merged.has(memories[i].id)) continue;

      const similar: MemoryItem[] = [memories[i]];

      for (let j = i + 1; j < memories.length; j++) {
        if (merged.has(memories[j].id)) continue;

        if (
          memories[i].type === memories[j].type &&
          this.areSimilar(memories[i], memories[j])
        ) {
          similar.push(memories[j]);
          merged.add(memories[j].id);
        }
      }

      // 如果找到相似记忆，合并
      if (similar.length > 1) {
        await this.mergeMemories(similar);
        mergeCount++;
      }
    }

    // 删除已合并的记忆
    merged.forEach((id) => this.store.delete(id));

    return mergeCount;
  }

  /**
   * 检查两个记忆是否相似
   */
  private areSimilar(a: MemoryItem, b: MemoryItem): boolean {
    // 简单的关键词相似度
    const wordsA = this.tokenize(a.content);
    const wordsB = this.tokenize(b.content);

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    const similarity = union.size === 0 ? 0 : intersection.size / union.size;
    return similarity >= this.config.similarityThreshold;
  }

  /**
   * 合并多个记忆
   */
  private async mergeMemories(memories: MemoryItem[]): Promise<void> {
    let mergedContent: string;

    if (this.summarizer && memories.length > 2) {
      mergedContent = await this.summarizer(memories);
    } else {
      // 简单合并
      mergedContent = memories.map((m) => m.content).join('\n---\n');
    }

    // 计算合并后的属性
    const avgImportance = memories.reduce((s, m) => s + m.importance, 0) / memories.length;
    const totalAccess = memories.reduce((s, m) => s + m.accessCount, 0);
    const latestAccess = Math.max(...memories.map((m) => m.lastAccessTime));

    // 更新第一个记忆（保留）
    this.store.update(memories[0].id, {
      content: mergedContent,
      importance: Math.min(1, avgImportance * 1.1), // 略微提升重要性
      accessCount: totalAccess,
      lastAccessTime: latestAccess,
      metadata: {
        ...memories[0].metadata,
        mergedFrom: memories.map((m) => m.id),
        mergedAt: Date.now(),
      },
    });
  }

  /**
   * 剪枝过期记忆
   */
  private pruneOldMemories(): number {
    const now = Date.now();
    const memories = this.store.getAll();
    let pruneCount = 0;

    for (const memory of memories) {
      const age = now - memory.createdAt;
      
      // 检查是否过期且访问次数低
      if (
        age > this.config.maxAge &&
        memory.accessCount < this.config.minAccessForRetention
      ) {
        this.store.delete(memory.id);
        pruneCount++;
      }
    }

    return pruneCount;
  }

  /**
   * 强化重要记忆
   */
  private strengthenImportantMemories(): number {
    const memories = this.store.getAll();
    let strengthenCount = 0;

    for (const memory of memories) {
      // 高访问次数的记忆提升重要性
      if (memory.accessCount > 10 && memory.importance < 0.9) {
        this.store.update(memory.id, {
          importance: Math.min(1, memory.importance + 0.05),
        });
        strengthenCount++;
      }
    }

    return strengthenCount;
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
