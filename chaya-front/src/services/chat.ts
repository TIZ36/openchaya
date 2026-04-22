import type { ProcessMessage } from '../types/processMessage';

/**
 * 会话与消息 API（原 sessionApi，现统一为 chat.ts）
 *
 * 与 usersession-agid-convid 规则一致，三者勿混：
 * - **usersession**：登录后 WebSocket 连接级 id（Gateway `usersession_ready.usersession_id`），不在本类型字段中。
 * - **convid**：对话 `conversations.id`；消息与 WS `subscribe` topic 使用该 id。
 * - **agid**：`agents.id`；Agent 列表项见 `Session.id`。
 *
 * 后端历史字段名 `session_id` 沿用；语义为 **convid（对话 id）**，不是 usersession。
 */

export interface Session {
  /** 对话 id（convid）。消息与 WS topic；非 usersession。 */
  session_id: string;
  title?: string;
  name?: string; // 用户自定义会话名称
  llm_config_id?: string;
  avatar?: string; // base64编码的头像
  system_prompt?: string; // 系统提示词（人设）
  media_output_path?: string; // 媒体输出本地路径（图片/视频/音频）
  session_type?: 'temporary' | 'memory' | 'agent' | 'research' | 'topic_general'; // 会话类型：临时会话/记忆体/智能体/研究/话题
  // 角色应用（会话绑定角色版本，用于可复盘）
  role_id?: string | null;
  role_version_id?: string | null;
  // 仅对角色（agent）返回：当前激活的角色版本
  current_role_version_id?: string | null;
  // 扩展字段（存储 persona 等配置）
  ext?: Record<string, any>;
  // 技能包（能力集）
  skill_packs?: any[];
  created_at?: string;
  updated_at?: string;
  last_message_at?: string;
  message_count?: number;
  preview_text?: string; // 第一条用户消息的缩略（如果没有名字时使用）
  /** 后端 Agent 列表返回：是否为主 Agent */
  is_primary?: boolean;
  /** Agent 实体 id（agid）；与 session_id（convid）不是同一概念 */
  id?: string;
  /** 后端 agents.type：primary / sub / generic（用户新建，可删）等 */
  type?: string;
}

/** 主 Agent（Primag）：音色 / 自驱思考 / 行为拓扑与记忆锚点等仅对其开放 */
export function isPrimaryAgentSession(s: Session | null | undefined): boolean {
  return s?.is_primary === true;
}

/** 调用 /api/agents/{id}/… 时使用：优先 agid（Session.id），否则回退 session_id（非 usersession） */
export function agentApiId(s: Session): string {
  const raw = s as any;
  if (raw.id && typeof raw.id === 'string') return raw.id;
  return s.session_id;
}

export interface Message {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: any;
  token_count?: number;
  created_at?: string;
  tool_type?: 'workflow' | 'mcp'; // 感知组件类型（当 role === 'tool' 时使用）
  ext?: MessageExt; // 扩展数据
  mcpdetail?: MCPDetail; // MCP 执行详情（当 role === 'assistant' 且触发了 MCP 时）
}

export interface MCPDetail {
  execution_id: string;
  component_type: 'mcp' | 'workflow';
  component_id: string;
  component_name?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  logs?: string[];
  raw_result?: any; // 原始结果（包含图片等）
  /** 旧结构兼容：OpenAI tool calls */
  tool_calls?: any[];
  /** 旧结构兼容：tool results */
  tool_results?: any[];
  error_message?: string;
  executed_at?: string;
}

