/**
 * Services Module
 * 服务层统一导出
 * 
 * 架构层次：
 * - Core: 核心基础设施（消息、上下文、媒体、调度）
 * - Providers: 能力层（LLM、MCP、语音）
 * - Workflow: 工作流层（节点、执行器、构建器）
 * - Session: 会话层（Agent、记忆、人设）
 * - Apps: 应用层（圆桌会议、研究助手）
 */

// Core Layer
export {
  // Shared
  eventBus,
  on,
  once,
  emit,
  // Types
  type MediaType,
  type MediaItem,
  // Message (SlowDB)
  MessageStore,
  getMessageStore,
  // Context
  TextContextEngine,
  // Media
  MediaRenderer,
  getMediaRenderer,
  // Scheduler
  getScheduler,
} from './core';

// Provider Layer
export {
  // LLM
  createProvider,
  createProviderAuto,
  // MCP
  ConnectionPool,
  MCPClient,
} from './providers';

// Workflow Layer (已移除)

// Session Layer
export {
  Agent,
  Session,
} from './session';

// Apps Layer (已移除 RoundTable)
