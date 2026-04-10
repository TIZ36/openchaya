/**
 * Agent Response 统一类型定义
 * 
 * AI消息回答的四大组成部分：
 * 1. agent_log - 滚动日志，用于显示AI agent的处理过程
 * 2. agent_mind - 思维链，关注关键时间点（思考、MCP选择、自迭代选择）
 * 3. agent_ext_content - 外部内容（MCP返回信息、媒体资源等）
 * 4. agent_output - 模型的最终输出
 */

// ============================================================================
// 1. Agent Log - 滚动日志
// ============================================================================

/** 日志类型 */
export type AgentLogType = 
  | 'info'      // 普通信息
  | 'step'      // 步骤变更
  | 'tool'      // 工具调用
  | 'llm'       // LLM调用
  | 'mcp'       // MCP调用
  | 'success'   // 成功
  | 'error'     // 错误
  | 'thinking'  // 思考中
  | 'iteration' // 迭代
  | string;     // 允许扩展

/** 单条日志条目 */
export interface AgentLogEntry {
  /** 日志ID */
  id: string;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 日志类型 */
  type: AgentLogType;
  /** 日志消息 */
  message: string;
  /** 详细信息（可选） */
  detail?: string;
  /** 耗时（毫秒，可选） */
  duration?: number;
  /** 扩展字段 */
  [key: string]: any;
}

/** Agent Log 容器 */
export type AgentLog = AgentLogEntry[];

// ============================================================================
// 2. Agent Mind - 思维链
// ============================================================================

/** 思维节点类型 */
export type MindNodeType = 
  | 'thinking'        // 思考
  | 'mcp_selection'   // MCP工具选择
  | 'iteration'       // 自迭代选择
  | 'decision'        // 决策
  | 'planning'        // 规划
  | 'reflection'      // 反思
  | string;           // 允许扩展

/** 思维节点状态 */
export type MindNodeStatus = 
  | 'pending' 
  | 'running' 
  | 'completed' 
  | 'error' 
  | 'interrupted'
  | string;

/** 单个思维节点 */
export interface MindNode {
  /** 节点ID */
  id: string;
  /** 节点类型 */
  type: MindNodeType;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 状态 */
  status: MindNodeStatus;
  /** 标题/摘要 */
  title: string;
  /** 思考内容 */
  content?: string;
  /** 耗时（毫秒） */
  duration?: number;
  /** MCP相关信息（当 type='mcp_selection' 时） */
  mcp?: {
    server?: string;
    serverName?: string;
    toolName?: string;
    arguments?: any;
    result?: any;
  };
  /** 迭代相关信息（当 type='iteration' 时） */
  iteration?: {
    round: number;
    maxRounds: number;
    isFinal: boolean;
    action?: string;
  };
  /** 决策相关信息（当 type='decision' 时） */
  decision?: {
    action: string;
    reason?: string;
    nextStep?: string;
  };
  /** 错误信息 */
  error?: string;
  /** 扩展字段 */
  [key: string]: any;
}

/** Agent Mind 容器 */
export interface AgentMind {
  /** 主要思考文本（模型原始thinking输出） */
  thinking?: string;
  /** 思维节点列表 */
  nodes: MindNode[];
  /** 思维签名（用于Gemini等模型的思维验证） */
  thoughtSignature?: string;
  /** 工具调用签名 */
  toolCallSignatures?: Record<string, string>;
}

// ============================================================================
// 3. Agent Ext Content - 外部内容
// ============================================================================

/** 媒体类型 */
export type MediaType = 'image' | 'video' | 'audio' | 'file';

/** 媒体项 */
export interface MediaItem {
  /** 媒体ID */
  id?: string;
  /** 媒体类型 */
  type: MediaType;
  /** MIME类型 */
  mimeType: string;
  /** Base64数据或URL */
  data: string;
  /** URL（可选） */
  url?: string;
  /** 名称（可选） */
  name?: string;
  /** 大小（字节，可选） */
  size?: number;
  /** 来源（可选，如MCP服务名） */
  source?: string;
}

