// LLM相关类型
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  finish_reason?: string;
}

export interface LLMConfig {
  id: string;
  provider: 'openai' | 'anthropic' | 'ollama' | 'local' | 'custom' | 'gemini';
  name: string;
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  enabled: boolean;
  metadata?: Record<string, any>;
}

export interface LLMConfigFromDB {
  config_id: string;
  name: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  supplier?: string;  // Token/计费归属供应商（如 nvidia, openai）
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled: boolean;
  description?: string;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface CreateLLMConfigRequest {
  config_id?: string;
  name: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  supplier?: string;  // Token/计费归属供应商（如 nvidia, openai）
  api_key?: string;
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled?: boolean;
  description?: string;
  metadata?: Record<string, any>;
}

// MCP相关类型
export interface MCPServer {
  id: string;
  name: string;
  url: string;
  type: 'http-stream' | 'http-post' | 'stdio';
  enabled: boolean;
  description?: string;
  metadata?: Record<string, any>;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  url: string;
  type: 'http-stream' | 'http-post' | 'stdio';
  enabled: boolean;
  use_proxy?: boolean;
  description?: string;
  metadata?: Record<string, any>;
  ext?: Record<string, any>;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

// 工作流相关类型
export interface WorkflowConfig {
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

export interface WorkflowNode {
  id: string;
  type: 'llm' | 'input' | 'output' | 'workflow' | 'terminal' | 'visualization';
  position: { x: number; y: number };
  data: {
    llmConfigId?: string;
    mcpServerId?: string;
    label?: string;
    inputValue?: string;
    workflowId?: string;
    terminalType?: string;
    visualizationType?: 'json-object' | 'json-array' | 'weblink';
  };
}

export interface WorkflowConnection {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface Workflow {
  id: string;
  workflow_id: string;
  name: string;
  description?: string;
  config: WorkflowConfig;
  created_at?: string;
  updated_at?: string;
}

// 消息类型（用于Workflow组件）
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ name: string; arguments: any; result?: any }>;
}

// Agent Response 类型（新的四大分类）
export * from './agentResponse';
export * from './processMessage';
export * from './processSteps';

