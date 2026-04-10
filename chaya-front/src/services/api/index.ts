/**
 * 新架构 API 客户端
 * 使用新后端 API 路由
 */

import { getBackendUrl } from '../../utils/backendUrl';

// ============================================================================
// 基础请求函数
// ============================================================================

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: any;
  headers?: Record<string, string>;
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  // 使用同步的 getBackendUrl，支持根据当前访问域名动态推断后端地址（支持局域网访问）
  const backendUrl = getBackendUrl();
  const url = `${backendUrl}${endpoint}`;
  
  const config: RequestInit = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  };
  
  if (options.body) {
    config.body = JSON.stringify(options.body);
  }
  
  const response = await fetch(url, config);
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(error.error || error.message || `HTTP ${response.status}`);
  }
  
  return response.json();
}

// ============================================================================
// LLM API
// ============================================================================

export interface LLMConfig {
  config_id: string;
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled: boolean;
  has_api_key?: boolean;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export interface CreateLLMConfigParams {
  name: string;
  provider: string;
  api_key?: string;
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled?: boolean;
  description?: string;
}

export const llmApi = {
  /** 获取所有 LLM 配置 */
  getConfigs: async (enabledOnly = false): Promise<LLMConfig[]> => {
    const response = await request<{ configs: LLMConfig[]; total: number }>(`/api/llm/configs?enabled=${enabledOnly}`);
    return response.configs || [];
  },
  
  /** 获取单个配置 */
  getConfig: (configId: string) => 
    request<LLMConfig>(`/api/llm/configs/${configId}`),
  
  /** 创建配置 */
  createConfig: (data: CreateLLMConfigParams) => 
    request<LLMConfig>('/api/llm/configs', { method: 'POST', body: data }),
  
  /** 更新配置 */
  updateConfig: (configId: string, data: Partial<CreateLLMConfigParams>) => 
    request<LLMConfig>(`/api/llm/configs/${configId}`, { method: 'PUT', body: data }),
  
  /** 删除配置 */
  deleteConfig: (configId: string) => 
    request<{ success: boolean }>(`/api/llm/configs/${configId}`, { method: 'DELETE' }),
  
  /** 获取 API Key */
  getApiKey: (configId: string) => 
    request<{ api_key: string }>(`/api/llm/configs/${configId}/key`),
  
  /** 切换启用状态 */
  toggleEnabled: (configId: string, enabled: boolean) => 
    request<LLMConfig>(`/api/llm/configs/${configId}/toggle`, { 
      method: 'POST', 
      body: { enabled } 
    }),
};

// ============================================================================
// MCP API
// ============================================================================

export interface MCPServer {
  server_id: string;
  name: string;
  url: string;
  type: string;
  enabled: boolean;
  use_proxy: boolean;
  description?: string;
  ext?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface MCPHealth {
  server_id?: string;
  healthy: boolean;
  status_code?: number;
  latency_ms?: number;
  error?: string;
}

export interface CreateMCPServerParams {
  name: string;
  url: string;
  type?: string;
  enabled?: boolean;
  use_proxy?: boolean;
  description?: string;
  ext?: Record<string, any>;
}

export const mcpApi = {
  /** 获取所有 MCP 服务器 */
  getServers: async (enabledOnly = false): Promise<MCPServer[]> => {
    const response = await request<{ servers: MCPServer[]; total: number }>(`/api/mcp/servers?enabled=${enabledOnly}`);
    return response.servers || [];
  },
  
  /** 获取单个服务器 */
  getServer: (serverId: string) => 
    request<MCPServer>(`/api/mcp/servers/${serverId}`),
  
  /** 创建服务器 */
  createServer: (data: CreateMCPServerParams) => 
    request<MCPServer>('/api/mcp/servers', { method: 'POST', body: data }),
  
  /** 更新服务器 */
  updateServer: (serverId: string, data: Partial<CreateMCPServerParams>) => 
    request<MCPServer>(`/api/mcp/servers/${serverId}`, { method: 'PUT', body: data }),
  
  /** 删除服务器 */
  deleteServer: (serverId: string) => 
    request<{ success: boolean }>(`/api/mcp/servers/${serverId}`, { method: 'DELETE' }),
  
  /** 检查单个服务器健康状态 */
  checkHealth: (serverId: string, timeout = 10) => 
    request<MCPHealth>(`/api/mcp/servers/${serverId}/health?timeout=${timeout}`),
  
  /** 检查所有服务器健康状态 */
  checkAllHealth: (timeout = 10) => 
    request<Record<string, MCPHealth>>(`/api/mcp/health?timeout=${timeout}`),
};

// ============================================================================
// Session API
// ============================================================================

export interface Session {
  session_id: string;
  title?: string;
  name?: string;
  llm_config_id?: string;
  session_type: 'temporary' | 'memory' | 'agent';
  avatar?: string;
  system_prompt?: string;
  media_output_path?: string;
  role_id?: string;
  created_at?: string;
  updated_at?: string;
  last_message_at?: string;
}

export interface CreateSessionParams {
  name?: string;
  title?: string;
  llm_config_id?: string;
  session_type?: 'temporary' | 'memory' | 'agent';
  avatar?: string;
  system_prompt?: string;
  media_output_path?: string;
}

export const sessionApi = {
  /** 获取会话列表 */
  getSessions: (params?: { type?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<Session[]>(`/api/sessions?${query.toString()}`);
  },
  
  /** 获取单个会话 */
  getSession: (sessionId: string, includeAvatar = true) => 
    request<Session>(`/api/sessions/${sessionId}?include_avatar=${includeAvatar}`),
  
  /** 创建会话 */
  createSession: (data: CreateSessionParams) => 
    request<Session>('/api/sessions', { method: 'POST', body: data }),
  
  /** 更新会话 */
  updateSession: (sessionId: string, data: Partial<CreateSessionParams>) => 
    request<Session>(`/api/sessions/${sessionId}`, { method: 'PUT', body: data }),
  
  /** 删除会话 */
  deleteSession: (sessionId: string) => 
    request<{ success: boolean }>(`/api/sessions/${sessionId}`, { method: 'DELETE' }),
  
  /** 获取智能体列表 */
  getAgents: (filterByIp = false) => 
    request<Session[]>(`/api/sessions/agents?filter_by_ip=${filterByIp}`),
  
  /** 创建智能体 */
  createAgent: (data: CreateSessionParams) => 
    request<Session>('/api/sessions/agents', { method: 'POST', body: data }),
  
  /** 获取记忆体列表 */
  getMemories: () => 
    request<Session[]>('/api/sessions/memories'),
  
  /** 创建记忆体 */
  createMemory: (data: CreateSessionParams) => 
    request<Session>('/api/sessions/memories', { method: 'POST', body: data }),
};

// ============================================================================
// Message API
// ============================================================================

export interface Message {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: any[];
  token_count?: number;
  acc_token?: number;
  ext?: Record<string, any>;
  mcpdetail?: Record<string, any>;
  created_at?: string;
}

export interface CreateMessageParams {
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: any[];
  token_count?: number;
  ext?: Record<string, any>;
  mcpdetail?: Record<string, any>;
}

/** 分页消息响应 */
export interface PaginatedMessagesResponse {
  messages: Message[];
  latest_message_id: string | null;
  has_more: boolean;
  total_count: number;
  cache_hit: boolean;
}

/** 媒体消息项 */
export interface MediaMessageItem {
  message_id: string;
  timestamp: number;
}

export const messageApi = {
  /** 
   * 获取会话消息（旧 API，保持兼容）
   * @deprecated 请使用 getMessagesPaginated 代替
   */
  getMessages: (sessionId: string, params?: { limit?: number; before?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.before) query.set('before', params.before);
    return request<Message[]>(`/api/messages/session/${sessionId}?${query.toString()}`);
  },
  
  /**
   * 分页获取会话消息（优化版）
   * 支持 Redis 缓存和按需加载
   * 
   * @param sessionId 会话 ID
   * @param params 分页参数
   * @returns 包含最新消息ID和分页信息的响应
   */
  getMessagesPaginated: async (sessionId: string, params?: { 
    limit?: number; 
    before?: string;
    after?: string;
    use_cache?: boolean;
  }): Promise<PaginatedMessagesResponse> => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    // 后端使用 before_id 和 after_id
    if (params?.before) query.set('before_id', params.before);
    if (params?.after) query.set('after_id', params.after);
    if (params?.use_cache !== undefined) query.set('use_cache', params.use_cache.toString());
    
    const response = await request<{
      messages: Message[];
      latest_message_id: string | null;
      has_more: boolean;
      count: number;
    }>(`/api/messages/session/${sessionId}/paginated?${query.toString()}`);
    
    // 转换响应格式
    return {
      messages: response.messages,
      latest_message_id: response.latest_message_id,
      has_more: response.has_more,
      total_count: response.count,
      cache_hit: false, // 后端暂未返回此字段
    };
  },
  
  /**
   * 获取最新消息 ID
   * 用于检查是否有新消息
   */
  getLatestMessageId: (sessionId: string): Promise<{ latest_message_id: string | null }> =>
    request<{ latest_message_id: string | null }>(`/api/messages/session/${sessionId}/latest`),
  
  /**
   * 获取媒体消息列表
   * 用于媒体浏览器快速导航
   */
  getMediaMessages: async (sessionId: string, params?: {
    limit?: number;
    offset?: number;
  }): Promise<{ media_messages: MediaMessageItem[]; total_count: number }> => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    
    const response = await request<{
      media: MediaMessageItem[];
      total: number;
      offset: number;
      limit: number;
    }>(`/api/messages/session/${sessionId}/media?${query.toString()}`);
    
    // 转换响应格式
    return {
      media_messages: response.media,
      total_count: response.total,
    };
  },
  
