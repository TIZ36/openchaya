import type { ConversationAdapter } from '../types';
import { createSessionConversationAdapter } from './sessionConversation';

export function createResearchConversationAdapter(researchSessionId: string): ConversationAdapter {
  // Research 消息当前落在 sessions/messages，使用轻量级模式加快加载
  return createSessionConversationAdapter(researchSessionId, { lightweight: true });
}