// 消息扩展数据（用于存储 Gemini 等模型的特殊数据）
export interface MessageExt {
  // Gemini 相关
  provider?: string; // LLM 提供商
  model?: string; // 模型名称
  enableThinking?: boolean; // 是否启用 thinking 模式
  thinkingBudget?: number; // thinking 预算
  thoughtSignature?: string; // 思维签名（用于多轮对话）
  toolCallSignatures?: Record<string, string>; // 工具调用的思维签名
  // 多模态相关
  media?: Array<{
    type: 'image' | 'video' | 'audio';
    mimeType: string;
    data: string;
  }>;
  // 过程消息（新协议）
  processMessages?: ProcessMessage[];
  // 执行日志（持久化）
  agent_log?: Array<{ id: string; timestamp: number; type: string; message: string; detail?: string; duration?: number; agent_id?: string; agent_name?: string; message_id?: string }>;
  log?: Array<{ id: string; timestamp: number; type: string; message: string; detail?: string; duration?: number; agent_id?: string; agent_name?: string; message_id?: string }>;
  executionLogs?: Array<{ id: string; timestamp: number; type: string; message: string; detail?: string; duration?: number; agent_id?: string; agent_name?: string; message_id?: string }>;
  /** 用户对助手本条回复的评价（持久化在 messages.ext，供拓扑合并等使用） */
  assistant_feedback?: 'up' | 'down';
  assistant_feedback_at?: string;
}

export interface Summary {
  summary_id: string;
  session_id: string;
  summary_content: string;
  last_message_id?: string;
  token_count_before?: number;
  token_count_after?: number;
  created_at?: string;
}


import { getBackendUrl } from '../utils/backendUrl';
import { ensureDataUrlFromMaybeBase64 } from '../utils/dataUrl';

const API_BASE = `${getBackendUrl()}/api`;

// Wrap fetch with JWT auth + {code, data} unwrapping
const _origFetch = globalThis.fetch;
async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Content-Type'] && init?.method && init.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }
  return _origFetch(input, { ...init, headers });
}

// Unwrap {code, data} response
async function unwrapJson<T = any>(res: Response): Promise<T> {
  const body = await res.json();
  if (body && typeof body === 'object' && 'code' in body) {
    if (body.code !== 0) throw new Error(body.error || `API error ${body.code}`);
    return body.data as T;
  }
  return body as T;
}

function normalizeSessionAvatar(session: Session): Session {
  if (!session) return session;
  const raw = session as any;

  // For agents: use conversation_id as session_id (messages are stored under conversation_id)
  // For conversations: use id directly
  if (!session.session_id) {
    session = { ...session, session_id: raw.conversation_id || raw.id };
  }

  // Map agent type to session_type
  if (!session.session_type && raw.type === 'primary') {
    session = { ...session, session_type: 'agent' };
  }
  if (!session.session_type && raw.type === 'sub') {
    session = { ...session, session_type: 'agent' };
  }
  if (!session.session_type && raw.type === 'generic') {
    session = { ...session, session_type: 'agent' };
  }

  // Map 'title' to 'name' if name is missing
  if (!session.name && session.title) {
    session = { ...session, name: session.title };
  }
  const avatar = session.avatar ? ensureDataUrlFromMaybeBase64(session.avatar, 'image/jpeg') : session.avatar;
  if (avatar === session.avatar) return session;
  return { ...session, avatar };
}

function normalizeSessionList(sessions: Session[]): Session[] {
  return (sessions || []).map((s) => normalizeSessionAvatar(s));
}

/**
 * 获取会话列表
 */
export async function getSessions(): Promise<Session[]> {
  try {
    const response = await authFetch(`${API_BASE}/conversations`);
    if (!response.ok) {
      console.warn(`Failed to fetch sessions: ${response.statusText}`);
      return [];
    }
    const data = await unwrapJson<Session[]>(response);
    return normalizeSessionList(data || []);
  } catch (error) {
    console.warn('Error fetching sessions:', error);
    return [];
  }
}

/**
 * 获取智能体列表
 */
export async function getAgents(): Promise<Session[]> {
  try {
    const response = await authFetch(`${API_BASE}/agents`);
    if (!response.ok) {
      console.warn(`Failed to fetch agents: ${response.statusText}`);
      return [];
    }
    const data = await unwrapJson<Session[]>(response);
    return normalizeSessionList(data || []);
  } catch (error) {
    console.warn('Error fetching agents:', error);
    return [];
  }
}

/**
 * 新建通用 Agent（后端 type=generic，非主 Agent，可删除），并绑定专属会话。
 */
