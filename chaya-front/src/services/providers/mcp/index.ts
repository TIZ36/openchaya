/**
 * MCP Providers Module
 * MCP 模块统一导出
 */

// Types
export * from './types';

// MCPClient
export { MCPClient } from './MCPClient';

// ConnectionPool
export {
  ConnectionPool,
  getConnectionPool,
} from './ConnectionPool';

// HealthMonitor
export {
  HealthMonitor,
  getHealthMonitor,
  initHealthMonitor,
} from './HealthMonitor';

// ============================================================================
// Bootstrap (lazy init)
// ============================================================================

import type { MCPServer } from './types';
import { getMCPServers } from '../../mcpApi';

let _initPromise: Promise<void> | null = null;

/**
 * 确保 MCP Provider（连接池 + 健康监控）已初始化并开始自愈。
 *
 * 设计目标：
 * - 不依赖各家实现 /health
 * - 使用 MCP 标准 tools/list 作为健康探测（由 MCPClient.healthCheck 内部完成）
 * - 启动 HealthMonitor 以周期性剔除坏连接并补齐最小连接数
 */
export async function ensureMCPProviderInitialized(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const pool = getConnectionPool();

    // 从后端拉取启用的 MCP server 列表（统一配置源）
    const servers = await getMCPServers();
    const enabledServers = servers.filter((s) => s.enabled);

    const providerServers: MCPServer[] = enabledServers.map((s) => ({
      id: s.id || (s.server_id as string),
      name: s.name,
      url: s.url,
      type: s.type as any,
      enabled: s.enabled,
      description: s.description,
      metadata: s.metadata,
      ext: s.ext,
    }));

    await pool.initialize(providerServers);

    // 启动健康监控（内部会用 tools/list 做心跳，并驱动 pool.recoverServer）
    initHealthMonitor(pool);
  })().catch((err) => {
    // 初始化失败时允许下次重试
    _initPromise = null;
    throw err;
  });

  return _initPromise;
}
