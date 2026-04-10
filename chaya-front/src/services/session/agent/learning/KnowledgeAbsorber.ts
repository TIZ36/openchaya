/**
 * KnowledgeAbsorber - 知识吸收者
 * 将观察到的知识转化为 Agent 自己的记忆
 */

import type { LearningRecord, MemoryItem } from '../../types';
import { generateId, createLogger } from '../../../core/shared/utils';

const logger = createLogger('KnowledgeAbsorber');

/**
 * 吸收配置
 */
export interface AbsorberConfig {
  minQuality: number;         // 最低质量要求
  maxDailyAbsorptions: number; // 每日最大吸收数
  summarize: boolean;         // 是否摘要
  verifyAccuracy: boolean;    // 是否验证准确性
}

/**
 * 默认吸收配置
 */
export const DEFAULT_ABSORBER_CONFIG: AbsorberConfig = {
  minQuality: 0.5,
  maxDailyAbsorptions: 20,
  summarize: true,
  verifyAccuracy: false,
};

/**
 * 吸收结果
 */
export interface AbsorptionResult {
  success: boolean;
  memoryId?: string;
  reason?: string;
}

/**
 * 知识吸收者
 */
export class KnowledgeAbsorber {
  private agentId: string;
  private config: AbsorberConfig;
  private dailyAbsorptions: number = 0;
  private lastResetDate: string = '';
  private summarizer?: (text: string) => Promise<string>;

  constructor(agentId: string, config?: Partial<AbsorberConfig>) {
    this.agentId = agentId;
    this.config = { ...DEFAULT_ABSORBER_CONFIG, ...config };
  }

  /**
   * 设置摘要器
   */
  setSummarizer(summarizer: (text: string) => Promise<string>): void {
    this.summarizer = summarizer;
  }

  /**
   * 吸收知识
   */
  async absorb(record: LearningRecord): Promise<AbsorptionResult> {
    // 重置每日计数
    this.checkDailyReset();

    // 检查每日限制
    if (this.dailyAbsorptions >= this.config.maxDailyAbsorptions) {
      return {
        success: false,
        reason: '已达到每日吸收上限',
      };
    }

    // 验证记录
    if (!this.isValidRecord(record)) {
      return {
        success: false,
        reason: '记录无效或质量不足',
      };
    }

    try {
      // 处理内容
      let content = this.formatContent(record);
      
      if (this.config.summarize && this.summarizer) {
        content = await this.summarizer(content);
      }

      // 创建记忆项
      const memory: MemoryItem = {
        id: generateId('mem'),
        agentId: this.agentId,
        type: 'semantic',
        content,
        importance: 0.6,
        accessCount: 0,
        lastAccessTime: Date.now(),
        createdAt: Date.now(),
        metadata: {
          source: 'learning',
          sourceAgentId: record.sourceAgentId,
          sourceAgentName: record.sourceAgentName,
          originalQuestion: record.question,
          learningRecordId: record.id,
        },
      };

      this.dailyAbsorptions++;

      logger.info('Knowledge absorbed', {
        agentId: this.agentId,
        memoryId: memory.id,
        topic: record.topic,
        source: record.sourceAgentName,
      });

      return {
        success: true,
        memoryId: memory.id,
      };
    } catch (error) {
      logger.error('Absorption failed', {
        agentId: this.agentId,
        recordId: record.id,
        error,
      });

      return {
        success: false,
        reason: (error as Error).message,
      };
    }
  }

  /**
   * 批量吸收
   */
  async absorbBatch(records: LearningRecord[]): Promise<AbsorptionResult[]> {
    const results: AbsorptionResult[] = [];

    for (const record of records) {
      const result = await this.absorb(record);
      results.push(result);

      if (!result.success && result.reason === '已达到每日吸收上限') {
        // 达到限制，剩余的都标记为失败
        for (let i = results.length; i < records.length; i++) {
          results.push({ success: false, reason: '已达到每日吸收上限' });
        }
        break;
      }
    }

    return results;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    dailyAbsorptions: number;
    maxDaily: number;
    remaining: number;
  } {
    this.checkDailyReset();
    return {
      dailyAbsorptions: this.dailyAbsorptions,
      maxDaily: this.config.maxDailyAbsorptions,
      remaining: this.config.maxDailyAbsorptions - this.dailyAbsorptions,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 检查并重置每日计数
   */
  private checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.lastResetDate !== today) {
      this.dailyAbsorptions = 0;
      this.lastResetDate = today;
    }
  }

  /**
   * 验证记录
   */
  private isValidRecord(record: LearningRecord): boolean {
    if (!record.question || !record.answer) {
      return false;
    }
    if (record.answer.length < 10) {
      return false;
    }
    return true;
  }

  /**
   * 格式化内容
   */
  private formatContent(record: LearningRecord): string {
    return `[学习自 ${record.sourceAgentName}]\n问题: ${record.question}\n答案: ${record.answer}`;
  }
}