export async function createAgent(params?: { name?: string }): Promise<Session> {
  const response = await authFetch(`${API_BASE}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error((errBody as any).error || `Failed to create agent: ${response.statusText}`);
  }
  const data = await unwrapJson<Session>(response);
  return normalizeSessionAvatar(data as Session);
}

/**
 * 删除非主 Agent（后端级联会话、消息、技能绑定等）
 */
export async function deleteAgent(agent_id: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/agents/${encodeURIComponent(agent_id)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((errorData as any).error || `Failed to delete agent: ${response.statusText}`);
  }
}

/**
 * 获取记忆体（话题）列表
 */
export async function getMemories(): Promise<Session[]> {
  try {
    const response = await authFetch(`${API_BASE}/conversations?type=memory`);
    if (!response.ok) {
      console.warn(`Failed to fetch memories: ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    return normalizeSessionList(data || []);
  } catch (error) {
    console.warn('Error fetching memories:', error);
    return [];
  }
}

/**
 * 创建新会话
 */

/**
 * 获取会话详情
 */
export async function getSession(session_id: string): Promise<Session> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch session: ${response.statusText}`);
  }
  const data = await unwrapJson<Session>(response);
  return normalizeSessionAvatar(data);
}

/**
 * 铭牌 / 详情用：拉取 Agent 完整配置（system_prompt、ext.persona 等在 agents 表）。
 * conversationId 为 convid（与 Workflow sessionId 一致）；可传 agid 避免重复 getAgents。
 * 若无法解析为 Agent，回退为 getSession（仅会话壳数据）。
 */
/** 铭牌：MCP / Skill / 知识库 绑定与在线状态（GET /api/agents/:id/harness-status） */


/** 按 Agent 实体 id（agid）拉取详情，含头像；用于消息列表按 sender_id 解析头像 */
export async function getAgentById(agentId: string): Promise<Session | null> {
  const id = agentId?.trim();
  if (!id) return null;
  try {
    const response = await authFetch(`${API_BASE}/agents/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const data = await unwrapJson<Session>(response);
    return normalizeSessionAvatar(data as Session);
  } catch {
    return null;
  }
}

/**
 * 获取会话消息（分页）- 传统分页方式，向后兼容
 * @param lightweight 轻量级模式：只返回必要字段（role, content, created_at），加快加载速度
 */
