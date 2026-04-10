/**
 * HealthMonitor - MCP 健康监控
 * 定期检查连接健康状态，自动重连不健康的连接
 */

import type {
  MCPServer,
  HealthConfig,
  HealthCheckResult,
  HealthStatus,
} from './types';
import { DEFAULT_HEALTH_CONFIG } from './types';
import { ConnectionPool } from './ConnectionPool';
import { createLogger } from '../../core/shared/utils';
import { eventBus } from '../../core/shared/events';

const logger = createLogger('HealthMonitor');

/**
 * 服务器健康状态
 */
interface ServerHealthState {
  serverId: string;
  status: HealthStatus;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  lastCheckTime?: number;
  lastCheckResult?: HealthCheckResult;
  history: HealthCheckResult[];
}

/**
 * 健康监控器
 */
export class HealthMonitor {
  private config: HealthConfig;
  private pool: ConnectionPool;
  private healthStates: Map<string, ServerHealthState> = new Map();
  private checkInterval?: ReturnType<typeof setInterval>;
  private isRunning: boolean = false;
  private readonly MAX_HISTORY = 10;

  constructor(pool: ConnectionPool, config?: Partial<HealthConfig>) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
    this.pool = pool;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * 启动监控
   */
  start(): void {
    if (this.isRunning || !this.config.enabled) return;

    this.isRunning = true;

    // 初始化健康状态
    for (const server of this.pool.getServers()) {
      this.initHealthState(server.id);
    }

    // 启动定期检查
    this.checkInterval = setInterval(() => {
      this.checkAll().catch((error) => {
        logger.error('Health check failed', { error });
      });
    }, this.config.interval);

    // 立即执行一次检查
    this.checkAll().catch((error) => {
      logger.error('Initial health check failed', { error });
    });

    logger.info('Health monitor started', { interval: this.config.interval });
  }

  /**
   * 停止监控
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }

    logger.info('Health monitor stopped');
  }

  // ============================================================================
  // Health Checks
  // ============================================================================

  /**
   * 检查所有服务器
   */
  async checkAll(): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>();

    for (const server of this.pool.getServers()) {
      if (!server.enabled) continue;

      try {
        const result = await this.checkServer(server.id);
        results.set(server.id, result);
      } catch (error) {
        const result: HealthCheckResult = {
          serverId: server.id,
          healthy: false,
          error: error as Error,
          timestamp: Date.now(),
        };
        results.set(server.id, result);
        this.updateHealthState(server.id, result);
      }
    }

    return results;
  }

  /**
   * 检查单个服务器
   */
  async checkServer(serverId: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // 尝试获取工具列表作为健康检查（标准 MCP 请求 tools/list）
      const client = await this.pool.acquire(serverId, this.config.timeout);
      
      try {
        await client.healthCheck();
        
        const result: HealthCheckResult = {
          serverId,
          healthy: true,
          latency: Date.now() - startTime,
          timestamp: Date.now(),
        };

        this.updateHealthState(serverId, result);
        return result;
      } finally {
        this.pool.release(client);
      }
    } catch (error) {
      const result: HealthCheckResult = {
        serverId,
        healthy: false,
        error: error as Error,
        latency: Date.now() - startTime,
        timestamp: Date.now(),
      };

      this.updateHealthState(serverId, result);

      // 关键：健康检查失败后驱动连接池自愈
      // - 剔除坏连接释放容量
      // - 补齐 minConnections，确保后续调用能重新建联
      try {
        await this.pool.recoverServer(serverId);
      } catch (recoverError) {
        logger.warn('Failed to recover server after unhealthy check', { serverId, recoverError });
      }

      return result;
    }
  }

  /**
   * 获取服务器健康状态
   */
  getHealthStatus(serverId: string): HealthStatus {
    const state = this.healthStates.get(serverId);
    return state?.status || 'unknown';
  }

  /**
   * 获取所有健康状态
   */
  getAllHealthStatus(): Map<string, HealthStatus> {
    const result = new Map<string, HealthStatus>();
    this.healthStates.forEach((state, serverId) => {
      result.set(serverId, state.status);
    });
    return result;
  }

  /**
   * 获取健康检查历史
   */
  getHistory(serverId: string): HealthCheckResult[] {
    const state = this.healthStates.get(serverId);
    return state?.history || [];
  }

  /**
   * 获取健康的服务器列表
   */
  getHealthyServers(): string[] {
    const healthy: string[] = [];
    this.healthStates.forEach((state, serverId) => {
      if (state.status === 'healthy') {
        healthy.push(serverId);
      }
    });
    return healthy;
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * 处理服务器添加
   */
  onServerAdded(serverId: string): void {
    this.initHealthState(serverId);
    
    // 立即检查新服务器
    this.checkServer(serverId).catch((error) => {
      logger.warn('Failed to check new server', { serverId, error });
    });
  }

  /**
   * 处理服务器移除
   */
  onServerRemoved(serverId: string): void {
    this.healthStates.delete(serverId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 初始化健康状态
   */
  private initHealthState(serverId: string): void {
    if (this.healthStates.has(serverId)) return;

    this.healthStates.set(serverId, {
      serverId,
      status: 'unknown',
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      history: [],
    });
  }

  /**
   * 更新健康状态
   */
  private updateHealthState(serverId: string, result: HealthCheckResult): void {
    let state = this.healthStates.get(serverId);
    
    if (!state) {
      state = {
        serverId,
        status: 'unknown',
        consecutiveSuccesses: 0,
        consecutiveFailures: 0,
        history: [],
      };
      this.healthStates.set(serverId, state);
    }

    const previousStatus = state.status;

    // 更新计数器
    if (result.healthy) {
      state.consecutiveSuccesses++;
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures++;
      state.consecutiveSuccesses = 0;
    }

    // 更新状态
    if (state.consecutiveFailures >= this.config.unhealthyThreshold) {
      state.status = 'unhealthy';
    } else if (state.consecutiveSuccesses >= this.config.healthyThreshold) {
      state.status = 'healthy';
    }

    // 更新时间和结果
    state.lastCheckTime = result.timestamp;
    state.lastCheckResult = result;

    // 更新历史
    state.history.push(result);
    if (state.history.length > this.MAX_HISTORY) {
      state.history.shift();
    }

    // 发送事件
    eventBus.emit('mcp:health_check', {
      serverId,
      healthy: result.healthy,
      latency: result.latency,
    });

    // 状态变化日志
    if (previousStatus !== state.status) {
      logger.info('Server health status changed', {
        serverId,
        from: previousStatus,
        to: state.status,
      });
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let monitorInstance: HealthMonitor | null = null;

/**
 * 获取健康监控器单例
 */
export function getHealthMonitor(
  pool: ConnectionPool,
  config?: Partial<HealthConfig>
): HealthMonitor {
  if (!monitorInstance) {
    monitorInstance = new HealthMonitor(pool, config);
  }
  return monitorInstance;
}

/**
 * 初始化并启动健康监控
 */
export function initHealthMonitor(
  pool: ConnectionPool,
  config?: Partial<HealthConfig>
): HealthMonitor {
  const monitor = getHealthMonitor(pool, config);
  monitor.start();
  return monitor;
}
