/**
 * ConnectionPool - MCP 连接池
 * 管理多个服务器的连接，支持负载均衡和故障转移
 */

import type {
  MCPServer,
  MCPTool,
  ToolCallParams,
  ToolCallResult,
  PoolConfig,
  PoolStatus,
} from './types';
import { DEFAULT_POOL_CONFIG } from './types';
import { MCPClient } from './MCPClient';
import { MCPError, MCPErrorCode } from '../../core/shared/errors';
import { createLogger, sleep } from '../../core/shared/utils';

const logger = createLogger('ConnectionPool');

/**
 * 连接池
 */
export class ConnectionPool {
  private config: PoolConfig;
  private pools: Map<string, MCPClient[]> = new Map();
  private servers: Map<string, MCPServer> = new Map();
  private toolsCache: Map<string, MCPTool[]> = new Map();
  private acquireQueue: Map<string, Array<{
    resolve: (client: MCPClient) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>> = new Map();

  constructor(config?: Partial<PoolConfig>) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  // ============================================================================
  // Server Management
  // ============================================================================

  /**
   * 添加服务器
   */
  async addServer(server: MCPServer): Promise<void> {
    if (this.servers.has(server.id)) {
      logger.warn('Server already exists', { id: server.id });
      return;
    }

    this.servers.set(server.id, server);
    this.pools.set(server.id, []);
    this.acquireQueue.set(server.id, []);

    // 创建最小连接数
    if (server.enabled) {
      await this.ensureMinConnections(server.id);
    }

    logger.info('Server added', { id: server.id, name: server.name });
  }

  /**
   * 移除服务器
   */
  async removeServer(serverId: string): Promise<void> {
    const pool = this.pools.get(serverId);
    if (!pool) return;

    // 关闭所有连接
    for (const client of pool) {
      await client.disconnect();
    }

    // 拒绝等待队列
    const queue = this.acquireQueue.get(serverId) || [];
    for (const item of queue) {
      clearTimeout(item.timeout);
      item.reject(new MCPError('Server removed', serverId, {
        code: MCPErrorCode.CONNECTION_LOST,
      }));
    }

    this.pools.delete(serverId);
    this.servers.delete(serverId);
    this.toolsCache.delete(serverId);
    this.acquireQueue.delete(serverId);

    logger.info('Server removed', { id: serverId });
  }

  /**
   * 获取服务器列表
   */
  getServers(): MCPServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * 获取服务器
   */
  getServer(serverId: string): MCPServer | undefined {
    return this.servers.get(serverId);
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * 获取连接
   */
  async acquire(serverId: string, timeout?: number): Promise<MCPClient> {
    const pool = this.pools.get(serverId);
    const server = this.servers.get(serverId);

    if (!pool || !server) {
      throw new MCPError(`Server not found: ${serverId}`, serverId, {
        code: MCPErrorCode.CONNECTION_FAILED,
      });
    }

    // 先剔除不健康/断开的连接，避免“池里全是死连接但 pool.length 已满”导致无法自愈
    await this.pruneUnhealthyConnections(serverId);

    // 尝试获取空闲的健康连接
    for (const client of pool) {
      if (client.acquire()) {
        return client;
      }
    }

    // 如果可以创建新连接
    if (pool.length < this.config.maxConnections) {
      const client = await this.createConnection(server);
      pool.push(client);
      client.acquire();
      return client;
    }

    // 否则等待
    return this.waitForConnection(serverId, timeout || this.config.acquireTimeout);
  }

  /**
   * 释放连接
   */
  release(client: MCPClient): void {
    client.release();

    // 检查等待队列
    const queue = this.acquireQueue.get(client.serverId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      clearTimeout(next.timeout);

      if (client.acquire()) {
        next.resolve(client);
      }
    }
  }

  /**
   * 获取连接池状态
   */
  getStatus(serverId?: string): PoolStatus[] {
    const statuses: PoolStatus[] = [];

    const serverIds = serverId ? [serverId] : Array.from(this.pools.keys());

    for (const id of serverIds) {
      const pool = this.pools.get(id);
      if (!pool) continue;

      const active = pool.filter((c) => c.inUse).length;
      const idle = pool.filter((c) => !c.inUse && c.isConnected).length;

      statuses.push({
        serverId: id,
        totalConnections: pool.length,
        activeConnections: active,
        idleConnections: idle,
        pendingAcquires: this.acquireQueue.get(id)?.length || 0,
      });
    }

    return statuses;
  }

  // ============================================================================
  // Tool Operations
  // ============================================================================

  /**
   * 获取工具列表
   */
  async listTools(serverId: string, forceRefresh: boolean = false): Promise<MCPTool[]> {
    if (!forceRefresh) {
      const cached = this.toolsCache.get(serverId);
      if (cached) return cached;
    }

    const client = await this.acquire(serverId);
    try {
      const tools = await client.listTools(forceRefresh);
      this.toolsCache.set(serverId, tools);
      return tools;
    } finally {
      this.release(client);
    }
  }

  /**
   * 获取所有服务器的工具
   */
  async listAllTools(): Promise<Map<string, MCPTool[]>> {
    const result = new Map<string, MCPTool[]>();

    for (const serverId of this.servers.keys()) {
      try {
        const tools = await this.listTools(serverId);
        result.set(serverId, tools);
      } catch (error) {
        logger.warn('Failed to list tools', { serverId, error });
        result.set(serverId, []);
      }
    }

    return result;
  }

  /**
   * 调用工具
   */
  async callTool(params: ToolCallParams): Promise<ToolCallResult> {
    const { serverId, toolName, arguments: args, timeout } = params;

    const client = await this.acquire(serverId);
    try {
      return await client.callTool(toolName, args, timeout);
    } finally {
      this.release(client);
    }
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * 初始化连接池
   */
  async initialize(servers: MCPServer[]): Promise<void> {
    for (const server of servers) {
      await this.addServer(server);
    }
    logger.info('Connection pool initialized', { serverCount: servers.length });
  }

  /**
   * 关闭连接池
   */
  async shutdown(): Promise<void> {
    const serverIds = Array.from(this.servers.keys());
    for (const serverId of serverIds) {
      await this.removeServer(serverId);
    }
    logger.info('Connection pool shutdown');
  }

  /**
   * 清理空闲连接
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const now = Date.now();

    for (const [serverId, pool] of this.pools) {
      // 先清理不健康/断开的连接，释放容量
      cleaned += await this.pruneUnhealthyConnections(serverId);

      const toRemove: MCPClient[] = [];

      for (const client of pool) {
        // 跳过使用中的连接
        if (client.inUse) continue;

        // 保留最小连接数
        const remaining = pool.length - toRemove.length;
        if (remaining <= this.config.minConnections) break;

        // 检查空闲超时
        if (now - client.lastUsedTime > this.config.idleTimeout) {
          toRemove.push(client);
        }
      }

      for (const client of toRemove) {
        await client.disconnect();
        const index = pool.indexOf(client);
        if (index !== -1) {
          pool.splice(index, 1);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      logger.info('Cleaned idle connections', { count: cleaned });
    }

    return cleaned;
  }

  // ============================================================================
  // Recovery / Eviction
  // ============================================================================

  /**
   * 剔除不健康/断开的连接（不会动 inUse 的连接）
   * 返回剔除数量
   */
  async pruneUnhealthyConnections(serverId: string): Promise<number> {
    const pool = this.pools.get(serverId);
    if (!pool || pool.length === 0) return 0;

    const toRemove: MCPClient[] = [];
    for (const client of pool) {
      if (client.inUse) continue;
      if (!client.isConnected || !client.isHealthy) {
        toRemove.push(client);
      }
    }

    if (toRemove.length === 0) return 0;

    for (const client of toRemove) {
      try {
        await client.disconnect();
      } catch (error) {
        logger.warn('Failed to disconnect unhealthy client', { serverId, error });
      }
      const idx = pool.indexOf(client);
      if (idx !== -1) pool.splice(idx, 1);
    }

    // 工具缓存可能与旧 session 绑定，剔除后强制失效，避免继续使用陈旧工具列表
    this.toolsCache.delete(serverId);

    logger.info('Pruned unhealthy connections', { serverId, count: toRemove.length });
    return toRemove.length;
  }

  /**
   * 触发一次恢复：剔除坏连接并补齐最小连接数
   */
  async recoverServer(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server || !server.enabled) return;

    await this.pruneUnhealthyConnections(serverId);
    await this.ensureMinConnections(serverId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 创建连接
   */
  private async createConnection(server: MCPServer): Promise<MCPClient> {
    const client = new MCPClient({ server });
    await client.connect();
    return client;
  }

  /**
   * 确保最小连接数
   */
  private async ensureMinConnections(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    const pool = this.pools.get(serverId);
    if (!server || !pool) return;

    while (pool.length < this.config.minConnections) {
      try {
        const client = await this.createConnection(server);
        pool.push(client);
      } catch (error) {
        logger.warn('Failed to create min connection', { serverId, error });
        break;
      }
    }
  }

  /**
   * 等待连接
   */
  private waitForConnection(serverId: string, timeout: number): Promise<MCPClient> {
    return new Promise((resolve, reject) => {
      const queue = this.acquireQueue.get(serverId)!;

      const timeoutId = setTimeout(() => {
        const index = queue.findIndex((item) => item.timeout === timeoutId);
        if (index !== -1) {
          queue.splice(index, 1);
        }
        reject(new MCPError('Acquire timeout', serverId, {
          code: MCPErrorCode.POOL_EXHAUSTED,
        }));
      }, timeout);

      queue.push({ resolve, reject, timeout: timeoutId });
    });
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let poolInstance: ConnectionPool | null = null;

/**
 * 获取连接池单例
 */
export function getConnectionPool(config?: Partial<PoolConfig>): ConnectionPool {
  if (!poolInstance) {
    poolInstance = new ConnectionPool(config);
  }
  return poolInstance;
}
