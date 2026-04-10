/**
 * AutonomousThinking - 自驱思考
 * 实现 Agent 的自主思考能力
 */

import type { AutonomousThinkingConfig, ThinkingTask } from '../types';
import { getScheduler } from '../../core/scheduler';
import { createLogger, generateId } from '../../core/shared/utils';

const logger = createLogger('AutonomousThinking');

/**
 * 思考处理器
 */
export type ThinkingHandler = (topic: string, prompt: string) => Promise<string>;

/**
 * 自驱思考管理器
 */
export class AutonomousThinking {
  private agentId: string;
  private config: AutonomousThinkingConfig;
  private handler?: ThinkingHandler;
  private tasks: Map<string, ThinkingTask> = new Map();
  private taskDefinitionIds: string[] = [];

  constructor(agentId: string, config?: Partial<AutonomousThinkingConfig>) {
    this.agentId = agentId;
    this.config = {
      enabled: false,
      interval: 60 * 60 * 1000, // 1 小时
      topics: [],
      memoryTriggered: false,
      ...config,
    };
  }

  /**
   * 设置思考处理器
   */
  setHandler(handler: ThinkingHandler): void {
    this.handler = handler;
  }

  /**
   * 启动自驱思考
   */
  start(): void {
    if (!this.config.enabled || this.config.topics.length === 0) {
      logger.warn('Autonomous thinking not enabled or no topics', {
        agentId: this.agentId,
      });
      return;
    }

    const scheduler = getScheduler();

    // 为每个主题创建定时任务
    for (const topic of this.config.topics) {
      const taskId = `think_${this.agentId}_${topic}`;
      
      scheduler.register({
        id: taskId,
        name: `Think: ${topic}`,
        description: `Agent ${this.agentId} autonomous thinking about ${topic}`,
        schedule: {
          type: 'interval',
          interval: this.config.interval,
        },
        execution: {
          handler: taskId,
          timeout: 120000, // 2 分钟
        },
        priority: 'low',
        enabled: true,
        metadata: { agentId: this.agentId, topic },
      });

      // 绑定处理器
      scheduler.bindHandler(taskId, () => this.think(topic));
      this.taskDefinitionIds.push(taskId);
    }

    logger.info('Autonomous thinking started', {
      agentId: this.agentId,
      topics: this.config.topics,
      interval: this.config.interval,
    });
  }

  /**
   * 停止自驱思考
   */
  stop(): void {
    const scheduler = getScheduler();

    for (const taskId of this.taskDefinitionIds) {
      scheduler.unregister(taskId);
    }

    this.taskDefinitionIds = [];
    
    logger.info('Autonomous thinking stopped', { agentId: this.agentId });
  }

  /**
   * 执行一次思考
   */
  async think(topic: string): Promise<string | null> {
    if (!this.handler) {
      logger.warn('No thinking handler set', { agentId: this.agentId });
      return null;
    }

    const task: ThinkingTask = {
      id: generateId('think'),
      agentId: this.agentId,
      topic,
      prompt: this.generatePrompt(topic),
      scheduledAt: Date.now(),
      status: 'running',
    };

    this.tasks.set(task.id, task);

    try {
      const result = await this.handler(topic, task.prompt);
      task.status = 'completed';
      task.result = result;

      logger.debug('Thinking completed', {
        agentId: this.agentId,
        taskId: task.id,
        topic,
      });

      return result;
    } catch (error) {
      task.status = 'completed';
      logger.error('Thinking failed', {
        agentId: this.agentId,
        taskId: task.id,
        topic,
        error,
      });
      return null;
    }
  }

  /**
   * 由记忆触发思考
   */
  async triggerFromMemory(memoryContent: string): Promise<string | null> {
    if (!this.config.memoryTriggered) {
      return null;
    }

    // 提取思考主题
    const topic = this.extractTopicFromMemory(memoryContent);
    if (!topic) {
      return null;
    }

    logger.debug('Memory-triggered thinking', {
      agentId: this.agentId,
      topic,
    });

    return this.think(topic);
  }

  /**
   * 获取思考历史
   */
  getHistory(): ThinkingTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.scheduledAt - a.scheduledAt);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AutonomousThinkingConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };

    // 如果状态变化，重新调度
    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 生成思考提示词
   */
  private generatePrompt(topic: string): string {
    const prompts = [
      `请深入思考关于"${topic}"的问题，并提出一些有见地的观点。`,
      `关于"${topic}"，有什么值得探讨的方面？请分享你的思考。`,
      `如果你要向用户解释"${topic}"，你会从哪些角度入手？`,
      `回顾你对"${topic}"的理解，有什么新的认识或想法？`,
    ];

    return prompts[Math.floor(Math.random() * prompts.length)];
  }

  /**
   * 从记忆中提取主题
   */
  private extractTopicFromMemory(content: string): string | null {
    // 简单实现：提取关键词
    const keywords = content
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    // 检查是否与配置的主题相关
    for (const topic of this.config.topics) {
      if (keywords.includes(topic.toLowerCase())) {
        return topic;
      }
    }

    return null;
  }
}
