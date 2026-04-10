/**
 * Compatibility Layer
 * 
 * 这个模块提供向后兼容性，让现有代码可以继续使用旧的 API
 * 同时新代码应该使用新的分层架构 (services/index.ts)
 * 
 * 使用方式:
 * - 旧代码: import { LLMClient } from '../services/llmClient' （保持不变）
 * - 新代码: import { createProvider } from '../services/providers/llm'
 * 
 * @deprecated 这个模块仅用于向后兼容，新代码应使用新架构
 */

// ============================================================================
// LLM 相关导出（旧 API）
// ============================================================================

// 重新导出旧的 LLM 相关类型和类
export type { LLMMessage, LLMToolCall, LLMResponse } from '../llmClient';
export { LLMClient, convertMCPToolToLLMFunction, getCurrentLLMClient } from '../llmClient';

// ============================================================================
// MCP 相关导出（旧 API）
// ============================================================================

// 重新导出旧的 MCP 相关类型和类
export type { MCPServer, MCPTool, MCPClientOptions } from '../mcpClient';
export { MCPClient, MCPManager, mcpManager } from '../mcpClient';

// ============================================================================
// Workflow 相关导出（已移除）
// ============================================================================

// ============================================================================
// 新架构别名（便于迁移）
// ============================================================================

// 从新架构导出，提供迁移路径
export { ConnectionPool, getConnectionPool } from '../providers/mcp';
export { HealthMonitor, getHealthMonitor, initHealthMonitor } from '../providers/mcp';
export { createProvider, createProviderAuto } from '../providers/llm';

// ============================================================================
// Electron 兼容层（已移除）
// ============================================================================
// Electron 功能已完全移除，项目现在仅支持浏览器环境

// ============================================================================
// 推荐迁移指南
// ============================================================================
// 
// 新代码应该使用新的分层架构:
// 
// LLM:
//   import { createProvider, ILLMProvider } from '../services/providers/llm'
//   import type { LLMMessage, LLMResponse } from '../services/providers/llm'
// 
// MCP:
//   import { ConnectionPool, MCPClient, HealthMonitor } from '../services/providers/mcp'
//   import type { MCPServer, MCPTool } from '../services/providers/mcp'
// 
// Workflow:
//   import { WorkflowPool, WorkflowExecutor } from '../services/workflow'
// 
// 后端 URL:
//   import { getBackendUrl } from '../utils/backendUrl'
//
