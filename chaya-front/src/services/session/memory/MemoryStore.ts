/**
 * MemoryStore - Agent 记忆存储
 * 管理 Agent 的长期记忆
 */

import type { MemoryItem, MemoryType } from '../types';
import { generateId, createLogger } from '../../core/shared/utils';

const logger = createLogger('MemoryStore');

/**
 * 记忆存储配置
 */
export interface MemoryStoreConfig {
  maxItems: number;
  consolidationThreshold: number;
  decayRate: number;
}

/**
 * 默认配置
 */
export const DEFAULT_MEMORY_STORE_CONFIG: MemoryStoreConfig = {
  maxItems: 1000,
  consolidationThreshold: 100,
  decayRate: 0.01,
};

/**
 * 记忆存储
 */
export class MemoryStore {
  private agentId: string;
  private config: MemoryStoreConfig;
  private memories: Map<string, MemoryItem> = new Map();
  private typeIndex: Map<MemoryType, Set<string>> = new Map([
    ['episodic', new Set()],
    ['semantic', new Set()],
    ['procedural', new Set()],
  ]);

  constructor(agentId: string, config?: Partial<MemoryStoreConfig>) {
    this.agentId = agentId;
    this.config = { ...DEFAULT_MEMORY_STORE_CONFIG, ...config };
  }

  /**
   * 添加记忆
   */
  add(
    content: string,
    type: MemoryType,
    options: {
      importance?: number;
      embedding?: number[];
      metadata?: Record<string, unknown>;
    } = {}
  ): MemoryItem {
    const memory: MemoryItem = {
      id: generateId('mem'),
      agentId: this.agentId,
      type,
      content,
      embedding: options.embedding,
      importance: options.importance ?? 0.5,
      accessCount: 0,
      lastAccessTime: Date.now(),
      createdAt: Date.now(),
      metadata: options.metadata,
    };

    this.memories.set(memory.id, memory);
    this.typeIndex.get(type)?.add(memory.id);

    // 检查是否需要整理
    if (this.memories.size > this.config.maxItems) {
      this.evictLeastImportant();
    }

    logger.debug('Memory added', {
      agentId: this.agentId,
      memoryId: memory.id,
      type,
    });

    return memory;
  }

  /**
   * 获取记忆
   */
  get(memoryId: string): MemoryItem | undefined {
    const memory = this.memories.get(memoryId);
    if (memory) {
      // 更新访问信息
      memory.accessCount++;
      memory.lastAccessTime = Date.now();
    }
    return memory;
  }

  /**
   * 更新记忆
   */
  update(memoryId: string, updates: Partial<MemoryItem>): boolean {
    const memory = this.memories.get(memoryId);
    if (!memory) return false;

    Object.assign(memory, updates, { id: memory.id, agentId: memory.agentId });
    return true;
  }

  /**
   * 删除记忆
   */
  delete(memoryId: string): boolean {
    const memory = this.memories.get(memoryId);
    if (!memory) return false;

    this.memories.delete(memoryId);
    this.typeIndex.get(memory.type)?.delete(memoryId);
    return true;
  }

  /**
   * 按类型获取记忆
   */
  getByType(type: MemoryType): MemoryItem[] {
    const ids = this.typeIndex.get(type);
    if (!ids) return [];

    return Array.from(ids)
      .map((id) => this.memories.get(id))
      .filter((m): m is MemoryItem => m !== undefined);
  }

  /**
   * 获取所有记忆
   */
  getAll(): MemoryItem[] {
    return Array.from(this.memories.values());
  }

  /**
   * 获取最近的记忆
   */
  getRecent(limit: number = 10): MemoryItem[] {
    return this.getAll()
      .sort((a, b) => b.lastAccessTime - a.lastAccessTime)
      .slice(0, limit);
  }

  /**
   * 获取最重要的记忆
   */
  getMostImportant(limit: number = 10): MemoryItem[] {
    return this.getAll()
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * 清空记忆
   */
  clear(): void {
    this.memories.clear();
    this.typeIndex.forEach((index) => index.clear());
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    byType: Record<MemoryType, number>;
    averageImportance: number;
  } {
    const all = this.getAll();
    const avgImportance =
      all.length > 0 ? all.reduce((sum, m) => sum + m.importance, 0) / all.length : 0;

    return {
      total: this.memories.size,
      byType: {
        episodic: this.typeIndex.get('episodic')?.size || 0,
        semantic: this.typeIndex.get('semantic')?.size || 0,
        procedural: this.typeIndex.get('procedural')?.size || 0,
      },
      averageImportance: avgImportance,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 淘汰最不重要的记忆
   */
  private evictLeastImportant(): void {
    // 计算综合评分
    const scored = this.getAll().map((m) => ({
      memory: m,
      score: this.calculateRetentionScore(m),
    }));

    // 排序
    scored.sort((a, b) => a.score - b.score);

    // 删除最低评分的
    const toRemove = scored.slice(0, Math.floor(this.config.maxItems * 0.1));
    for (const item of toRemove) {
      this.delete(item.memory.id);
    }

    logger.debug('Evicted memories', {
      agentId: this.agentId,
      count: toRemove.length,
    });
  }

  /**
   * 计算记忆保留评分
   */
  private calculateRetentionScore(memory: MemoryItem): number {
    const now = Date.now();
    const age = (now - memory.createdAt) / (1000 * 60 * 60 * 24); // 天数
    const recency = (now - memory.lastAccessTime) / (1000 * 60 * 60); // 小时

    // 综合评分：重要性 + 访问次数 - 时间衰减
    const score =
      memory.importance * 0.4 +
      Math.log(memory.accessCount + 1) * 0.3 -
      age * this.config.decayRate -
      recency * 0.001;

    return score;
  }
}
