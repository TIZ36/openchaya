/**
 * MessageStore - 消息存储统一接口
 * 整合 WriteBuffer 和 AsyncPersist，提供统一的消息存储 API
 */

import type {
  Message,
  CreateMessageInput,
  MessageQuery,
  PaginatedResult,
  BufferStatus,
  PersistStatus,
  SlowDBConfig,
} from './types';
import { DEFAULT_SLOWDB_CONFIG } from './types';
import { WriteBuffer } from './WriteBuffer';
import { AsyncPersist } from './AsyncPersist';
import { createLogger } from '../shared/utils';

const logger = createLogger('MessageStore');

/**
 * 消息存储状态
 */
export interface MessageStoreStatus {
  buffer: BufferStatus;
  persist: PersistStatus;
  initialized: boolean;
}

/**
 * 消息存储
 */
export class MessageStore {
  private writeBuffer: WriteBuffer;
  private asyncPersist: AsyncPersist;
  private initialized: boolean = false;

  constructor(config?: Partial<SlowDBConfig>) {
    const fullConfig = { ...DEFAULT_SLOWDB_CONFIG, ...config };
    
    this.writeBuffer = new WriteBuffer(fullConfig.writeBuffer);
    this.asyncPersist = new AsyncPersist(fullConfig);
    
    // 设置刷盘回调
    this.writeBuffer.setFlushCallback(async (sessionId, messages) => {
      await this.asyncPersist.persist(sessionId, messages);
    });
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.asyncPersist.init();
    this.asyncPersist.startAutoFlush();
    this.initialized = true;
    logger.info('MessageStore initialized');
  }

  /**
   * 写入消息（高速，立即返回）
   */
  write(input: CreateMessageInput): Message {
    this.ensureInitialized();
    return this.writeBuffer.write(input);
  }

  /**
   * 批量写入消息
   */
  writeMany(inputs: CreateMessageInput[]): Message[] {
    this.ensureInitialized();
    return inputs.map((input) => this.writeBuffer.write(input));
  }

  /**
   * 读取消息（先查缓冲，再查持久化）
   */
  async read(query: MessageQuery): Promise<PaginatedResult<Message>> {
    this.ensureInitialized();

    const { sessionId, limit = 50, offset = 0 } = query;

    // 从缓冲区读取
    const bufferedMessages = this.writeBuffer.read(sessionId);

    // 从持久化存储读取
    const persistedMessages = await this.asyncPersist.read(sessionId);

    // 合并去重（以 id 为准，缓冲区优先）
    const messageMap = new Map<string, Message>();
    for (const msg of persistedMessages) {
      messageMap.set(msg.id, msg);
    }
    for (const msg of bufferedMessages) {
      messageMap.set(msg.id, msg);
    }

    // 按时间排序
    const allMessages = Array.from(messageMap.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );

    // 应用过滤条件
    let filtered = allMessages;
    if (query.beforeTimestamp) {
      filtered = filtered.filter((m) => m.timestamp < query.beforeTimestamp!);
    }
    if (query.afterTimestamp) {
      filtered = filtered.filter((m) => m.timestamp > query.afterTimestamp!);
    }
    if (query.role) {
      filtered = filtered.filter((m) => m.role === query.role);
    }

    // 分页
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);

    return {
      items,
      total,
      hasMore: offset + limit < total,
    };
  }

  /**
   * 读取最近的消息
   */
  async readRecent(sessionId: string, limit: number = 50): Promise<Message[]> {
    const result = await this.read({ sessionId, limit });
    return result.items.slice(-limit);
  }

  /**
   * 获取单条消息
   */
  async getMessage(sessionId: string, messageId: string): Promise<Message | null> {
    this.ensureInitialized();

    // 先查缓冲区
    const buffered = this.writeBuffer.getMessage(sessionId, messageId);
    if (buffered) return buffered;

    // 再查持久化存储
    const persisted = await this.asyncPersist.read(sessionId);
    return persisted.find((m) => m.id === messageId) || null;
  }

  /**
   * 更新消息
   */
  async updateMessage(
    sessionId: string,
    messageId: string,
    updates: Partial<Message>
  ): Promise<boolean> {
    this.ensureInitialized();

    // 尝试更新缓冲区中的消息
    if (this.writeBuffer.updateMessage(sessionId, messageId, updates)) {
      return true;
    }

    // 如果不在缓冲区，需要读取、更新、重新写入
    const message = await this.getMessage(sessionId, messageId);
    if (!message) return false;

    const updated = { ...message, ...updates };
    await this.asyncPersist.persist(sessionId, [updated]);
    return true;
  }

  /**
   * 删除消息
   */
  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    this.ensureInitialized();

    // 从缓冲区删除
    const deletedFromBuffer = this.writeBuffer.deleteMessage(sessionId, messageId);

    // 从持久化存储删除
    try {
      await this.asyncPersist.delete(messageId);
      return true;
    } catch (error) {
      return deletedFromBuffer;
    }
  }

  /**
   * 删除会话的所有消息
   */
  async deleteSession(sessionId: string): Promise<void> {
    this.ensureInitialized();

    // 清除缓冲区
    this.writeBuffer.clearSession(sessionId);

    // 删除持久化存储
    await this.asyncPersist.deleteSession(sessionId);

    logger.info('Session deleted', { sessionId });
  }

  /**
   * 立即刷盘
   */
  async flush(sessionId?: string): Promise<void> {
    this.ensureInitialized();

    if (sessionId) {
      await this.writeBuffer.flush(sessionId);
    } else {
      await this.writeBuffer.flushAll();
    }
  }

  /**
   * 获取状态
   */
  getStatus(): MessageStoreStatus {
    return {
      buffer: this.writeBuffer.getStatus(),
      persist: this.asyncPersist.getStatus(),
      initialized: this.initialized,
    };
  }

  /**
   * 关闭
   */
  async close(): Promise<void> {
    // 刷盘所有缓冲
    await this.writeBuffer.flushAll();
    // 关闭持久化
    await this.asyncPersist.close();
    this.initialized = false;
    logger.info('MessageStore closed');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MessageStore not initialized. Call init() first.');
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let messageStoreInstance: MessageStore | null = null;

/**
 * 获取消息存储单例
 */
export function getMessageStore(config?: Partial<SlowDBConfig>): MessageStore {
  if (!messageStoreInstance) {
    messageStoreInstance = new MessageStore(config);
  }
  return messageStoreInstance;
}

/**
 * 初始化消息存储
 */
export async function initMessageStore(config?: Partial<SlowDBConfig>): Promise<MessageStore> {
  const store = getMessageStore(config);
  await store.init();
  return store;
}
