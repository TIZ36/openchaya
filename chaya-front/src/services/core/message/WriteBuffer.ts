/**
 * WriteBuffer - 内存写缓冲
 * 实现高速写入，批量合并，LRU 淘汰
 */

import type { Message, CreateMessageInput, BufferStatus, SlowDBConfig } from './types';
import { DEFAULT_SLOWDB_CONFIG } from './types';
import { generateId, createLogger } from '../shared/utils';
import { eventBus } from '../shared/events';

const logger = createLogger('WriteBuffer');

/**
 * 写缓冲区
 */
export class WriteBuffer {
  private buffer: Map<string, Message[]> = new Map();
  private config: SlowDBConfig['writeBuffer'];
  private totalMessages: number = 0;
  private flushCallback?: (sessionId: string, messages: Message[]) => Promise<void>;

  constructor(config?: Partial<SlowDBConfig['writeBuffer']>) {
    this.config = { ...DEFAULT_SLOWDB_CONFIG.writeBuffer, ...config };
  }

  /**
   * 设置刷盘回调
   */
  setFlushCallback(callback: (sessionId: string, messages: Message[]) => Promise<void>): void {
    this.flushCallback = callback;
  }

  /**
   * 写入消息（同步，立即返回）
   */
  write(input: CreateMessageInput): Message {
    const message: Message = {
      id: generateId('msg'),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      timestamp: Date.now(),
      toolCallId: input.toolCallId,
      toolCalls: input.toolCalls,
      media: input.media,
      thinking: input.thinking,
      metadata: input.metadata,
    };

    // 获取或创建会话缓冲区
    let sessionBuffer = this.buffer.get(input.sessionId);
    if (!sessionBuffer) {
      sessionBuffer = [];
      this.buffer.set(input.sessionId, sessionBuffer);
    }

    // 添加消息
    sessionBuffer.push(message);
    this.totalMessages++;

    // 发送事件
    eventBus.emit('message:created', {
      sessionId: input.sessionId,
      messageId: message.id,
      role: input.role,
    });

    // 检查是否需要刷盘
    if (sessionBuffer.length >= this.config.flushThreshold) {
      this.scheduleFlush(input.sessionId);
    }

    // 检查总容量，执行 LRU 淘汰
    if (this.totalMessages > this.config.maxSize) {
      this.evictOldest();
    }

    logger.debug('Message written', { sessionId: input.sessionId, messageId: message.id });
    return message;
  }

  /**
   * 读取消息（先查缓冲）
   */
  read(sessionId: string, limit?: number): Message[] {
    const sessionBuffer = this.buffer.get(sessionId) || [];
    if (limit && limit > 0) {
      return sessionBuffer.slice(-limit);
    }
    return [...sessionBuffer];
  }

  /**
   * 读取所有会话的消息
   */
  readAll(): Map<string, Message[]> {
    const result = new Map<string, Message[]>();
    this.buffer.forEach((messages, sessionId) => {
      result.set(sessionId, [...messages]);
    });
    return result;
  }

  /**
   * 获取指定消息
   */
  getMessage(sessionId: string, messageId: string): Message | undefined {
    const sessionBuffer = this.buffer.get(sessionId);
    return sessionBuffer?.find((m) => m.id === messageId);
  }

  /**
   * 更新消息
   */
  updateMessage(sessionId: string, messageId: string, updates: Partial<Message>): boolean {
    const sessionBuffer = this.buffer.get(sessionId);
    if (!sessionBuffer) return false;

    const index = sessionBuffer.findIndex((m) => m.id === messageId);
    if (index === -1) return false;

    sessionBuffer[index] = { ...sessionBuffer[index], ...updates };

    eventBus.emit('message:updated', { sessionId, messageId });
    return true;
  }

  /**
   * 删除消息
   */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const sessionBuffer = this.buffer.get(sessionId);
    if (!sessionBuffer) return false;

    const index = sessionBuffer.findIndex((m) => m.id === messageId);
    if (index === -1) return false;

    sessionBuffer.splice(index, 1);
    this.totalMessages--;

    if (sessionBuffer.length === 0) {
      this.buffer.delete(sessionId);
    }

    eventBus.emit('message:deleted', { sessionId, messageId });
    return true;
  }

  /**
   * 获取缓冲区状态
   */
  getStatus(): BufferStatus {
    let oldestTimestamp: number | undefined;
    let newestTimestamp: number | undefined;

    this.buffer.forEach((messages) => {
      for (const msg of messages) {
        if (!oldestTimestamp || msg.timestamp < oldestTimestamp) {
          oldestTimestamp = msg.timestamp;
        }
        if (!newestTimestamp || msg.timestamp > newestTimestamp) {
          newestTimestamp = msg.timestamp;
        }
      }
    });

    return {
      sessionCount: this.buffer.size,
      totalMessages: this.totalMessages,
      oldestTimestamp,
      newestTimestamp,
    };
  }

  /**
   * 刷盘指定会话
   */
  async flush(sessionId: string): Promise<void> {
    const messages = this.buffer.get(sessionId);
    if (!messages || messages.length === 0) return;

    // 清空缓冲区
    const toFlush = [...messages];
    this.buffer.set(sessionId, []);
    this.totalMessages -= toFlush.length;

    // 调用回调
    if (this.flushCallback) {
      try {
        await this.flushCallback(sessionId, toFlush);
        eventBus.emit('message:flushed', { sessionId, count: toFlush.length });
        logger.info('Flushed messages', { sessionId, count: toFlush.length });
      } catch (error) {
        // 刷盘失败，恢复缓冲区
        const current = this.buffer.get(sessionId) || [];
        this.buffer.set(sessionId, [...toFlush, ...current]);
        this.totalMessages += toFlush.length;
        logger.error('Flush failed, restored buffer', { sessionId, error });
        throw error;
      }
    }
  }

  /**
   * 刷盘所有会话
   */
  async flushAll(): Promise<void> {
    const sessionIds = Array.from(this.buffer.keys());
    const errors: Error[] = [];

    for (const sessionId of sessionIds) {
      try {
        await this.flush(sessionId);
      } catch (error) {
        errors.push(error as Error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Some sessions failed to flush');
    }
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer.clear();
    this.totalMessages = 0;
    logger.info('Buffer cleared');
  }

  /**
   * 清空指定会话
   */
  clearSession(sessionId: string): void {
    const messages = this.buffer.get(sessionId);
    if (messages) {
      this.totalMessages -= messages.length;
      this.buffer.delete(sessionId);
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 调度刷盘
   */
  private scheduleFlush(sessionId: string): void {
    // 使用 queueMicrotask 异步刷盘，不阻塞写入
    queueMicrotask(() => {
      this.flush(sessionId).catch((error) => {
        logger.error('Scheduled flush failed', { sessionId, error });
      });
    });
  }

  /**
   * LRU 淘汰最旧的消息
   */
  private evictOldest(): void {
    let oldestSession: string | null = null;
    let oldestTimestamp = Infinity;

    // 找到最旧的会话
    this.buffer.forEach((messages, sessionId) => {
      if (messages.length > 0 && messages[0].timestamp < oldestTimestamp) {
        oldestTimestamp = messages[0].timestamp;
        oldestSession = sessionId;
      }
    });

    // 强制刷盘最旧的会话
    if (oldestSession) {
      this.scheduleFlush(oldestSession);
    }
  }
}
