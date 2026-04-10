/**
 * Core Event Bus
 * 统一的事件总线实现
 */

import type { EventHandler, Unsubscribe } from './types';

// ============================================================================
// Event Types - 事件类型定义
// ============================================================================

/**
 * LLM 事件类型
 */
export type LLMEventType =
  | 'llm:start'
  | 'llm:chunk'
  | 'llm:thinking'
  | 'llm:tool_call'
  | 'llm:end'
  | 'llm:error';

/**
 * MCP 事件类型
 */
export type MCPEventType =
  | 'mcp:connect'
  | 'mcp:disconnect'
  | 'mcp:reconnect'
  | 'mcp:tool_call'
  | 'mcp:tool_result'
  | 'mcp:error'
  | 'mcp:health_check';

/**
 * Workflow 事件类型
 */
export type WorkflowEventType =
  | 'workflow:start'
  | 'workflow:node_start'
  | 'workflow:node_end'
  | 'workflow:end'
  | 'workflow:error';

/**
 * Message 事件类型
 */
export type MessageEventType =
  | 'message:created'
  | 'message:updated'
  | 'message:deleted'
  | 'message:flushed';

/**
 * Agent 事件类型
 */
export type AgentEventType =
  | 'agent:message_received'
  | 'agent:message_processed'
  | 'agent:capability_check'
  | 'agent:rejected'
  | 'agent:learning';

/**
 * 所有事件类型
 */
export type EventType =
  | LLMEventType
  | MCPEventType
  | WorkflowEventType
  | MessageEventType
  | AgentEventType;

// ============================================================================
// Event Data - 事件数据定义
// ============================================================================

/**
 * LLM 事件数据
 */
export interface LLMEventData {
  'llm:start': {
    provider: string;
    model: string;
    messageCount: number;
  };
  'llm:chunk': {
    content: string;
    isThinking?: boolean;
  };
  'llm:thinking': {
    content: string;
  };
  'llm:tool_call': {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  'llm:end': {
    provider: string;
    model: string;
    finishReason?: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  };
  'llm:error': {
    provider: string;
    model?: string;
    error: Error;
  };
}

/**
 * MCP 事件数据
 */
export interface MCPEventData {
  'mcp:connect': {
    serverId: string;
    serverName: string;
  };
  'mcp:disconnect': {
    serverId: string;
    serverName: string;
    reason?: string;
    permanent?: boolean;
  };
  'mcp:reconnect': {
    serverId: string;
    serverName: string;
    attempt: number;
  };
  'mcp:tool_call': {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  'mcp:tool_result': {
    serverId: string;
    toolName: string;
    result: unknown;
    duration: number;
  };
  'mcp:error': {
    serverId: string;
    error: Error;
  };
  'mcp:health_check': {
    serverId: string;
    healthy: boolean;
    latency?: number;
  };
}

/**
 * Workflow 事件数据
 */
export interface WorkflowEventData {
  'workflow:start': {
    workflowId: string;
    name: string;
  };
  'workflow:node_start': {
    workflowId: string;
    nodeId: string;
    nodeType: string;
  };
  'workflow:node_end': {
    workflowId: string;
    nodeId: string;
    nodeType: string;
    duration: number;
    result?: unknown;
  };
  'workflow:end': {
    workflowId: string;
    duration: number;
    result?: unknown;
  };
  'workflow:error': {
    workflowId: string;
    nodeId?: string;
    error: Error;
  };
}

/**
 * Message 事件数据
 */
export interface MessageEventData {
  'message:created': {
    sessionId: string;
    messageId: string;
    role: string;
  };
  'message:updated': {
    sessionId: string;
    messageId: string;
  };
  'message:deleted': {
    sessionId: string;
    messageId: string;
  };
  'message:flushed': {
    sessionId: string;
    count: number;
  };
}

/**
 * Agent 事件数据
 */
export interface AgentEventData {
  'agent:message_received': {
    agentId: string;
    messageId: string;
    sender: string;
  };
  'agent:message_processed': {
    agentId: string;
    messageId: string;
    duration: number;
  };
  'agent:capability_check': {
    agentId: string;
    messageId: string;
    canRespond: boolean;
    confidence: number;
  };
  'agent:rejected': {
    agentId: string;
    messageId: string;
    reason: string;
  };
  'agent:learning': {
    agentId: string;
    sourceAgentId: string;
    topic: string;
  };
}

/**
 * 所有事件数据映射
 */
export type AllEventData = LLMEventData &
  MCPEventData &
  WorkflowEventData &
  MessageEventData &
  AgentEventData;

// ============================================================================
// Event Bus Implementation - 事件总线实现
// ============================================================================

/**
 * 事件总线
 */
export class EventBus {
  private listeners = new Map<EventType, Set<EventHandler<unknown>>>();
  private onceListeners = new Map<EventType, Set<EventHandler<unknown>>>();

  /**
   * 订阅事件
   */
  on<T extends EventType>(
    event: T,
    handler: EventHandler<AllEventData[T]>
  ): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler<unknown>);

    return () => {
      this.off(event, handler);
    };
  }

  /**
   * 订阅一次性事件
   */
  once<T extends EventType>(
    event: T,
    handler: EventHandler<AllEventData[T]>
  ): Unsubscribe {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(handler as EventHandler<unknown>);

    return () => {
      this.onceListeners.get(event)?.delete(handler as EventHandler<unknown>);
    };
  }

  /**
   * 取消订阅
   */
  off<T extends EventType>(
    event: T,
    handler: EventHandler<AllEventData[T]>
  ): void {
    this.listeners.get(event)?.delete(handler as EventHandler<unknown>);
    this.onceListeners.get(event)?.delete(handler as EventHandler<unknown>);
  }

  /**
   * 发送事件
   */
  emit<T extends EventType>(event: T, data: AllEventData[T]): void {
    // 触发普通监听器
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[EventBus] Error in handler for ${event}:`, error);
        }
      });
    }

    // 触发一次性监听器
    const onceHandlers = this.onceListeners.get(event);
    if (onceHandlers) {
      onceHandlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`[EventBus] Error in once handler for ${event}:`, error);
        }
      });
      this.onceListeners.delete(event);
    }
  }

  /**
   * 清除所有监听器
   */
  clear(): void {
    this.listeners.clear();
    this.onceListeners.clear();
  }

  /**
   * 清除特定事件的监听器
   */
  clearEvent(event: EventType): void {
    this.listeners.delete(event);
    this.onceListeners.delete(event);
  }

  /**
   * 获取监听器数量
   */
  listenerCount(event?: EventType): number {
    if (event) {
      return (
        (this.listeners.get(event)?.size ?? 0) +
        (this.onceListeners.get(event)?.size ?? 0)
      );
    }
    let count = 0;
    this.listeners.forEach((handlers) => (count += handlers.size));
    this.onceListeners.forEach((handlers) => (count += handlers.size));
    return count;
  }
}

// ============================================================================
// Global Event Bus Instance - 全局事件总线实例
// ============================================================================

/**
 * 全局事件总线
 */
export const eventBus = new EventBus();

/**
 * 便捷方法：订阅事件
 */
export const on = eventBus.on.bind(eventBus);

/**
 * 便捷方法：订阅一次性事件
 */
export const once = eventBus.once.bind(eventBus);

/**
 * 便捷方法：发送事件
 */
export const emit = eventBus.emit.bind(eventBus);
