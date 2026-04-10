/**
 * Session - 会话管理
 * 管理 Agent 之间的交互会话
 */

import type { SessionDefinition, SessionStatus, SessionType } from './types';
import { Agent } from './Agent';
import { createLogger, generateId } from '../core/shared/utils';

const logger = createLogger('Session');

/**
 * 会话类
 */
export class Session {
  private definition: SessionDefinition;
  private agents: Map<string, Agent> = new Map();
  private messageHistory: SessionMessage[] = [];

  constructor(
    type: SessionType,
    name: string,
    description?: string
  ) {
    this.definition = {
      id: generateId('session'),
      type,
      name,
      description,
      agents: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // ============================================================================
  // Getters
  // ============================================================================

  get id(): string {
    return this.definition.id;
  }

  get type(): SessionType {
    return this.definition.type;
  }

  get name(): string {
    return this.definition.name;
  }

  get status(): SessionStatus {
    return this.definition.status;
  }

  // ============================================================================
  // Agent Management
  // ============================================================================

  /**
   * 添加 Agent
   */
  addAgent(agent: Agent): void {
    if (this.agents.has(agent.id)) {
      logger.warn('Agent already in session', { sessionId: this.id, agentId: agent.id });
      return;
    }

    this.agents.set(agent.id, agent);
    this.definition.agents.push(agent.id);
    this.definition.updatedAt = Date.now();

    // 设置响应回调
    agent.onResponse((message, replyTo) => {
      this.handleAgentResponse(agent.id, agent.name, message, replyTo);
    });

    logger.info('Agent added to session', {
      sessionId: this.id,
      agentId: agent.id,
      agentName: agent.name,
    });
  }

  /**
   * 移除 Agent
   */
  removeAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    this.agents.delete(agentId);
    this.definition.agents = this.definition.agents.filter((id) => id !== agentId);
    this.definition.updatedAt = Date.now();

    logger.info('Agent removed from session', {
      sessionId: this.id,
      agentId,
    });

    return true;
  }

  /**
   * 获取 Agent
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 获取所有 Agent
   */
  getAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  // ============================================================================
  // Message Handling
  // ============================================================================

  /**
   * 发送用户消息
   */
  sendUserMessage(content: string, targetAgentId?: string): void {
    if (this.status !== 'active') {
      logger.warn('Session not active', { sessionId: this.id, status: this.status });
      return;
    }

    // 记录消息
    const message: SessionMessage = {
      id: generateId('msg'),
      senderId: 'user',
      senderName: 'User',
      content,
      timestamp: Date.now(),
    };
    this.messageHistory.push(message);

    // 发送给指定 Agent 或所有 Agent
    if (targetAgentId) {
      const agent = this.agents.get(targetAgentId);
      if (agent) {
        agent.receive('user', 'User', content);
      }
    } else {
      this.broadcast('user', 'User', content);
    }
  }

  /**
   * 广播消息给所有 Agent
   */
  broadcast(senderId: string, senderName: string, content: string): void {
    for (const agent of this.agents.values()) {
      if (agent.id !== senderId) {
        agent.receive(senderId, senderName, content);
      }
    }
  }

  /**
   * 获取消息历史
   */
  getHistory(limit?: number): SessionMessage[] {
    if (limit) {
      return this.messageHistory.slice(-limit);
    }
    return [...this.messageHistory];
  }

  // ============================================================================
  // Session Control
  // ============================================================================

  /**
   * 暂停会话
   */
  pause(): void {
    this.definition.status = 'paused';
    this.definition.updatedAt = Date.now();

    for (const agent of this.agents.values()) {
      // 可以实现暂停 Agent 的邮箱处理
    }

    logger.info('Session paused', { sessionId: this.id });
  }

  /**
   * 恢复会话
   */
  resume(): void {
    this.definition.status = 'active';
    this.definition.updatedAt = Date.now();

    logger.info('Session resumed', { sessionId: this.id });
  }

  /**
   * 结束会话
   */
  end(): void {
    this.definition.status = 'ended';
    this.definition.updatedAt = Date.now();

    // 停止所有 Agent
    for (const agent of this.agents.values()) {
      agent.stop();
    }

    logger.info('Session ended', { sessionId: this.id });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 处理 Agent 响应
   */
  private handleAgentResponse(
    agentId: string,
    agentName: string,
    content: string,
    replyTo?: string
  ): void {
    // 记录消息
    const message: SessionMessage = {
      id: generateId('msg'),
      senderId: agentId,
      senderName: agentName,
      content,
      replyTo,
      timestamp: Date.now(),
    };
    this.messageHistory.push(message);

    // 让其他 Agent 观察
    const originalQuestion = replyTo
      ? this.messageHistory.find((m) => m.id === replyTo)?.content
      : undefined;

    if (originalQuestion) {
      for (const agent of this.agents.values()) {
        if (agent.id !== agentId) {
          agent.observe(replyTo!, originalQuestion, content, agentId, agentName);
        }
      }
    }

    // 在多 Agent 会话中广播
    if (this.type === 'multi' || this.type === 'roundtable') {
      // 不立即广播，让 Agent 自己决定是否响应
    }
  }
}

/**
 * 会话消息
 */
export interface SessionMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  replyTo?: string;
  timestamp: number;
}

// ============================================================================
// Session Manager
// ============================================================================

/**
 * 会话管理器
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * 创建会话
   */
  create(type: SessionType, name: string, description?: string): Session {
    const session = new Session(type, name, description);
    this.sessions.set(session.id, session);
    
    logger.info('Session created', { id: session.id, type, name });
    return session;
  }

  /**
   * 获取会话
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取所有会话
   */
  getAll(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 删除会话
   */
  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.end();
    this.sessions.delete(sessionId);
    
    logger.info('Session deleted', { id: sessionId });
    return true;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let sessionManagerInstance: SessionManager | null = null;

/**
 * 获取会话管理器单例
 */
export function getSessionManager(): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager();
  }
  return sessionManagerInstance;
}
