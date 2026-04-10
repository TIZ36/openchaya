/**
 * Workflow Module Types
 * 工作流模块类型定义
 */

// ============================================================================
// Node Types - 节点类型
// ============================================================================

/**
 * 节点类型
 */
export type NodeType = 'start' | 'end' | 'llm' | 'mcp' | 'condition' | 'loop' | 'parallel' | 'script';

/**
 * 节点状态
 */
export type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * 节点定义
 */
export interface NodeDefinition {
  id: string;
  type: NodeType;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  inputs?: string[];   // 输入节点 ID
  outputs?: string[];  // 输出节点 ID
}

/**
 * 节点执行上下文
 */
export interface NodeContext {
  workflowId: string;
  executionId: string;
  nodeId: string;
  inputs: Record<string, unknown>;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * 节点执行结果
 */
export interface NodeResult {
  success: boolean;
  outputs: Record<string, unknown>;
  error?: Error;
  duration: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Workflow Types - 工作流类型
// ============================================================================

/**
 * 工作流状态
 */
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

/**
 * 执行状态
 */
export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * 工作流定义
 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version: number;
  status: WorkflowStatus;
  nodes: NodeDefinition[];
  edges: WorkflowEdge[];
  variables?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * 工作流边（连接）
 */
export interface WorkflowEdge {
  id: string;
  source: string;      // 源节点 ID
  target: string;      // 目标节点 ID
  condition?: string;  // 条件表达式
  label?: string;
}

/**
 * 工作流执行实例
 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  variables: Record<string, unknown>;
  nodeStates: Map<string, NodeState>;
  startedAt: number;
  completedAt?: number;
  error?: Error;
}

/**
 * 节点状态
 */
export interface NodeState {
  nodeId: string;
  status: NodeStatus;
  startedAt?: number;
  completedAt?: number;
  result?: NodeResult;
  retryCount: number;
}

// ============================================================================
// Executor Config - 执行器配置
// ============================================================================

/**
 * 执行器配置
 */
export interface ExecutorConfig {
  maxConcurrentNodes: number;   // 最大并发节点数
  nodeTimeout: number;          // 单节点超时（ms）
  maxRetries: number;           // 最大重试次数
  retryDelay: number;           // 重试延迟（ms）
}

/**
 * 默认执行器配置
 */
export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  maxConcurrentNodes: 10,
  nodeTimeout: 300000,          // 5 分钟
  maxRetries: 2,
  retryDelay: 1000,
};

// ============================================================================
// Event Types - 事件类型
// ============================================================================

/**
 * 工作流事件
 */
export type WorkflowEventType =
  | 'execution:start'
  | 'execution:end'
  | 'node:start'
  | 'node:end'
  | 'node:error'
  | 'node:retry';

/**
 * 工作流事件数据
 */
export interface WorkflowEventData {
  'execution:start': {
    executionId: string;
    workflowId: string;
    workflowName: string;
  };
  'execution:end': {
    executionId: string;
    workflowId: string;
    status: ExecutionStatus;
    duration: number;
  };
  'node:start': {
    executionId: string;
    nodeId: string;
    nodeName: string;
    nodeType: NodeType;
  };
  'node:end': {
    executionId: string;
    nodeId: string;
    nodeName: string;
    result: NodeResult;
  };
  'node:error': {
    executionId: string;
    nodeId: string;
    nodeName: string;
    error: Error;
  };
  'node:retry': {
    executionId: string;
    nodeId: string;
    nodeName: string;
    attempt: number;
  };
}
