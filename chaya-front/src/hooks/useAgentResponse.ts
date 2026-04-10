/**
 * useAgentResponse Hook
 * 
 * 从消息中提取规范化的 Agent Response 数据
 * 自动兼容新旧字段结构
 */

import { useMemo } from 'react';
import type { 
  AgentLog, 
  AgentMind, 
  AgentExtContent, 
  AgentOutput,
  AgentLogEntry,
  MindNode,
  MediaItem,
  MCPResult,
  normalizeAgentResponseExt,
} from '../types/agentResponse';

interface Message {
  id: string;
  role: string;
  content: string;
  thinking?: string;
  ext?: any;
  mcpdetail?: any;
  processMessages?: any[];
  executionLogs?: any[];
  media?: any[];
  thoughtSignature?: string;
  toolCallSignatures?: Record<string, string>;
  [key: string]: any;
}

interface AgentResponseData {
  /** 滚动日志 */
  log: AgentLog;
  /** 思维链 */
  mind: AgentMind;
  /** 外部内容 */
  extContent: AgentExtContent;
  /** 模型输出 */
  output: AgentOutput;
  /** 是否有数据 */
  hasData: boolean;
}

/**
 * 从消息中提取 Agent Response 数据
 * 自动兼容新旧字段结构
 */
export function useAgentResponse(message: Message | null | undefined): AgentResponseData {
  return useMemo(() => {
    if (!message) {
      return {
        log: [],
        mind: { nodes: [] },
        extContent: {},
        output: { content: '' },
        hasData: false,
      };
    }

    const ext = message.ext || {};
    
    // 1. 提取 Agent Log（滚动日志）
    const log = extractAgentLog(message, ext);
    
    // 2. 提取 Agent Mind（思维链）
    const mind = extractAgentMind(message, ext);
    
    // 3. 提取 Agent Ext Content（外部内容）
    const extContent = extractAgentExtContent(message, ext);
    
    // 4. 提取 Agent Output（模型输出）
    const output = extractAgentOutput(message, ext);
    
    const hasData = 
      log.length > 0 || 
      mind.nodes.length > 0 || 
      !!mind.thinking ||
      (extContent.media && extContent.media.length > 0) ||
      (extContent.mcpResults && extContent.mcpResults.length > 0) ||
      !!output.content;

    return { log, mind, extContent, output, hasData };
  }, [message]);
}

/**
 * 提取滚动日志
 */
function extractAgentLog(message: Message, ext: any): AgentLog {
  // 优先使用新字段
  if (ext.agent_log && Array.isArray(ext.agent_log)) {
    return ext.agent_log;
  }
  
  // 向后兼容：尝试旧字段
  if (ext.log && Array.isArray(ext.log)) {
    return ext.log;
  }
  
  if (ext.executionLogs && Array.isArray(ext.executionLogs)) {
    return ext.executionLogs;
  }
  
  if (message.executionLogs && Array.isArray(message.executionLogs)) {
    return message.executionLogs;
  }
  
  // 从 mcpdetail 中提取日志
  if (message.mcpdetail?.logs && Array.isArray(message.mcpdetail.logs)) {
    return message.mcpdetail.logs.map((log: string, index: number) => ({
      id: `mcplog-${index}`,
      timestamp: Date.now(),
      type: 'mcp',
      message: log,
    }));
  }
  
  return [];
}

/**
 * 提取思维链
 */
function extractAgentMind(message: Message, ext: any): AgentMind {
  // 优先使用新字段
  if (ext.agent_mind) {
    return {
      thinking: message.thinking || ext.agent_mind.thinking,
      nodes: ext.agent_mind.nodes || [],
      thoughtSignature: ext.agent_mind.thoughtSignature || message.thoughtSignature || ext.thoughtSignature,
      toolCallSignatures: ext.agent_mind.toolCallSignatures || message.toolCallSignatures || ext.toolCallSignatures,
    };
  }
  
  // 向后兼容：从 processMessages 或 processSteps 构建
  const nodes: MindNode[] = [];
  
  // 尝试 processMessages（新协议）
  const processMessages = message.processMessages || ext.processMessages;
  if (Array.isArray(processMessages)) {
    for (const pm of processMessages) {
      nodes.push(convertProcessMessageToMindNode(pm));
    }
  }
  // 尝试 processSteps（旧协议）
  else if (Array.isArray(ext.processSteps)) {
    for (const ps of ext.processSteps) {
      nodes.push(convertProcessStepToMindNode(ps));
    }
  }
  
  return {
    thinking: message.thinking,
    nodes,
    thoughtSignature: message.thoughtSignature || ext.thoughtSignature,
    toolCallSignatures: message.toolCallSignatures || ext.toolCallSignatures,
  };
}

/**
 * 提取外部内容
 */
