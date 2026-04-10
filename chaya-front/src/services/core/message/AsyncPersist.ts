/**
 * AsyncPersist - 异步持久化
 * 定时批量写入 IndexedDB，写入失败重试，数据一致性保证
 */

import type { Message, SlowDBConfig, PersistStatus } from './types';
import { DEFAULT_SLOWDB_CONFIG } from './types';
import { createLogger, sleep } from '../shared/utils';
import { MessageError, MessageErrorCode } from '../shared/errors';

const logger = createLogger('AsyncPersist');

/**
 * IndexedDB 封装
 */
class IndexedDBWrapper {
  private db: IDBDatabase | null = null;
  private config: SlowDBConfig['database'];

  constructor(config: SlowDBConfig['database']) {
    this.config = config;
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.config.name, this.config.version);

      request.onerror = () => {
        reject(new MessageError('Failed to open database', {
          code: MessageErrorCode.STORE_FAILED,
          cause: request.error ?? undefined,
        }));
      };

      request.onsuccess = () => {
        this.db = request.result;
        logger.info('Database opened', { name: this.config.name });
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建消息存储
        if (!db.objectStoreNames.contains(this.config.storeName)) {
          const store = db.createObjectStore(this.config.storeName, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('sessionId_timestamp', ['sessionId', 'timestamp'], { unique: false });
          logger.info('Object store created', { name: this.config.storeName });
        }
      };
    });
  }

  /**
   * 写入消息
   */
  async write(messages: Message[]): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(new MessageError('Transaction failed', {
          code: MessageErrorCode.STORE_FAILED,
          cause: transaction.error ?? undefined,
        }));
      };

      for (const message of messages) {
        store.put(message);
      }
    });
  }

  /**
   * 读取消息
   */
  async read(sessionId: string, limit?: number): Promise<Message[]> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName, 'readonly');
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index('sessionId_timestamp');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);

      const messages: Message[] = [];
      const request = index.openCursor(range, 'prev'); // 按时间倒序

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor && (!limit || messages.length < limit)) {
          messages.unshift(cursor.value); // 添加到开头保持正序
          cursor.continue();
        } else {
          resolve(messages);
        }
      };

      request.onerror = () => {
        reject(new MessageError('Failed to read messages', {
          code: MessageErrorCode.RETRIEVE_FAILED,
          sessionId,
          cause: request.error ?? undefined,
        }));
      };
    });
  }

  /**
   * 删除消息
   */
  async delete(messageId: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);
      const request = store.delete(messageId);

      request.onsuccess = () => resolve();
      request.onerror = () => {
        reject(new MessageError('Failed to delete message', {
          code: MessageErrorCode.STORE_FAILED,
          messageId,
          cause: request.error ?? undefined,
        }));
      };
    });
  }

  /**
   * 删除会话的所有消息
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName, 'readwrite');
      const store = transaction.objectStore(this.config.storeName);
      const index = store.index('sessionId');
      const range = IDBKeyRange.only(sessionId);

      const request = index.openCursor(range);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        reject(new MessageError('Failed to delete session', {
          code: MessageErrorCode.STORE_FAILED,
          sessionId,
          cause: transaction.error ?? undefined,
        }));
      };
    });
  }

  /**
   * 获取消息数量
   */
  async count(sessionId?: string): Promise<number> {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(this.config.storeName, 'readonly');
      const store = transaction.objectStore(this.config.storeName);

      let request: IDBRequest;
      if (sessionId) {
        const index = store.index('sessionId');
        request = index.count(IDBKeyRange.only(sessionId));
      } else {
        request = store.count();
      }

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        reject(new MessageError('Failed to count messages', {
          code: MessageErrorCode.RETRIEVE_FAILED,
          sessionId,
          cause: request.error ?? undefined,
        }));
      };
    });
  }

  /**
   * 关闭数据库
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('Database closed');
    }
  }
}

/**
 * 异步持久化器
 */
export class AsyncPersist {
  private db: IndexedDBWrapper;
  private config: SlowDBConfig['persist'];
  private pendingQueue: Map<string, Message[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastFlushTime?: number;
  private lastError?: Error;
  private isProcessing: boolean = false;

  constructor(config?: Partial<SlowDBConfig>) {
    const fullConfig = { ...DEFAULT_SLOWDB_CONFIG, ...config };
    this.config = fullConfig.persist;
    this.db = new IndexedDBWrapper(fullConfig.database);
  }

  /**
   * 初始化
   */
  async init(): Promise<void> {
    await this.db.init();
  }

  /**
   * 开始定时刷盘
   */
  startAutoFlush(interval: number = DEFAULT_SLOWDB_CONFIG.writeBuffer.flushInterval): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(() => {
      this.processQueue().catch((error) => {
        logger.error('Auto flush failed', { error });
      });
    }, interval);

    logger.info('Auto flush started', { interval });
  }

  /**
   * 停止定时刷盘
   */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
      logger.info('Auto flush stopped');
    }
  }

  /**
   * 添加到持久化队列
   */
  enqueue(sessionId: string, messages: Message[]): void {
    const existing = this.pendingQueue.get(sessionId) || [];
    this.pendingQueue.set(sessionId, [...existing, ...messages]);
    logger.debug('Enqueued messages', { sessionId, count: messages.length });
  }

  /**
   * 立即持久化
   */
  async persist(sessionId: string, messages: Message[]): Promise<void> {
    await this.writeWithRetry(messages);
    logger.debug('Persisted messages', { sessionId, count: messages.length });
  }

  /**
   * 读取持久化的消息
   */
  async read(sessionId: string, limit?: number): Promise<Message[]> {
    return this.db.read(sessionId, limit);
  }

  /**
   * 删除消息
   */
  async delete(messageId: string): Promise<void> {
    return this.db.delete(messageId);
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<void> {
    // 清除队列中的待处理消息
    this.pendingQueue.delete(sessionId);
    // 删除持久化的消息
    return this.db.deleteSession(sessionId);
  }

  /**
   * 获取状态
   */
  getStatus(): PersistStatus {
    let pending = 0;
    this.pendingQueue.forEach((messages) => {
      pending += messages.length;
    });

    return {
      pending,
      lastFlushTime: this.lastFlushTime,
      lastError: this.lastError,
    };
  }

  /**
   * 关闭
   */
  async close(): Promise<void> {
    this.stopAutoFlush();
    await this.processQueue(); // 处理剩余队列
    this.db.close();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 处理队列
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.pendingQueue.size === 0) return;

    this.isProcessing = true;
    const errors: Error[] = [];

    try {
      const entries = Array.from(this.pendingQueue.entries());
      
      for (const [sessionId, messages] of entries) {
        if (messages.length === 0) continue;

        try {
          // 批量写入
          const batches = this.splitIntoBatches(messages, this.config.batchSize);
          for (const batch of batches) {
            await this.writeWithRetry(batch);
          }

          // 成功后清除队列
          this.pendingQueue.delete(sessionId);
          logger.debug('Processed queue', { sessionId, count: messages.length });
        } catch (error) {
          errors.push(error as Error);
          this.lastError = error as Error;
        }
      }

      this.lastFlushTime = Date.now();
    } finally {
      this.isProcessing = false;
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'Some sessions failed to persist');
    }
  }

  /**
   * 带重试的写入
   */
  private async writeWithRetry(messages: Message[]): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.config.retryTimes; attempt++) {
      try {
        await this.db.write(messages);
        return;
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.config.retryTimes - 1) {
          await sleep(this.config.retryDelay * Math.pow(2, attempt));
        }
      }
    }

    throw lastError;
  }

  /**
   * 分割成批次
   */
  private splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}