/** MCP调用结果 */
export interface MCPResult {
  /** 执行ID */
  executionId?: string;
  /** MCP服务器ID */
  serverId: string;
  /** MCP服务器名称 */
  serverName?: string;
  /** 工具名称 */
  toolName: string;
  /** 调用参数 */
  arguments?: any;
  /** 返回结果 */
  result?: any;
  /** 原始结果（包含完整的content数组） */
  rawResult?: any;
  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'error';
  /** 错误信息 */
  errorMessage?: string;
  /** 耗时（毫秒） */
  duration?: number;
  /** 从结果中提取的媒体 */
  extractedMedia?: MediaItem[];
}

/** Agent Ext Content 容器 */
export interface AgentExtContent {
  /** 媒体资源列表 */
  media?: MediaItem[];
  /** MCP调用结果列表 */
  mcpResults?: MCPResult[];
  /** 工作流执行结果（如果有） */
  workflowResults?: any[];
  /** 引用/参考内容 */
  references?: Array<{
    type: 'url' | 'file' | 'message';
    title?: string;
    url?: string;
    content?: string;
  }>;
}

// ============================================================================
// 4. Agent Output - 模型输出
// ============================================================================

/** Agent Output */
export interface AgentOutput {
  /** 主要文本内容 */
  content: string;
  /** 是否为总结 */
  isSummary?: boolean;
  /** 完成原因 */
  finishReason?: string;
  /** Token统计 */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// 完整的 Agent Response 结构
// ============================================================================

/** 完整的 Agent Response Ext 结构（存储在 message.ext 中） */
export interface AgentResponseExt {
  /** 滚动日志 */
  agent_log?: AgentLog;
  /** 思维链 */
  agent_mind?: AgentMind;
  /** 外部内容 */
  agent_ext_content?: AgentExtContent;
  
  // ========== 向后兼容字段 ==========
  /** @deprecated 使用 agent_log */
  log?: AgentLogEntry[];
  /** @deprecated 使用 agent_log */
  executionLogs?: AgentLogEntry[];
  /** @deprecated 使用 agent_mind.nodes */
  processMessages?: any[];
  /** @deprecated 使用 agent_mind.nodes */
  processSteps?: any[];
  /** @deprecated 使用 agent_ext_content.media */
  media?: MediaItem[];
  /** @deprecated 使用 agent_mind.thoughtSignature */
  thoughtSignature?: string;
  /** @deprecated 使用 agent_mind.toolCallSignatures */
  toolCallSignatures?: Record<string, string>;
  
