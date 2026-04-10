/**
 * Mailbox - Agent 消息队列
 * 实现 Actor 模型的消息队列
 */

import type { MailboxMessage, MailboxConfig, MessagePriority } from '../../types';
import { DEFAULT_MAILBOX_CONFIG } from '../../types';
import { generateId, createLogger } from '../../../core/shared/utils';
import { eventBus } from '../../../core/shared/events';

const logger = createLogger('Mailbox');

/**
 * 消息处理回调
 */
export type MessageHandler = (message: MailboxMessage) => Promise<void>;

/**
 * 邮箱
 */
export class Mailbox {
  private agentId: string;
  private config: MailboxConfig;
  private queue: MailboxMessage[] = [];
  private handler?: MessageHandler;
  private isProcessing: boolean = false;
  private processingTimer?: ReturnType<typeof setTimeout>;

  constructor(agentId: string, config?: Partial<MailboxConfig>) {
    this.agentId = agentId;
    this.config = { ...DEFAULT_MAILBOX_CONFIG, ...config };
  }

  /**
   * 设置消息处理器
   */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * 发送消息到邮箱
   */
  send(
    senderId: string,
    senderName: string,
    content: string,
    options: {
      priority?: MessagePriority;
      replyTo?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): MailboxMessage {
    // 检查队列大小
    if (this.queue.length >= this.config.maxSize) {
      logger.warn('Mailbox full, dropping oldest message', {
        agentId: this.agentId,
        queueSize: this.queue.length,
      });
      this.queue.shift();
    }

    const message: MailboxMessage = {
      id: generateId('msg'),
      senderId,
      senderName,
      content,
      priority: options.priority || 'normal',
      timestamp: Date.now(),
      replyTo: options.replyTo,
      metadata: options.metadata,
    };

    // 按优先级插入
    this.enqueue(message);

    // 触发事件
    eventBus.emit('agent:message_received', {
      agentId: this.agentId,
      messageId: message.id,
      sender: senderName,
    });

    // 开始处理
    this.scheduleProcessing();

    logger.debug('Message enqueued', {
      agentId: this.agentId,
      messageId: message.id,
      priority: message.priority,
      queueSize: this.queue.length,
    });

    return message;
  }

  /**
   * 获取队列长度
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * 检查是否为空
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * 获取下一条消息（不移除）
   */
  peek(): MailboxMessage | undefined {
    return this.queue[0];
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
    logger.debug('Mailbox cleared', { agentId: this.agentId });
  }

  /**
   * 暂停处理
   */
  pause(): void {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = undefined;
    }
  }

  /**
   * 恢复处理
   */
  resume(): void {
    this.scheduleProcessing();
  }

  /**
   * 获取队列快照
   */
  getMessages(): MailboxMessage[] {
    return [...this.queue];
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 入队（按优先级）
   */
  private enqueue(message: MailboxMessage): void {
    const priorityOrder: Record<MessagePriority, number> = {
      urgent: 0,
      high: 1,
      normal: 2,
      low: 3,
    };

    // 找到插入位置
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (priorityOrder[message.priority] < priorityOrder[this.queue[i].priority]) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, message);

    // 优先级提升：长时间等待的消息提升优先级
    if (this.config.priorityBoost) {
      this.boostOldMessages();
    }
  }

  /**
   * 提升旧消息优先级
   */
  private boostOldMessages(): void {
    const now = Date.now();
    const boostThreshold = 30000; // 30 秒

    for (const msg of this.queue) {
      if (now - msg.timestamp > boostThreshold && msg.priority === 'normal') {
        msg.priority = 'high';
      }
    }
  }

  /**
   * 调度处理
   */
  private scheduleProcessing(): void {
    if (this.isProcessing || !this.handler || this.processingTimer) return;

    this.processingTimer = setTimeout(() => {
      this.processingTimer = undefined;
      this.processNext();
    }, this.config.processingDelay);
  }

  /**
   * 处理下一条消息
   */
  private async processNext(): Promise<void> {
    if (this.isProcessing || !this.handler || this.isEmpty) return;

    this.isProcessing = true;
    const message = this.queue.shift()!;

    try {
      await this.handler(message);

      eventBus.emit('agent:message_processed', {
        agentId: this.agentId,
        messageId: message.id,
        duration: Date.now() - message.timestamp,
      });

      logger.debug('Message processed', {
        agentId: this.agentId,
        messageId: message.id,
      });
    } catch (error) {
      logger.error('Message processing failed', {
        agentId: this.agentId,
        messageId: message.id,
        error,
      });
    } finally {
      this.isProcessing = false;
      
      // 继续处理下一条
      if (!this.isEmpty) {
        this.scheduleProcessing();
      }
    }
  }
}