  /**
   * 刷新消息缓存
   * 在消息编辑或回退后调用
   */
  refreshCache: (sessionId: string): Promise<{ success: boolean; message: string }> =>
    request<{ success: boolean; message: string }>(
      `/api/messages/session/${sessionId}/cache/refresh`,
      { method: 'POST' }
    ),
  
  /** 获取单个消息 */
  getMessage: (messageId: string) => 
    request<Message>(`/api/messages/${messageId}`),
  
  /** 保存消息 */
  saveMessage: (data: CreateMessageParams) => 
    request<Message>('/api/messages', { method: 'POST', body: data }),
  
  /** 批量保存消息 */
  saveMessagesBatch: (messages: CreateMessageParams[]) => 
    request<Message[]>('/api/messages/batch', { method: 'POST', body: messages }),
  
  /** 更新消息 */
  updateMessage: (messageId: string, data: Partial<CreateMessageParams>) => 
    request<Message>(`/api/messages/${messageId}`, { method: 'PUT', body: data }),
  
  /** 删除消息 */
  deleteMessage: (messageId: string) => 
    request<{ success: boolean }>(`/api/messages/${messageId}`, { method: 'DELETE' }),
  
  /** 删除会话所有消息 */
  deleteSessionMessages: (sessionId: string) => 
    request<{ success: boolean; deleted_count: number }>(`/api/messages/session/${sessionId}`, { method: 'DELETE' }),
  
