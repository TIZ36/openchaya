/**
 * MCP Provider Types
 * MCP (Model Context Protocol) 模块类型定义
 */

import type { MCPServerType, HealthStatus } from '../../core/shared/types';

// ============================================================================
// Server Types - 服务器类型
// ============================================================================

/**
 * MCP 服务器配置
 */
export interface MCPServer {
  id: string;
  name: string;
  url: string;
  type: MCPServerType;
  enabled: boolean;
  description?: string;
  metadata?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

/**
 * MCP 服务器状态
 */
export type MCPServerStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * MCP 服务器运行时信息
 */
export interface MCPServerInfo {
  server: MCPServer;
  status: MCPServerStatus;
  lastConnectTime?: number;
  lastDisconnectTime?: number;
  lastError?: Error;
  toolCount?: number;
  consecutiveErrors: number;
}

// ============================================================================
// Tool Types - 工具类型
// ============================================================================

/**
 * MCP 工具定义
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * 工具调用参数
 */
export interface ToolCallParams {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeout?: number;
}

/**
 * 工具调用结果
 */
export interface ToolCallResult {
  success: boolean;
  content: unknown;
  isError?: boolean;
  duration: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Connection Pool Types - 连接池类型
// ============================================================================

/**
 * 连接池配置
 */
export interface PoolConfig {
  maxConnections: number;       // 每个服务器最大连接数
  minConnections: number;       // 每个服务器最小连接数
  idleTimeout: number;          // 空闲连接超时（ms）
  acquireTimeout: number;       // 获取连接超时（ms）
  maxRetries: number;           // 最大重试次数
  retryDelay: number;           // 重试延迟（ms）
}

/**
 * 默认连接池配置
 */
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConnections: 5,
  minConnections: 1,
  idleTimeout: 300000,          // 5 分钟
  acquireTimeout: 30000,        // 30 秒
  maxRetries: 3,
  retryDelay: 1000,
};

/**
 * 连接池状态
 */
export interface PoolStatus {
  serverId: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  pendingAcquires: number;
}

// ============================================================================
// Health Monitor Types - 健康监控类型
// ============================================================================

/**
 * 健康监控配置
 */
export interface HealthConfig {
  enabled: boolean;
  interval: number;             // 检查间隔（ms）
  timeout: number;              // 检查超时（ms）
  unhealthyThreshold: number;   // 不健康阈值（连续失败次数）
  healthyThreshold: number;     // 恢复健康阈值（连续成功次数）
}

/**
 * 默认健康监控配置
 */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  enabled: true,
  interval: 60000,              // 60 秒（降低请求频率，避免对 MCP 服务造成压力）
  timeout: 5000,                // 5 秒
  unhealthyThreshold: 3,
  healthyThreshold: 2,
};

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  serverId: string;
  healthy: boolean;
  latency?: number;
  error?: Error;
  timestamp: number;
}

// ============================================================================
// Client Options - 客户端选项
// ============================================================================

/**
 * MCP 客户端选项
 */
export interface MCPClientOptions {
  server: MCPServer;
  connectTimeout?: number;
  requestTimeout?: number;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

/**
 * 默认客户端选项
 */
export const DEFAULT_CLIENT_OPTIONS: Partial<MCPClientOptions> = {
  connectTimeout: 10000,
  requestTimeout: 60000,
  autoReconnect: true,
  reconnectDelay: 5000,  // 5 秒，避免连接失败时每秒重试打满 MCP 服务
  maxReconnectAttempts: 5,
};

// ============================================================================
// Event Types - 事件类型
// ============================================================================

/**
 * MCP 事件数据
 */
export interface MCPEventData {
  serverId: string;
  serverName: string;
  timestamp: number;
}

/**
 * 连接事件数据
 */
export interface ConnectEventData extends MCPEventData {
  toolCount?: number;
}

/**
 * 断开连接事件数据
 */
export interface DisconnectEventData extends MCPEventData {
  reason?: string;
  willReconnect?: boolean;
}

/**
 * 工具调用事件数据
 */
export interface ToolCallEventData extends MCPEventData {
  toolName: string;
  arguments: Record<string, unknown>;
  duration?: number;
  result?: unknown;
  error?: Error;
}
