/**
 * KnowledgeObserver - 知识观察者
 * 观察其他 Agent 的回答，记录可学习的知识
 */

import type { LearningRecord } from '../../types';
import { generateId, createLogger } from '../../../core/shared/utils';
import { eventBus } from '../../../core/shared/events';

const logger = createLogger('KnowledgeObserver');

/**
 * 观察到的回答
 */
export interface ObservedAnswer {
  questionId: string;
  question: string;
  answer: string;
  agentId: string;
  agentName: string;
  timestamp: number;
  quality?: number; // 质量评分 0-1
}

/**
 * 知识观察者
 */
export class KnowledgeObserver {
  private agentId: string;
  private observedAnswers: Map<string, ObservedAnswer> = new Map();
  private relevantTopics: Set<string> = new Set();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /**
   * 设置关注的主题
   */
  setRelevantTopics(topics: string[]): void {
    this.relevantTopics = new Set(topics.map((t) => t.toLowerCase()));
  }

  /**
   * 观察回答
   */
  observe(
    questionId: string,
    question: string,
    answer: string,
    sourceAgentId: string,
    sourceAgentName: string
  ): boolean {
    // 跳过自己的回答
    if (sourceAgentId === this.agentId) {
      return false;
    }

    // 检查相关性
    if (!this.isRelevant(question, answer)) {
      logger.debug('Answer not relevant', {
        agentId: this.agentId,
        questionId,
      });
      return false;
    }

    // 记录观察
    const observation: ObservedAnswer = {
      questionId,
      question,
      answer,
      agentId: sourceAgentId,
      agentName: sourceAgentName,
      timestamp: Date.now(),
      quality: this.assessQuality(answer),
    };

    this.observedAnswers.set(questionId, observation);

    eventBus.emit('agent:learning', {
      agentId: this.agentId,
      sourceAgentId,
      topic: this.extractTopic(question),
    });

    logger.debug('Answer observed', {
      agentId: this.agentId,
      questionId,
      sourceAgent: sourceAgentName,
      quality: observation.quality,
    });

    return true;
  }

  /**
   * 获取可学习的知识
   */
  getLearnableKnowledge(minQuality: number = 0.5): ObservedAnswer[] {
    return Array.from(this.observedAnswers.values()).filter(
      (obs) => (obs.quality || 0) >= minQuality
    );
  }

  /**
   * 转换为学习记录
   */
  toLearningRecords(): LearningRecord[] {
    return Array.from(this.observedAnswers.values()).map((obs) => ({
      id: generateId('learn'),
      agentId: this.agentId,
      topic: this.extractTopic(obs.question),
      question: obs.question,
      answer: obs.answer,
      sourceAgentId: obs.agentId,
      sourceAgentName: obs.agentName,
      timestamp: obs.timestamp,
      absorbed: false,
    }));
  }

  /**
   * 清除已处理的观察
   */
  clear(questionIds?: string[]): void {
    if (questionIds) {
      for (const id of questionIds) {
        this.observedAnswers.delete(id);
      }
    } else {
      this.observedAnswers.clear();
    }
  }

  /**
   * 获取观察数量
   */
  get count(): number {
    return this.observedAnswers.size;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 检查相关性
   */
  private isRelevant(question: string, answer: string): boolean {
    // 如果没有设置相关主题，全部相关
    if (this.relevantTopics.size === 0) {
      return true;
    }

    const content = (question + ' ' + answer).toLowerCase();
    
    // 检查是否包含任何相关主题
    for (const topic of this.relevantTopics) {
      if (content.includes(topic)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 评估回答质量
   */
  private assessQuality(answer: string): number {
    let score = 0.5;

    // 长度评分
    if (answer.length > 100) score += 0.1;
    if (answer.length > 500) score += 0.1;

    // 结构评分
    if (answer.includes('\n')) score += 0.05;
    if (/\d+\./m.test(answer)) score += 0.05; // 有序列表
    if (answer.includes('```')) score += 0.1; // 代码块

    // 限制范围
    return Math.min(1, Math.max(0, score));
  }

  /**
   * 提取主题
   */
  private extractTopic(text: string): string {
    // 简单提取：取前 50 个字符
    const cleaned = text.replace(/\s+/g, ' ').trim();
    return cleaned.length > 50 ? cleaned.slice(0, 50) + '...' : cleaned;
  }
}