  /** 
   * 回退到指定消息（删除之后的所有消息）
   * 会自动清空缓存
   */
  rollbackToMessage: (sessionId: string, messageId: string): Promise<{ success: boolean; deleted_count: number }> =>
    request<{ success: boolean; deleted_count: number }>(
      `/api/messages/session/${sessionId}/rollback/${messageId}`,
      { method: 'DELETE' }
    ),
  
  /** 统计会话消息数量 */
  countMessages: (sessionId: string) => 
    request<{ count: number }>(`/api/messages/session/${sessionId}/count`),
};

// ============================================================================
// Workflow API
// ============================================================================

export interface Workflow {
  workflow_id: string;
  name: string;
  description?: string;
  config?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface CreateWorkflowParams {
  name: string;
  description?: string;
  config?: Record<string, any>;
}

// 工作流 API 已移除
export const workflowApi = {};

// ============================================================================
// Health API
// ============================================================================

export interface HealthStatus {
  mysql: boolean;
  redis: boolean;
}

export const healthApi = {
  /** 检查后端健康状态 */
  check: () => request<HealthStatus>('/api/health'),
};

// ============================================================================
// 导出所有 API
// ============================================================================

export const api = {
  llm: llmApi,
  mcp: mcpApi,
  session: sessionApi,
  message: messageApi,
  health: healthApi,
};

export default api;
