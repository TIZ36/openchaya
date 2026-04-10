/**
 * Workflow 会话管理 Hook
 * 管理会话切换、会话元数据等
 */

import { useState, useMemo, useCallback } from 'react';
import { createSessionConversationAdapter } from '../../../conversation/adapters/sessionConversation';
import { useConversation } from '../../../conversation/useConversation';
import type { Session } from '../../../services/chat';
import type { Message } from '../types';

export interface UseWorkflowSessionProps {
  externalSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
}

export interface UseWorkflowSessionReturn {
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  hasMoreBefore: boolean;
  loadMoreBefore: () => Promise<void>;
  isLoading: boolean;
  loadInitial: () => Promise<void>;
  sessions: Session[];
  setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
  currentSessionMeta: Session | null;
  setCurrentSessionMeta: (session: Session | null) => void;
  currentSessionType: string;
  filterVisibleSessions: (list: Session[]) => Session[];
}

export function useWorkflowSession({
  externalSessionId,
  onSelectSession,
}: UseWorkflowSessionProps): UseWorkflowSessionReturn {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    externalSessionId || null
  );

  const sessionAdapter = useMemo(
    () => (currentSessionId ? createSessionConversationAdapter(currentSessionId) : null),
    [currentSessionId]
  );

  const {
    messages: persistedMessages,
    setMessages: setPersistedMessages,
    hasMoreBefore: hasMorePersistedMessages,
    loadMoreBefore: loadMorePersistedMessages,
    isLoading: isLoadingPersistedMessages,
    loadInitial: loadPersistedInitial,
  } = useConversation(sessionAdapter, { pageSize: 10 });

  // 统一通过 messages/setMessages 操作当前会话
  const messages: Message[] = persistedMessages as unknown as Message[];
  const setMessages: React.Dispatch<React.SetStateAction<Message[]>> = setPersistedMessages as unknown as React.Dispatch<React.SetStateAction<Message[]>>;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionMeta, setCurrentSessionMeta] = useState<Session | null>(null);

  const filterVisibleSessions = useCallback((list: Session[]) => {
    return (list || []).filter(s => s.session_type !== 'memory' && s.session_type !== 'research');
  }, []);

  // 当前会话类型 (派生状态)
  const currentSessionType = useMemo(() => {
    const session = sessions.find(s => s.session_id === currentSessionId) || currentSessionMeta;
    const type = session?.session_type;
    if (type === 'memory' || type === 'research') return 'temporary';
    return type || 'agent'; // 默认为 agent 类型
  }, [currentSessionId, sessions, currentSessionMeta]);

  return {
    currentSessionId,
    setCurrentSessionId,
    messages,
    setMessages,
    hasMoreBefore: hasMorePersistedMessages,
    loadMoreBefore: loadMorePersistedMessages,
    isLoading: isLoadingPersistedMessages,
    loadInitial: loadPersistedInitial,
    sessions,
    setSessions,
    currentSessionMeta,
    setCurrentSessionMeta,
    currentSessionType,
    filterVisibleSessions,
  };
}
