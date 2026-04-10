/**
 * TaskScheduler - 任务调度器
 * 支持一次性、定时间隔、Cron 表达式的任务调度
 */

import type {
  TaskDefinition,
  TaskInstance,
  TaskResult,
  TaskStatus,
  SchedulerConfig,
  SchedulerEvent,
  SchedulerEventData,
} from './types';
import { DEFAULT_SCHEDULER_CONFIG } from './types';
import { generateId, createLogger, sleep } from '../shared/utils';
import type { EventHandler, Unsubscribe } from '../shared/types';

const logger = createLogger('TaskScheduler');

/**
 * 任务调度器
 */
export class TaskScheduler {
  private config: SchedulerConfig;
  private definitions: Map<string, TaskDefinition> = new Map();
  private instances: Map<string, TaskInstance> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout | typeof setInterval>> = new Map();
  private handlers: Map<string, () => Promise<void>> = new Map();
  private eventListeners: Map<SchedulerEvent, Set<EventHandler<unknown>>> = new Map();
  private runningCount: number = 0;
  private queue: TaskInstance[] = [];
  private isRunning: boolean = false;

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  // ============================================================================
  // Task Definition Management
  // ============================================================================

  /**
   * 注册任务定义
   */
  register(definition: TaskDefinition): void {
    this.definitions.set(definition.id, definition);
    
    // 如果处理函数是字符串，需要后续绑定
    if (typeof definition.execution.handler === 'function') {
      this.handlers.set(definition.id, definition.execution.handler);
    }

    // 如果启用，立即调度
    if (definition.enabled !== false) {
      this.scheduleDefinition(definition);
    }

    logger.info('Task registered', { id: definition.id, name: definition.name });
  }

  /**
   * 注销任务定义
   */
  unregister(definitionId: string): void {
    // 取消相关定时器
    const timer = this.timers.get(definitionId);
    if (timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
      clearInterval(timer as ReturnType<typeof setInterval>);
      this.timers.delete(definitionId);
    }

    // 取消相关实例
    this.instances.forEach((instance, id) => {
      if (instance.definitionId === definitionId && instance.status === 'pending') {
        this.cancel(id);
      }
    });

    this.definitions.delete(definitionId);
    this.handlers.delete(definitionId);

    logger.info('Task unregistered', { id: definitionId });
  }

  /**
   * 绑定处理函数
   */
  bindHandler(definitionId: string, handler: () => Promise<void>): void {
    this.handlers.set(definitionId, handler);
  }

  // ============================================================================
  // Task Execution
  // ============================================================================

  /**
   * 立即执行任务
   */
  async executeNow(definitionId: string, metadata?: Record<string, unknown>): Promise<TaskResult> {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new Error(`Task definition not found: ${definitionId}`);
    }

    const instance = this.createInstance(definition, Date.now(), metadata);
    this.instances.set(instance.id, instance);

