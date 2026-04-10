/**
 * MemoryTrigger - 记忆触发器
 * 基于记忆触发 Agent 行为
 */

import type { MemoryItem } from '../types';
import { MemoryStore } from '../memory/MemoryStore';
import { MemoryRetrieval } from '../memory/MemoryRetrieval';
import { createLogger } from '../../core/shared/utils';

const logger = createLogger('MemoryTrigger');

/**
 * 触发规则
 */
export interface TriggerRule {
  id: string;
  name: string;
  condition: (memory: MemoryItem) => boolean;
  action: string; // 动作标识
  cooldown: number; // 冷却时间（ms）
}

/**
 * 触发结果
 */
export interface TriggerResult {
  ruleId: string;
  ruleName: string;
  action: string;
  memory: MemoryItem;
  timestamp: number;
}

/**
 * 记忆触发器
 */
export class MemoryTrigger {
  private agentId: string;
  private store: MemoryStore;
  private retrieval: MemoryRetrieval;
  private rules: Map<string, TriggerRule> = new Map();
  private lastTriggerTime: Map<string, number> = new Map();
  private actionHandler?: (action: string, memory: MemoryItem) => Promise<void>;

  constructor(agentId: string, store: MemoryStore) {
    this.agentId = agentId;
    this.store = store;
    this.retrieval = new MemoryRetrieval(store);
  }

  /**
   * 设置动作处理器
   */
  setActionHandler(handler: (action: string, memory: MemoryItem) => Promise<void>): void {
    this.actionHandler = handler;
  }

  /**
   * 添加触发规则
   */
  addRule(rule: TriggerRule): void {
    this.rules.set(rule.id, rule);
    logger.debug('Rule added', { agentId: this.agentId, ruleId: rule.id });
  }

  /**
   * 移除触发规则
   */
  removeRule(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.lastTriggerTime.delete(ruleId);
    }
    return deleted;
  }

  /**
   * 检查并触发
   */
  async checkAndTrigger(context?: string): Promise<TriggerResult[]> {
    const results: TriggerResult[] = [];
    const now = Date.now();

    // 获取相关记忆
    let memories: MemoryItem[];
    if (context) {
      const retrievalResults = await this.retrieval.retrieve(context, { topK: 10 });
      memories = retrievalResults.map((r) => r.memory);
    } else {
      memories = this.store.getRecent(20);
    }

    // 检查每条规则
    for (const [ruleId, rule] of this.rules) {
      // 检查冷却
      const lastTrigger = this.lastTriggerTime.get(ruleId) || 0;
      if (now - lastTrigger < rule.cooldown) {
        continue;
      }

      // 检查每条记忆
      for (const memory of memories) {
        if (rule.condition(memory)) {
          // 触发
          const result: TriggerResult = {
            ruleId,
            ruleName: rule.name,
            action: rule.action,
            memory,
            timestamp: now,
          };

          results.push(result);
          this.lastTriggerTime.set(ruleId, now);

          // 执行动作
          if (this.actionHandler) {
            try {
              await this.actionHandler(rule.action, memory);
            } catch (error) {
              logger.error('Action handler failed', {
                agentId: this.agentId,
                ruleId,
                action: rule.action,
                error,
              });
            }
          }

          // 每条规则只触发一次
          break;
        }
      }
    }

    if (results.length > 0) {
      logger.debug('Triggers fired', {
        agentId: this.agentId,
        count: results.length,
      });
    }

    return results;
  }

  /**
   * 获取所有规则
   */
  getRules(): TriggerRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * 清除冷却
   */
  resetCooldowns(): void {
    this.lastTriggerTime.clear();
  }
}

// ============================================================================
// 预定义规则
// ============================================================================

/**
 * 创建重要记忆触发规则
 */
export function createImportantMemoryRule(
  action: string,
  threshold: number = 0.8
): TriggerRule {
  return {
    id: 'important_memory',
    name: '重要记忆触发',
    condition: (memory) => memory.importance >= threshold,
    action,
    cooldown: 60 * 60 * 1000, // 1 小时
  };
}

/**
 * 创建近期记忆触发规则
 */
export function createRecentMemoryRule(
  action: string,
  withinHours: number = 1
): TriggerRule {
  return {
    id: 'recent_memory',
    name: '近期记忆触发',
    condition: (memory) => {
      const hoursAgo = (Date.now() - memory.lastAccessTime) / (1000 * 60 * 60);
      return hoursAgo <= withinHours && memory.accessCount > 5;
    },
    action,
    cooldown: 30 * 60 * 1000, // 30 分钟
  };
}

/**
 * 创建关键词触发规则
 */
export function createKeywordTriggerRule(
  id: string,
  keywords: string[],
  action: string
): TriggerRule {
  const keywordsLower = keywords.map((k) => k.toLowerCase());
  
  return {
    id,
    name: `关键词触发: ${keywords.join(', ')}`,
    condition: (memory) => {
      const contentLower = memory.content.toLowerCase();
      return keywordsLower.some((kw) => contentLower.includes(kw));
    },
    action,
    cooldown: 15 * 60 * 1000, // 15 分钟
  };
}
