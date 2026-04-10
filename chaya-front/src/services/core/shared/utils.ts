/**
 * Core Utilities
 * 共享的工具函数
 */

import type { RetryConfig, CleanupFunction } from './types';
import { DEFAULT_RETRY_CONFIG } from './types';
import { isRetryable } from './errors';

// ============================================================================
// Retry Utilities - 重试工具
// ============================================================================

/**
 * 带重试的异步操作
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const {
    maxRetries,
    retryDelay,
    backoffMultiplier = 2,
    maxDelay = 30000,
  } = { ...DEFAULT_RETRY_CONFIG, ...config };

  let lastError: Error | undefined;
  let currentDelay = retryDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // 如果是最后一次尝试或错误不可重试，直接抛出
      if (attempt === maxRetries || !isRetryable(error)) {
        throw error;
      }

      // 等待后重试
      await sleep(currentDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

/**
 * 带超时的异步操作
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage = 'Operation timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * 带取消信号的异步操作
 */
export async function withAbort<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) {
    throw new Error('Operation was aborted');
  }

  const controller = new AbortController();
  const combinedSignal = signal
    ? combineAbortSignals(signal, controller.signal)
    : controller.signal;

  try {
    return await operation(combinedSignal);
  } finally {
    controller.abort();
  }
}

/**
 * 合并多个 AbortSignal
 */
export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  return controller.signal;
}

// ============================================================================
// Async Utilities - 异步工具
// ============================================================================

/**
 * 延迟执行
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 防抖
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;

  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * 节流
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * 并发限制
 */
export async function pLimit<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const p = task().then((result) => {
      results.push(result);
    });

    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(
        executing.findIndex((e) => e === p),
        1
      );
    }
  }

  await Promise.all(executing);
  return results;
}

// ============================================================================
// String Utilities - 字符串工具
// ============================================================================

/**
 * 生成随机 ID
 */
export function generateId(prefix = ''): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`;
}

/**
 * 计算字符串哈希
 */
export function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * 规范化工具名称（用于 OpenAI API）
 * 仅允许 [a-zA-Z0-9_-]，最大 64 字符
 */
export function normalizeToolName(name: string): string {
  const raw = (name || '').trim();
  let normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  normalized = normalized.replace(/_+/g, '_');
  if (!normalized) normalized = 'tool';

  const maxLen = 64;
  if (normalized.length > maxLen) {
    const suffix = Math.abs(hashString(raw)).toString(36).slice(0, 8);
    normalized = `${normalized.slice(0, maxLen - 9)}_${suffix}`;
  }
  return normalized;
}

/**
 * 截断字符串
 */
export function truncate(str: string, maxLength: number, suffix = '...'): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}

// ============================================================================
// Object Utilities - 对象工具
// ============================================================================

/**
 * 深度克隆
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(deepClone) as unknown as T;
  }

  const cloned: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
    }
  }
  return cloned as T;
}

/**
 * 深度合并
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  const result = { ...target };

  for (const source of sources) {
    if (!source) continue;

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = source[key];
        const targetValue = result[key];

        if (
          sourceValue &&
          typeof sourceValue === 'object' &&
          !Array.isArray(sourceValue) &&
          targetValue &&
          typeof targetValue === 'object' &&
          !Array.isArray(targetValue)
        ) {
          (result as Record<string, unknown>)[key] = deepMerge(
            targetValue as Record<string, unknown>,
            sourceValue as Record<string, unknown>
          );
        } else {
          (result as Record<string, unknown>)[key] = sourceValue;
        }
      }
    }
  }

  return result;
}

/**
 * 从对象中选取指定键
 */
export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * 从对象中排除指定键
 */
export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

// ============================================================================
// Cleanup Utilities - 清理工具
// ============================================================================

/**
 * 创建清理函数集合
 */
export function createCleanupManager(): {
  add: (cleanup: CleanupFunction) => void;
  runAll: () => Promise<void>;
} {
  const cleanups: CleanupFunction[] = [];

  return {
    add: (cleanup: CleanupFunction) => {
      cleanups.push(cleanup);
    },
    runAll: async () => {
      const errors: Error[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error as Error);
        }
      }
      cleanups.length = 0;
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Cleanup failed');
      }
    },
  };
}

// ============================================================================
// Logging Utilities - 日志工具
// ============================================================================

/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 创建带前缀的 logger
 */
export function createLogger(prefix: string) {
  const formatMessage = (level: LogLevel, ...args: unknown[]) => {
    const timestamp = new Date().toISOString();
    return [`[${timestamp}] [${prefix}] [${level.toUpperCase()}]`, ...args];
  };

  return {
    debug: (...args: unknown[]) => {
      if (process.env.NODE_ENV === 'development') {
        console.debug(...formatMessage('debug', ...args));
      }
    },
    info: (...args: unknown[]) => {
      console.info(...formatMessage('info', ...args));
    },
    warn: (...args: unknown[]) => {
      console.warn(...formatMessage('warn', ...args));
    },
    error: (...args: unknown[]) => {
      console.error(...formatMessage('error', ...args));
    },
  };
}