    return this.executeInstance(instance);
  }

  /**
   * 调度任务
   */
  schedule(
    definitionId: string,
    scheduledAt: number,
    metadata?: Record<string, unknown>
  ): TaskInstance {
    const definition = this.definitions.get(definitionId);
    if (!definition) {
      throw new Error(`Task definition not found: ${definitionId}`);
    }

    const instance = this.createInstance(definition, scheduledAt, metadata);
    this.instances.set(instance.id, instance);

    // 计算延迟
    const delay = scheduledAt - Date.now();
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.enqueue(instance);
      }, delay);
      this.timers.set(instance.id, timer);
    } else {
      this.enqueue(instance);
    }

    this.emit('task:scheduled', { task: instance });
    logger.debug('Task scheduled', { id: instance.id, scheduledAt });

    return instance;
  }

  /**
   * 取消任务
   */
  cancel(instanceId: string): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;

    if (instance.status !== 'pending') {
      return false;
    }

    // 清除定时器
    const timer = this.timers.get(instanceId);
    if (timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
      this.timers.delete(instanceId);
    }

    // 从队列中移除
    const index = this.queue.findIndex((t) => t.id === instanceId);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }

    // 更新状态
    instance.status = 'cancelled';
    this.emit('task:cancelled', { task: instance });

    logger.debug('Task cancelled', { id: instanceId });
    return true;
  }

  // ============================================================================
  // Task Query
  // ============================================================================

  /**
   * 获取任务实例
   */
  getInstance(instanceId: string): TaskInstance | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * 获取所有任务实例
   */
  getInstances(status?: TaskStatus): TaskInstance[] {
    const instances = Array.from(this.instances.values());
    if (status) {
      return instances.filter((i) => i.status === status);
    }
    return instances;
  }

  /**
   * 获取任务定义
   */
  getDefinition(definitionId: string): TaskDefinition | undefined {
    return this.definitions.get(definitionId);
  }

  /**
   * 获取所有任务定义
   */
  getDefinitions(): TaskDefinition[] {
    return Array.from(this.definitions.values());
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * 订阅事件
   */
  on<T extends SchedulerEvent>(
    event: T,
    handler: EventHandler<SchedulerEventData[T]>
  ): Unsubscribe {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler as EventHandler<unknown>);

    return () => {
      this.eventListeners.get(event)?.delete(handler as EventHandler<unknown>);
    };
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * 启动调度器
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.processQueue();
    logger.info('Scheduler started');
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.isRunning = false;
    
    // 清除所有定时器
    this.timers.forEach((timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
      clearInterval(timer as ReturnType<typeof setInterval>);
    });
    this.timers.clear();

    logger.info('Scheduler stopped');
  }

  /**
   * 清理已完成的任务
   */
  cleanup(olderThan?: number): number {
    const threshold = olderThan ?? Date.now() - 24 * 60 * 60 * 1000; // 默认清理 24 小时前的
    let count = 0;

    this.instances.forEach((instance, id) => {
      if (
        (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'cancelled') &&
        (instance.completedAt ?? instance.createdAt) < threshold
      ) {
        this.instances.delete(id);
        count++;
      }
    });

    logger.info('Cleanup completed', { removed: count });
    return count;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 根据定义调度任务
   */
  private scheduleDefinition(definition: TaskDefinition): void {
    const { schedule } = definition;

    switch (schedule.type) {
      case 'once': {
        const delay = schedule.delay ?? 0;
        const timer = setTimeout(() => {
          this.executeNow(definition.id).catch((error) => {
            logger.error('Task execution failed', { id: definition.id, error });
          });
        }, delay);
        this.timers.set(definition.id, timer);
        break;
      }

      case 'interval': {
        const interval = schedule.interval ?? 60000;
        const timer = setInterval(() => {
          this.executeNow(definition.id).catch((error) => {
            logger.error('Task execution failed', { id: definition.id, error });
          });
        }, interval);
        this.timers.set(definition.id, timer);
        break;
      }

      case 'cron': {
        // 简化的 cron 实现，实际项目中可以使用 cron-parser 库
        logger.warn('Cron scheduling not fully implemented', { id: definition.id });
        break;
      }
    }
  }

  /**
   * 创建任务实例
   */
  private createInstance(
    definition: TaskDefinition,
    scheduledAt: number,
    metadata?: Record<string, unknown>
  ): TaskInstance {
    return {
      id: generateId('task'),
      definitionId: definition.id,
      status: 'pending',
      priority: definition.priority ?? 'normal',
      createdAt: Date.now(),
      scheduledAt,
      attempts: 0,
      metadata: { ...definition.metadata, ...metadata },
    };
  }

  /**
   * 将任务加入队列
   */
  private enqueue(instance: TaskInstance): void {
    if (this.queue.length >= this.config.maxQueueSize) {
      logger.warn('Queue full, task dropped', { id: instance.id });
      return;
    }

    // 按优先级插入
    const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
    const insertIndex = this.queue.findIndex(
      (t) => priorityOrder[t.priority] > priorityOrder[instance.priority]
    );

    if (insertIndex === -1) {
      this.queue.push(instance);
    } else {
      this.queue.splice(insertIndex, 0, instance);
    }

    this.processQueue();
  }

  /**
   * 处理队列
   */
  private async processQueue(): Promise<void> {
    if (!this.isRunning) return;

    while (this.queue.length > 0 && this.runningCount < this.config.maxConcurrent) {
      const instance = this.queue.shift();
      if (!instance) break;

      this.runningCount++;
      this.executeInstance(instance)
        .finally(() => {
          this.runningCount--;
          this.processQueue();
        });
    }
  }

  /**
   * 执行任务实例
   */
  private async executeInstance(instance: TaskInstance): Promise<TaskResult> {
    const definition = this.definitions.get(instance.definitionId);
    if (!definition) {
      const error = new Error(`Definition not found: ${instance.definitionId}`);
      return { success: false, duration: 0, error };
    }

    const handler = this.handlers.get(instance.definitionId);
    if (!handler) {
      const error = new Error(`Handler not found: ${instance.definitionId}`);
      return { success: false, duration: 0, error };
    }

    const timeout = definition.execution.timeout ?? this.config.defaultTimeout;
    const maxRetries = definition.execution.retries ?? this.config.defaultRetries;
    const retryDelay = definition.execution.retryDelay ?? this.config.defaultRetryDelay;

    instance.status = 'running';
    instance.startedAt = Date.now();
    this.emit('task:started', { task: instance });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      instance.attempts = attempt + 1;

      try {
        const startTime = Date.now();
        
        // 带超时执行
        await Promise.race([
          handler(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Task timeout')), timeout)
          ),
        ]);

        const duration = Date.now() - startTime;
        instance.status = 'completed';
        instance.completedAt = Date.now();

        const result: TaskResult = { success: true, duration };
        this.emit('task:completed', { task: instance, result });

        return result;
      } catch (error) {
        lastError = error as Error;
        instance.lastError = lastError;

        if (attempt < maxRetries) {
          this.emit('task:retrying', { task: instance, attempt: attempt + 1 });
          await sleep(retryDelay * Math.pow(2, attempt));
        }
      }
    }

    instance.status = 'failed';
    instance.completedAt = Date.now();
    const duration = Date.now() - (instance.startedAt ?? Date.now());

    this.emit('task:failed', { task: instance, error: lastError! });

    return { success: false, duration, error: lastError };
  }

  /**
   * 发送事件
   */
  private emit<T extends SchedulerEvent>(event: T, data: SchedulerEventData[T]): void {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          logger.error('Event handler error', { event, error });
        }
      });
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let schedulerInstance: TaskScheduler | null = null;

/**
 * 获取调度器单例
 */
export function getScheduler(config?: Partial<SchedulerConfig>): TaskScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new TaskScheduler(config);
  }
  return schedulerInstance;
}

/**
 * 初始化并启动调度器
 */
export function initScheduler(config?: Partial<SchedulerConfig>): TaskScheduler {
  const scheduler = getScheduler(config);
  scheduler.start();
  return scheduler;
}
