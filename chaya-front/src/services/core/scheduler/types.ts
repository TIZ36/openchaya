/**
 * Scheduler Module Types
 * 定时任务调度模块类型定义
 */

// ============================================================================
// Task Types - 任务类型
// ============================================================================

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 任务优先级
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * 调度类型
 */
export type ScheduleType = 'once' | 'interval' | 'cron';

/**
 * 任务定义
 */
export interface TaskDefinition {
  id: string;
  name: string;
  description?: string;
  
  // 调度配置
  schedule: {
    type: ScheduleType;
    delay?: number;           // once 类型的延迟（ms）
    interval?: number;        // interval 类型的间隔（ms）
    cron?: string;            // cron 表达式
    timezone?: string;        // 时区
  };
  
  // 执行配置
  execution: {
    handler: string | (() => Promise<void>);  // 处理函数名或函数
    timeout?: number;         // 超时时间（ms）
    retries?: number;         // 重试次数
    retryDelay?: number;      // 重试延迟（ms）
  };
  
  // 其他配置
  priority?: TaskPriority;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * 任务实例
 */
export interface TaskInstance {
  id: string;
  definitionId: string;
  status: TaskStatus;
  priority: TaskPriority;
  
  // 时间信息
  createdAt: number;
  scheduledAt: number;
  startedAt?: number;
  completedAt?: number;
  
  // 执行信息
  attempts: number;
  lastError?: Error;
  result?: unknown;
  
  // 元数据
  metadata?: Record<string, unknown>;
}

/**
 * 任务执行结果
 */
export interface TaskResult {
  success: boolean;
  duration: number;
  result?: unknown;
  error?: Error;
}

// ============================================================================
// Scheduler Config - 调度器配置
// ============================================================================

/**
 * 调度器配置
 */
export interface SchedulerConfig {
  // 并发配置
  maxConcurrent: number;      // 最大并发任务数
  
  // 队列配置
  maxQueueSize: number;       // 最大队列大小
  
  // 默认执行配置
  defaultTimeout: number;     // 默认超时时间（ms）
  defaultRetries: number;     // 默认重试次数
  defaultRetryDelay: number;  // 默认重试延迟（ms）
  
  // 持久化配置
  persistence?: {
    enabled: boolean;
    storeName: string;
  };
}

/**
 * 默认调度器配置
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrent: 5,
  maxQueueSize: 1000,
  defaultTimeout: 60000,
  defaultRetries: 3,
  defaultRetryDelay: 1000,
  persistence: {
    enabled: false,
    storeName: 'scheduler-tasks',
  },
};

// ============================================================================
// Event Types - 事件类型
// ============================================================================

/**
 * 调度器事件
 */
export type SchedulerEvent =
  | 'task:scheduled'
  | 'task:started'
  | 'task:completed'
  | 'task:failed'
  | 'task:cancelled'
  | 'task:retrying';

/**
 * 调度器事件数据
 */
export interface SchedulerEventData {
  'task:scheduled': { task: TaskInstance };
  'task:started': { task: TaskInstance };
  'task:completed': { task: TaskInstance; result: TaskResult };
  'task:failed': { task: TaskInstance; error: Error };
  'task:cancelled': { task: TaskInstance };
  'task:retrying': { task: TaskInstance; attempt: number };
}