export async function getSessionMessages(
  session_id: string,
  page: number = 1,
  page_size: number = 20,  // 默认只加载20条，加快初始加载速度
  lightweight: boolean = false  // 轻量级模式，用于快速加载（如 ResearchPanel）
): Promise<{
  messages: Message[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}> {
  try {
    const url = new URL(`${API_BASE}/sessions/${session_id}/messages`);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('page_size', page_size.toString());
    if (lightweight) {
      url.searchParams.set('lightweight', 'true');
    }
    
    const response = await authFetch(url.toString());
    if (!response.ok) {
      console.warn(`Failed to fetch messages: ${response.statusText}`);
      return { messages: [], total: 0, page, page_size, total_pages: 0 };
    }
    const raw = await response.json();
    const data = (raw && raw.code === 0 && raw.data) ? raw.data : raw;
    const msgs = Array.isArray(data) ? data : (data.messages || []);
    // Map backend 'id' → frontend 'message_id'
    const normalized = msgs.map((m: any) => ({
      ...m,
      message_id: m.message_id || m.id,
      session_id: m.session_id || m.conv_id || session_id,
    }));
    return { messages: normalized, total: normalized.length, page, page_size, total_pages: 1 };
  } catch (error) {
    console.warn('Error fetching messages:', error);
    return { messages: [], total: 0, page, page_size, total_pages: 0 };
  }
}

/**
 * 获取会话消息（游标分页）- 高效分页方式，基于 message_id
 * @param before_id 获取此消息之前的消息（游标）
 * @param limit 获取数量
 * @param lightweight 轻量级模式
 */

/**
 * 获取单个消息（基于message_id），用于增量加载
 */
export async function getMessage(message_id: string): Promise<Message | null> {
  try {
    const response = await authFetch(`${API_BASE}/messages/${message_id}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      console.warn(`Failed to fetch message: ${response.statusText}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn('Error fetching message:', error);
    return null;
  }
}

/**
 * 保存消息到会话
 */

/**
 * 总结会话内容
 */

/**
 * 获取会话的所有总结
 */
export async function getSessionSummaries(session_id: string): Promise<Summary[]> {
  try {
    const response = await authFetch(`${API_BASE}/sessions/${session_id}/summaries`);
    if (!response.ok) {
      console.warn(`Failed to fetch summaries: ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    return data || [];
  } catch (error) {
    console.warn('Error fetching summaries:', error);
    return [];
  }
}

/**
 * 删除会话
 */
export async function deleteSession(session_id: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorData.error || `Failed to delete session: ${response.statusText}`);
  }
}

/**
 * 清除会话的总结缓存
 */
export async function clearSummarizeCache(session_id: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/summaries/cache`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to clear summarize cache: ${response.statusText}`);
  }
}

/**
 * 删除会话中的消息
 */
export async function deleteMessage(session_id: string, message_id: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/messages/${message_id}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to delete message: ${response.statusText}`);
  }
}

/**
 * 助手消息点赞/点踩（写入 messages.ext，并记录拓扑轨迹 assistant_feedback）
 * @param rating null 表示清除评价
 */

/**
 * 执行消息关联的感知组件
 */

/**
 * 获取消息的执行记录
 */

/**
 * 列出会话内所有执行记录（用于时间线视图）
 */

/**
 * 更新会话的机器人头像
 */
export async function updateSessionAvatar(session_id: string, avatar: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/avatar`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ avatar }),
  });
  if (!response.ok) {
    // 兼容后端仅支持 PUT /sessions/{id}
    if (response.status === 404) {
      await updateSession(session_id, { avatar });
      return;
    }
    throw new Error(`Failed to update avatar: ${response.statusText}`);
  }
}

/**
 * 通用会话更新函数
 */
export async function updateSession(session_id: string, data: Partial<Session>): Promise<Session> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`Failed to update session: ${response.statusText}`);
  }
  return normalizeSessionAvatar(await unwrapJson<Session>(response));
}

/**
 * 更新会话的用户自定义名称
 */
export async function updateSessionName(session_id: string, name: string): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/name`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    // 兼容后端仅支持 PUT /sessions/{id}
    if (response.status === 404) {
      await updateSession(session_id, { name });
      return;
    }
    throw new Error(`Failed to update session name: ${response.statusText}`);
  }
}

/**
 * 更新会话类型（用于切换积极模式）
 */
export async function updateSessionType(session_id: string, session_type: 'topic_general' | 'agent'): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/session-type`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_type }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorData.error || `Failed to update session type: ${response.statusText}`);
  }
}

/**
 * 更新会话的系统提示词（人设）
 */
export async function updateSessionSystemPrompt(session_id: string, system_prompt: string | null): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/system-prompt`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ system_prompt }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update system prompt: ${response.statusText}`);
  }
}

/**
 * 更新会话/智能体的媒体输出路径
 */
export async function updateSessionMediaOutputPath(session_id: string, media_output_path: string | null): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/media-output-path`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ media_output_path }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update media output path: ${response.statusText}`);
  }
}

/**
 * 更新会话/智能体的默认 LLM 配置
 */
export async function updateSessionLLMConfig(session_id: string, llm_config_id: string | null): Promise<void> {
  const response = await authFetch(`${API_BASE}/sessions/${session_id}/llm-config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ llm_config_id }),
  });
  if (!response.ok) {
    throw new Error(`Failed to update LLM config: ${response.statusText}`);
  }
}

/**
 * 升级记忆体为智能体
 */

// ==================== 智能体导入导出 ====================


/**
 * 导出智能体配置（包含LLM配置和密钥）
 */

/**
 * 导入智能体配置
 * @param data 导出的智能体数据
 * @param llmMode 当LLM配置名称已存在时的处理方式: 'use_existing' | 'create_new'
 */

/**
 * 下载智能体配置为JSON文件
 */

/**
 * 从JSON文件导入智能体
 */

// ==================== 参与者管理 API ====================


/**
 * 获取会话参与者列表
 */

/**
 * 添加参与者到会话
 */

/**
 * 从会话移除参与者
 */
