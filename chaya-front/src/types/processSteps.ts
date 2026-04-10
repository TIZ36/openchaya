/**
 * ProcessSteps 统一类型（与后端 IterationContext 输出对齐）
 * - 必需字段：type / timestamp / status
 * - 允许任意扩展字段（后端会附带额外信息）
 */

export type ProcessStepStatus = 'pending' | 'running' | 'completed' | 'error' | 'interrupted' | string;

export interface ProcessStep {
  /** 步骤类型（后端为字符串，前端需兼容扩展） */
  type: string;
  /** 步骤唯一ID（用于前端合并更新） */
  step_id?: string;
  /** 毫秒时间戳 */
  timestamp?: number;
  /** 执行状态 */
  status?: ProcessStepStatus;
  /** 思考/说明文本 */
  thinking?: string;
  /** MCP 相关 */
  mcpServer?: string;
  mcpServerName?: string;
  toolName?: string;
  arguments?: any;
  result?: any;
  /** 执行耗时（毫秒） */
  duration?: number;
  /** 错误信息 */
  error?: string;
  /** Agent/决策相关 */
  action?: string;
  agent_id?: string;
  agent_name?: string;
  agent_mode?: 'normal' | 'persona';
  /** LLM 相关 */
  llm_provider?: string;
  llm_model?: string;
  is_thinking_model?: boolean;
  /** 迭代轮次 */
  iteration?: number;
  is_final_iteration?: boolean;
  max_iterations?: number;
  /** 工作流信息 */
  workflowInfo?: {
    id?: string;
    name?: string;
    status?: ProcessStepStatus;
    result?: string;
    config?: any;
  };
  /** ActionChain 相关 */
  chain_id?: string;
  chain_progress?: string;
  chain_status?: string;
  action_type?: string;
  step_id?: string;
  origin_agent_id?: string;
  target_agent_id?: string;
  interrupt?: boolean;
  /** 允许后端附加任意扩展字段 */
  [key: string]: any;
}

export type ProcessSteps = ProcessStep[];
