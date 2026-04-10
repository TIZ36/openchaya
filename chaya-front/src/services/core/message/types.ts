/**
 * Message Module Types
 * 消息模块类型定义
 */

import type { MessageRole, MediaItem } from '../shared/types';

// ============================================================================
// Message Types - 消息类型
// ============================================================================

/**
 * 消息接口
 */
export interface Message {
  id: string;
  message_id?: string;        // 后端返回的 id
  sessionId: string;
  session_id?: string;        // 后端返回的 sessionId
  role: MessageRole;
  sender_id?: string;         // 发送者 ID (Agent ID 或 User ID)
  sender_type?: 'user' | 'agent' | 'system'; // 发送者类型
  content: string;
  thinking?: string;
  timestamp: number;
  created_at?: string;        // 后端返回的时间
  
  // 可选字段
  toolCallId?: string;
  toolCalls?: ToolCall[];
  tool_calls?: any[];         // 后端返回的工具调用
  media?: MediaItem[];
  mentions?: string[];        // 被 @ 的参与者
  reply_to_message_id?: string; // 回复的消息 ID
  metadata?: MessageMetadata;
  ext?: any;                  // 扩展字段
}

/**
 * 工具调用
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 消息元数据
 */
export interface MessageMetadata {
  model?: string;
  provider?: string;
  tokenCount?: number;
  finishReason?: string;
  duration?: number;
  [key: string]: unknown;
}

/**
 * 创建消息的输入
 */
export interface CreateMessageInput {
  sessionId: string;
  role: MessageRole;
  sender_id?: string;
  sender_type?: 'user' | 'agent' | 'system';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  media?: MediaItem[];
  thinking?: string;
  mentions?: string[];
  reply_to_message_id?: string;
  metadata?: MessageMetadata;
}

// ============================================================================
// SlowDB Config - SlowDB 配置
// ============================================================================

/**
 * SlowDB 配置
 */
export interface SlowDBConfig {
  // WriteBuffer 配置
  writeBuffer: {
    maxSize: number;           // 缓冲区最大消息数
    flushInterval: number;     // 定时刷盘间隔（ms）
    flushThreshold: number;    // 触发刷盘的消息数阈值
  };
  
  // AsyncPersist 配置
  persist: {
    batchSize: number;         // 批量写入大小
    retryTimes: number;        // 失败重试次数
    retryDelay: number;        // 重试延迟（ms）
  };
  
  // IndexedDB 配置
  database: {
    name: string;              // 数据库名称
    version: number;           // 数据库版本
    storeName: string;         // 存储名称
  };
}

/**
 * 默认 SlowDB 配置
 */
export const DEFAULT_SLOWDB_CONFIG: SlowDBConfig = {
  writeBuffer: {
    maxSize: 1000,
    flushInterval: 5000,       // 5秒
    flushThreshold: 100,
  },
  persist: {
    batchSize: 50,
    retryTimes: 3,
    retryDelay: 1000,
  },
  database: {
    name: 'chatee-messages',
    version: 1,
    storeName: 'messages',
  },
};

// ============================================================================
// Query Types - 查询类型
// ============================================================================

/**
 * 消息查询条件
 */
export interface MessageQuery {
  sessionId: string;
  limit?: number;
  offset?: number;
  beforeTimestamp?: number;
  afterTimestamp?: number;
  role?: MessageRole;
}

/**
 * 分页结果
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

// ============================================================================
// Buffer Status - 缓冲区状态
// ============================================================================

/**
 * 缓冲区状态
 */
export interface BufferStatus {
  sessionCount: number;        // 有缓冲的会话数
  totalMessages: number;       // 总消息数
  oldestTimestamp?: number;    // 最早的消息时间
  newestTimestamp?: number;    // 最新的消息时间
}

/**
 * 持久化状态
 */
export interface PersistStatus {
  pending: number;             // 待持久化的消息数
  lastFlushTime?: number;      // 上次刷盘时间
  lastError?: Error;           // 最后一次错误
}