  // 其他扩展字段
  error?: string;
  llmResponse?: {
    usage?: any;
    finish_reason?: string;
    raw_response?: any;
  };
  [key: string]: any;
}

// ============================================================================
// 工具函数：从旧结构转换为新结构
// ============================================================================

/**
 * 从旧的 ext 结构转换为新的 AgentResponseExt
 * 保持向后兼容
 */
export function normalizeAgentResponseExt(ext: any): AgentResponseExt {
  if (!ext) return {};
  
  const result: AgentResponseExt = { ...ext };
  
  // 1. 归一化 agent_log
  if (!result.agent_log) {
    result.agent_log = result.log || result.executionLogs || [];
  }
  
  // 2. 归一化 agent_mind
  if (!result.agent_mind) {
    const nodes: MindNode[] = [];
    
    // 从 processMessages 转换
    if (Array.isArray(result.processMessages)) {
      for (const pm of result.processMessages) {
        nodes.push(convertProcessMessageToMindNode(pm));
      }
    }
    // 从 processSteps 转换（旧协议）
    else if (Array.isArray(result.processSteps)) {
      for (const ps of result.processSteps) {
        nodes.push(convertProcessStepToMindNode(ps));
      }
    }
    
    result.agent_mind = {
      thinking: result.thinking,
      nodes,
      thoughtSignature: result.thoughtSignature,
      toolCallSignatures: result.toolCallSignatures,
    };
  }
  
  // 3. 归一化 agent_ext_content
  if (!result.agent_ext_content) {
    result.agent_ext_content = {
      media: result.media || [],
      mcpResults: [],
    };
  }
  
  return result;
}

/**
 * 从 ProcessMessage 转换为 MindNode
 */
function convertProcessMessageToMindNode(pm: any): MindNode {
  return {
    id: pm.meta?.step_id || `node-${pm.timestamp}`,
    type: mapProcessTypeToMindType(pm.type),
    timestamp: pm.timestamp || Date.now(),
    status: pm.meta?.status || 'completed',
    title: pm.title || pm.type,
    content: pm.content,
    mcp: pm.meta?.mcpServer ? {
      server: pm.meta.mcpServer,
      serverName: pm.meta.mcpServerName,
      toolName: pm.meta.toolName,
      arguments: pm.meta.arguments,
      result: pm.meta.result,
    } : undefined,
    iteration: pm.meta?.iteration !== undefined ? {
      round: pm.meta.iteration,
      maxRounds: pm.meta.max_iterations || 10,
      isFinal: pm.meta.is_final_iteration || false,
    } : undefined,
    error: pm.meta?.error,
    // 保留原始数据
    _raw: pm,
  };
}

/**
 * 从 ProcessStep 转换为 MindNode
 */
function convertProcessStepToMindNode(ps: any): MindNode {
  return {
    id: ps.step_id || `node-${ps.timestamp}`,
    type: mapProcessTypeToMindType(ps.type),
    timestamp: ps.timestamp || Date.now(),
    status: ps.status || 'completed',
    title: ps.toolName || ps.action || ps.type,
    content: ps.thinking,
    mcp: ps.mcpServer ? {
      server: ps.mcpServer,
      serverName: ps.mcpServerName,
      toolName: ps.toolName,
      arguments: ps.arguments,
      result: ps.result,
    } : undefined,
    iteration: ps.iteration !== undefined ? {
      round: ps.iteration,
      maxRounds: ps.max_iterations || 10,
      isFinal: ps.is_final_iteration || false,
    } : undefined,
    decision: ps.action ? {
      action: ps.action,
      reason: ps.thinking,
    } : undefined,
    duration: ps.duration,
    error: ps.error,
    _raw: ps,
  };
}

/**
 * 映射处理类型到思维节点类型
 */
function mapProcessTypeToMindType(processType: string): MindNodeType {
  const mapping: Record<string, MindNodeType> = {
    'thinking': 'thinking',
    'mcp_call': 'mcp_selection',
    'mcp_selection': 'mcp_selection',
    'tool_call': 'mcp_selection',
    'iteration': 'iteration',
    'agent_decision': 'decision',
    'planning': 'planning',
    'reflection': 'reflection',
    'llm_generating': 'thinking',
  };
  return mapping[processType] || processType;
}

/**
 * 从 Agent Mind 提取关键节点（用于简洁展示）
 */
export function extractKeyMindNodes(mind: AgentMind): MindNode[] {
  if (!mind?.nodes) return [];
  
  // 只保留关键类型的节点
  const keyTypes: MindNodeType[] = ['thinking', 'mcp_selection', 'iteration', 'decision'];
  
  return mind.nodes.filter(node => 
    keyTypes.includes(node.type) || 
    node.status === 'error'
  );
}

/**
 * 从 AgentExtContent 提取所有媒体（包括MCP结果中的）
 */
export function extractAllMedia(extContent: AgentExtContent): MediaItem[] {
  const media: MediaItem[] = [];
  
  // 直接的媒体
  if (extContent.media) {
    media.push(...extContent.media);
  }
  
  // MCP结果中提取的媒体
  if (extContent.mcpResults) {
    for (const mcpResult of extContent.mcpResults) {
      if (mcpResult.extractedMedia) {
        media.push(...mcpResult.extractedMedia);
      }
    }
  }
  
  return media;
}
