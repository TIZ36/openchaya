/**
 * Session Module Types
 * 会话层模块类型定义
 */

// ============================================================================
// Agent Types - Agent 类型
// ============================================================================

/**
 * Agent 状态
 */
export type AgentStatus = 'idle' | 'thinking' | 'responding' | 'learning' | 'sleeping';

/**
 * Agent 定义
 */
export interface AgentDefinition {
  id: string;
  name: string;
  avatar?: string;
  systemPrompt: string;
  description?: string;
  
  // 能力配置
  capabilities: {
    llmProvider: string;
    llmModel: string;
    mcpServers?: string[];
    workflows?: string[];
    voice?: {
      enabled: boolean;
      voiceId?: string;
    };
  };
  
  // 行为配置
  behavior: {
    proactive: boolean;           // 是否主动
    learningEnabled: boolean;     // 是否启用学习
    rejectUnknown: boolean;       // 是否拒绝不懂的问题
  };
  
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Mailbox Types - 邮箱类型
// ============================================================================

/**
 * 消息优先级
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * 邮箱消息
 */
export interface MailboxMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  priority: MessagePriority;
  timestamp: number;
  replyTo?: string;           // 引用的消息 ID
  metadata?: Record<string, unknown>;
}

/**
 * 邮箱配置
 */
export interface MailboxConfig {
  maxSize: number;            // 最大队列大小
  processingDelay: number;    // 处理间隔（ms）
  priorityBoost: boolean;     // 是否优先级提升
}

/**
 * 默认邮箱配置
 */
export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {
  maxSize: 100,
  processingDelay: 100,
  priorityBoost: true,
};

// ============================================================================
// Capability Types - 能力类型
// ============================================================================

/**
 * 能力评估结果
 */
export interface CapabilityAssessment {
  canRespond: boolean;
  confidence: number;           // 0-1
  reason?: string;
  suggestedAction?: 'respond' | 'reject' | 'delegate' | 'learn';
  requiredCapabilities?: string[];
}

/**
 * 拒绝策略
 */
export type RejectPolicy = 'silent' | 'polite' | 'delegate' | 'learn_and_wait';

// ============================================================================
// Learning Types - 学习类型
// ============================================================================

/**
 * 学习记录
 */
export interface LearningRecord {
  id: string;
  agentId: string;
  topic: string;
  question: string;
  answer: string;
  sourceAgentId: string;
  sourceAgentName: string;
  timestamp: number;
  absorbed: boolean;
}

// ============================================================================
// Memory Types - 记忆类型
// ============================================================================

/**
 * 记忆类型
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

/**
 * 记忆项
 */
export interface MemoryItem {
  id: string;
  agentId: string;
  type: MemoryType;
  content: string;
  embedding?: number[];
  importance: number;         // 0-1
  accessCount: number;
  lastAccessTime: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/**
 * 记忆检索结果
 */
export interface MemoryRetrievalResult {
  memory: MemoryItem;
  similarity: number;
}

// ============================================================================
// Persona Types - 拟真类型
// ============================================================================

/**
 * 语音人设
 */
export interface VoicePersona {
  voiceId: string;
  name: string;
  language: string;
  gender?: 'male' | 'female' | 'neutral';
  age?: 'young' | 'adult' | 'senior';
  style?: string;
}

/**
 * 自驱思考配置
 */
export interface AutonomousThinkingConfig {
  enabled: boolean;
  interval: number;           // 思考间隔（ms）
  topics: string[];           // 思考主题
  memoryTriggered: boolean;   // 是否由记忆触发
}

/**
 * 思考任务
 */
export interface ThinkingTask {
  id: string;
  agentId: string;
  topic: string;
  prompt: string;
  scheduledAt: number;
  status: 'pending' | 'running' | 'completed';
  result?: string;
}

// ============================================================================
// Session Types - 会话类型
// ============================================================================

/**
 * 会话类型 (Topic 类型)
 */
export type SessionType = 
  | 'private_chat'       // 私聊
  | 'topic_general'      // 普通话题/群聊
  | 'topic_research'     // 研究课题
  | 'topic_brainstorm'   // 脑暴话题
  | 'temporary'          // 临时会话
  | 'memory'             // 记忆片段 (旧)
  | 'single' | 'multi'; // 兼容旧版

/**
 * 会话状态
 */
export type SessionStatus = 'active' | 'paused' | 'ended';

/**
 * 会话定义 (Topic 详情)
 */
export interface SessionDefinition {
  id: string;
  session_id?: string;        // 后端返回的 id
  type: SessionType;
  session_type?: SessionType; // 后端返回的类型
  name: string;
  title?: string;             // 后端返回的标题
  description?: string;
  avatar?: string;
  agents?: string[];          // 参与者 ID 列表
  participants?: any[];       // 详细参与者信息
  owner_id?: string;          // 话题所有者
  ext?: Record<string, any>;  // 扩展配置 (人设、语音等)
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  created_at?: string;        // 后端返回的时间
  updated_at?: string;
  metadata?: Record<string, unknown>;
}