function extractAgentExtContent(message: Message, ext: any): AgentExtContent {
  // 优先使用新字段
  if (ext.agent_ext_content) {
    return ext.agent_ext_content;
  }
  
  const result: AgentExtContent = {};
  
  // 收集媒体
  const allMedia: MediaItem[] = [];
  
  // 从 ext.media
  if (Array.isArray(ext.media)) {
    allMedia.push(...ext.media.map(normalizeMediaItem));
  }
  
  // 从 message.media
  if (Array.isArray(message.media)) {
    allMedia.push(...message.media.map(normalizeMediaItem));
  }
  
  // 从 mcpdetail 提取媒体
  if (message.mcpdetail?.raw_result) {
    const mcpMedia = extractMediaFromMCPResult(message.mcpdetail.raw_result);
    allMedia.push(...mcpMedia);
  }
  
  if (allMedia.length > 0) {
    result.media = allMedia;
  }
  
  // 提取 MCP 结果
  const mcpResults = extractMCPResults(message, ext);
  if (mcpResults.length > 0) {
    result.mcpResults = mcpResults;
  }
  
  return result;
}

/**
 * 提取模型输出
 */
function extractAgentOutput(message: Message, ext: any): AgentOutput {
  return {
    content: message.content || '',
    isSummary: message.isSummary,
    finishReason: ext.llmResponse?.finish_reason,
    usage: ext.llmResponse?.usage,
  };
}

/**
 * 从 MCP 结果中提取媒体
 */
function extractMediaFromMCPResult(result: any): MediaItem[] {
  const media: MediaItem[] = [];
  if (!result) return media;
  
  let content = null;
  if (typeof result === 'object') {
    if (result.result?.content) {
      content = result.result.content;
    } else if (result.content) {
      content = result.content;
    }
  }
  
  if (!Array.isArray(content)) return media;
  
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    
    if (item.type === 'image' && item.data) {
      media.push({
        type: 'image',
        mimeType: item.mimeType || item.mime_type || 'image/png',
        data: item.data,
      });
    } else if ((item.type === 'video' || item.type === 'audio') && (item.data || item.url)) {
      media.push({
        type: item.type,
        mimeType: item.mimeType || item.mime_type,
        data: item.data || item.url,
      });
    }
  }
  
  return media;
}

/**
 * 提取 MCP 结果
 */
function extractMCPResults(message: Message, ext: any): MCPResult[] {
  const results: MCPResult[] = [];
  
  // 从 mcpdetail 提取
  if (message.mcpdetail) {
    const detail = message.mcpdetail;
    results.push({
      executionId: detail.execution_id,
      serverId: detail.component_id || '',
      serverName: detail.component_name,
      toolName: detail.tool_name || '',
      arguments: detail.arguments,
      result: detail.result,
      rawResult: detail.raw_result,
      status: detail.status || 'completed',
      errorMessage: detail.error_message,
      extractedMedia: extractMediaFromMCPResult(detail.raw_result),
    });
  }
  
  // 从 processMessages 或 processSteps 中提取
  const processMessages = message.processMessages || ext.processMessages || ext.processSteps;
  if (Array.isArray(processMessages)) {
    for (const pm of processMessages) {
      const meta = pm.meta || pm;
      if (meta.mcpServer || meta.toolName) {
        const existing = results.find(r => 
          r.serverId === meta.mcpServer && r.toolName === meta.toolName
        );
        if (!existing) {
          results.push({
            serverId: meta.mcpServer || '',
            serverName: meta.mcpServerName,
            toolName: meta.toolName || '',
            arguments: meta.arguments,
            result: meta.result,
            status: meta.status || 'completed',
            errorMessage: meta.error,
            extractedMedia: extractMediaFromMCPResult(meta.result),
          });
        }
      }
    }
  }
  
  return results;
}

/**
 * 标准化媒体项
 */
function normalizeMediaItem(item: any): MediaItem {
  return {
    id: item.id,
    type: item.type || 'image',
    mimeType: item.mimeType || item.mime_type || 'image/png',
    data: item.data || item.url || '',
    url: item.url,
    name: item.name,
    size: item.size,
    source: item.source,
  };
}

/**
 * 从 ProcessMessage 转换为 MindNode
 */
function convertProcessMessageToMindNode(pm: any): MindNode {
  const meta = pm.meta || {};
  return {
    id: meta.step_id || `node-${pm.timestamp}`,
    type: mapProcessTypeToMindType(pm.type),
    timestamp: pm.timestamp || Date.now(),
    status: meta.status || 'completed',
    title: pm.title || pm.type,
    content: pm.content,
    mcp: meta.mcpServer ? {
      server: meta.mcpServer,
      serverName: meta.mcpServerName,
      toolName: meta.toolName,
      arguments: meta.arguments,
      result: meta.result,
    } : undefined,
    iteration: meta.iteration !== undefined ? {
      round: meta.iteration,
      maxRounds: meta.max_iterations || 10,
      isFinal: meta.is_final_iteration || false,
    } : undefined,
    error: meta.error,
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
  };
}

/**
 * 映射处理类型到思维节点类型
 */
function mapProcessTypeToMindType(processType: string): string {
  const mapping: Record<string, string> = {
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

export default useAgentResponse;
