import type { ConversationAdapter, ListMessagesParams, ListMessagesResult, UnifiedMedia, UnifiedMessage } from '../types';
import { deleteMessage, getSessionMessages, getSessionMessagesCursor, saveMessage, type Message } from '../../services/chat';
import { normalizeBase64ForInlineData } from '../../utils/dataUrl';

function mapSessionMedia(msg: Message): UnifiedMedia[] | undefined {
  const media: UnifiedMedia[] = [];

  const toolCalls = msg.tool_calls as any;
  if (toolCalls && typeof toolCalls === 'object' && !Array.isArray(toolCalls) && Array.isArray(toolCalls.media)) {
    for (const m of toolCalls.media) {
      if (!m?.data && !m?.url) continue;
      media.push({
        type: m.type,
        mimeType: m.mimeType,
        url: m.url || m.data, // 优先使用 url，如果没有则使用 data
      });
    }
  }

  const ext: any = (msg as any).ext;
  if (ext && Array.isArray(ext.media)) {
    for (const m of ext.media) {
      if (!m?.data && !m?.url) continue;
      // 如果 data 是 base64，需要转换为 data URL；如果是 URL，直接使用
      let mediaUrl = m.url;
      if (!mediaUrl && m.data) {
        // 检查是否是 base64 数据
        if (m.data.startsWith('data:')) {
          mediaUrl = m.data;
        } else if (m.mimeType) {
          // 将 base64 数据转换为 data URL
          mediaUrl = `data:${m.mimeType};base64,${m.data}`;
        } else {
          // 没有 mimeType，尝试推断
          const inferredMime = m.type === 'image' ? 'image/png' : m.type === 'video' ? 'video/mp4' : 'audio/mpeg';
          mediaUrl = `data:${inferredMime};base64,${m.data}`;
        }
      }
      const mediaItem: UnifiedMedia = {
        type: m.type,
        mimeType: m.mimeType,
        url: mediaUrl,
      };

      // 保存 thoughtSignature（用于 Gemini 图片）
      if (m.thoughtSignature) {
        (mediaItem as any).thoughtSignature = m.thoughtSignature;
      }

      media.push(mediaItem);
    }
  }

  return media.length ? media : undefined;
}

function mapSessionMessage(msg: Message): UnifiedMessage {
  const isSummary = msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith('__SUMMARY__');
  const actualContent = isSummary ? msg.content.replace(/^__SUMMARY__/, '') : msg.content;
  const toolCalls = (msg.tool_calls as any) && typeof msg.tool_calls === 'object' ? (msg.tool_calls as any) : null;
  const isSystemPrompt = msg.role === 'system' && toolCalls && toolCalls.isSystemPrompt === true;

  // Extract ext data
  const ext: any = (msg as any).ext;
  
  // Extract processMessages from ext (new protocol)
  const processMessages = ext?.processMessages || (Array.isArray(ext?.processSteps)
    ? ext.processSteps.map((step: any) => ({
        type: step?.type || 'unknown',
        contentType: 'text',
        timestamp: step?.timestamp || Date.now(),
        title: step?.toolName || step?.workflowInfo?.name || step?.action || step?.type || '步骤',
        content: step?.thinking || step?.error || '',
        meta: step,
      }))
    : undefined);
  
  // Extract thoughtSignature from ext
  const thoughtSignature = ext?.thoughtSignature;
  
  // Extract mcpdetail from message or ext
  const mcpdetail = (msg as any).mcpdetail;
  
  // Debug: Log processSteps mapping for assistant messages with MCP calls
  if (msg.role === 'assistant' && (processMessages || mcpdetail)) {
    console.log(`[sessionConversation] 映射消息 ${msg.message_id}:`, {
      hasExt: !!ext,
      hasProcessMessages: !!processMessages,
      processMessagesCount: processMessages?.length,
      processMessageTypes: processMessages?.map((s: any) => ({ type: s.type, hasContent: !!s.content })),
      hasMcpdetail: !!mcpdetail,
    });
  }

  return {
    id: msg.message_id,
    role: msg.role,
    content: actualContent || '',
    createdAt: msg.created_at || new Date().toISOString(),
    media: mapSessionMedia(msg),
    thinking: msg.thinking,
    toolCalls: msg.tool_calls,
    tokenCount: (msg as any).token_count,
    // Expose processMessages at top level for UI rendering
    processMessages,
    // Expose thoughtSignature at top level
    thoughtSignature,
    // Expose mcpdetail at top level
    mcpdetail,
    // Expose ext at top level for ProcessStepsViewer (thoughtSignature status)
    ext,
    meta: {
      thinking: msg.thinking,
      tool_calls: msg.tool_calls,
      token_count: (msg as any).token_count,
      ext,
      mcpdetail,
      tool_type: (msg as any).tool_type,
      isSummary,
      isSystemPrompt,
      processMessages,
      thoughtSignature,
    },
    ...(isSummary ? ({ isSummary: true } as any) : null),
  };
}

export function createSessionConversationAdapter(
  sessionId: string,
  opts?: {
    /** 轻量级模式：只拿 role/content/created_at，适用于 Research */
    lightweight?: boolean;
  }
): ConversationAdapter {
  const lightweight = opts?.lightweight ?? false;

  return {
    key: `session:${sessionId}`,

    async listMessages(params: ListMessagesParams): Promise<ListMessagesResult> {
      const pageSize = params.pageSize ?? 20;
      
      // 使用游标分页（更高效）
      // cursor 是 message_id，表示获取此消息之前的消息
      const beforeId = params.cursor as string | null;
      
      const res = await getSessionMessagesCursor(sessionId, beforeId, pageSize, lightweight);
      const items = (res.messages || []).map(mapSessionMessage);
      
      return {
        items,
        hasMore: res.has_more,
        nextCursor: res.next_cursor,
      };
    },

    async sendMessage(payload) {
      const role = payload.role ?? 'user';
      // 约定：媒体内容必须写入 ext.media 才能被后端持久化（/api/sessions/<id>/messages 仅存 ext）
      const mediaExt = payload.media?.length
        ? {
            media: payload.media
              .map((m: any) => {
                const data = normalizeBase64ForInlineData(m.url);
                if (!data) return null;
                const mediaItem: any = {
                  type: m.type,
                  mimeType: m.mimeType,
                  // 统一存"纯 base64"，避免后续回填时污染 inlineData
                  data,
                };
                // 保存 thoughtSignature（用于 Gemini 图片）
                if ((m as any).thoughtSignature) {
                  mediaItem.thoughtSignature = (m as any).thoughtSignature;
                }
                return mediaItem;
              })
              .filter(Boolean),
          }
        : {};
      const res = await saveMessage(sessionId, {
        role,
        content: payload.content,
        ext: { ...(payload.meta?.ext || {}), ...mediaExt },
        thinking: payload.meta?.thinking,
        tool_calls: payload.meta?.tool_calls,
      } as any);

      return {
        id: res.message_id,
        role,
        content: payload.content,
        createdAt: new Date().toISOString(),
        media: payload.media,
        thinking: payload.meta?.thinking,
        toolCalls: payload.meta?.tool_calls,
        tokenCount: payload.meta?.token_count,
        meta: payload.meta,
      };
    },

    async deleteMessage(messageId: string) {
      await deleteMessage(sessionId, messageId);
    },
  };
}

