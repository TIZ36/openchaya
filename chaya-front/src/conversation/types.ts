import type { ProcessMessage } from '../types/processMessage';

export type UnifiedRole = 'user' | 'assistant' | 'system' | 'tool';

export type UnifiedMediaType = 'image' | 'video' | 'audio' | 'file';

export interface UnifiedMedia {
  type: UnifiedMediaType;
  url: string;
  mimeType?: string;
  name?: string;
  size?: number;
  /** 可选：用于去重/跟踪 */
  id?: string;
  /** 可选：缩略图（如视频封面） */
  thumbnailUrl?: string;
}

export interface UnifiedMessage {
  id: string;
  role: UnifiedRole;
  content: string;
  /** ISO string */
  createdAt: string;
  media?: UnifiedMedia[];
  /** 兼容现有 Workflow/Research 的常用字段（避免大面积改动） */
  thinking?: string;
  toolCalls?: any;
  tokenCount?: number;
  /** 过程消息（新协议） */
  processMessages?: ProcessMessage[];
  /** 思维签名（Gemini 模型使用） */
  thoughtSignature?: string;
  /** MCP 执行详情 */
  mcpdetail?: Record<string, any>;
  /** 扩展数据（包含 media.thoughtSignature 等） */
  ext?: Record<string, any>;
  /** 容纳各模块特有信息（会议多响应、tokens、toolCalls 等） */
  meta?: Record<string, any>;
}

export type ConversationCursor = string | null;

export interface ListMessagesParams {
  cursor?: ConversationCursor;
  pageSize?: number;
}

export interface ListMessagesResult {
  items: UnifiedMessage[];
  /** 用于继续向“更早”加载 */
  nextCursor: ConversationCursor;
  hasMore: boolean;
}

export interface SendMessagePayload {
  role?: UnifiedRole;
  content: string;
  media?: UnifiedMedia[];
  meta?: Record<string, any>;
}

export interface ConversationAdapter {
  /** 用于缓存的唯一 key，例如 `session:${id}` */
  key: string;

  listMessages: (params: ListMessagesParams) => Promise<ListMessagesResult>;

  /** 可选：由上层决定是否走 adapter 发送 */
  sendMessage?: (payload: SendMessagePayload) => Promise<UnifiedMessage | void>;

  deleteMessage?: (messageId: string) => Promise<void>;

  /** 可选：流式/轮询新消息订阅 */
  subscribeNewMessages?: (onMessage: (m: UnifiedMessage) => void) => () => void;

  /** 可选：用于顶部条/标题/参与者等上下文 */
  getContext?: () => Promise<any>;
}

