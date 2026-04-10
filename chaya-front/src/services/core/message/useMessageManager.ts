/**
 * 消息管理器 React Hook
 * 提供消息的高效获取和管理功能
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageManager, MessageManagerOptions, MessageState, MediaState } from './MessageManager';
import { Message } from '../../api';

export interface UseMessageManagerResult {
  /** 消息列表 */
  messages: Message[];
  /** 最新消息 ID */
  latestMessageId: string | null;
  /** 是否有更多历史消息 */
  hasMore: boolean;
  /** 消息总数 */
  totalCount: number;
  /** 是否正在初始加载 */
  isLoading: boolean;
  /** 是否正在加载更多 */
  isLoadingMore: boolean;
  /** 错误信息 */
  error: string | null;
  
  /** 加载更多历史消息 */
  loadMore: () => Promise<void>;
  /** 检查是否有新消息 */
  checkForNewMessages: () => Promise<boolean>;
  /** 添加本地消息（乐观更新） */
  addLocalMessage: (message: Message) => void;
  /** 更新本地消息（乐观更新） */
  updateLocalMessage: (messageId: string, updates: Partial<Message>) => void;
  /** 删除本地消息（乐观更新） */
  deleteLocalMessage: (messageId: string) => void;
  /** 回退到指定消息 */
  rollbackToMessage: (messageId: string) => Promise<boolean>;
  /** 刷新缓存 */
  refreshCache: () => Promise<void>;
  /** 清空本地缓存 */
  clearCache: () => void;
  /** 根据 ID 获取消息 */
  getMessageById: (messageId: string) => Message | undefined;
  /** 重新加载消息 */
  reload: () => Promise<void>;
}

export interface UseMediaMessagesResult {
  /** 媒体消息列表 */
  mediaMessages: Array<{ message_id: string; timestamp: number }>;
  /** 媒体总数 */
  totalCount: number;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 加载媒体消息 */
  loadMediaMessages: (limit?: number, offset?: number) => Promise<void>;
}

/**
 * 消息管理 Hook
 * 
 * @param sessionId 会话 ID
 * @param options 配置选项
 * @returns 消息状态和操作方法
 * 
 * @example
 * ```tsx
 * const {
 *   messages,
 *   isLoading,
 *   hasMore,
 *   loadMore,
 *   addLocalMessage,
 * } = useMessageManager(sessionId);
 * 
 * // 向上滚动加载更多
 * const handleScroll = (e) => {
 *   if (e.target.scrollTop === 0 && hasMore) {
 *     loadMore();
 *   }
 * };
 * 
 * // 发送消息时乐观更新
 * const handleSend = (content) => {
 *   const tempMessage = { ... };
 *   addLocalMessage(tempMessage);
 *   await sendToServer(content);
 * };
 * ```
 */
export function useMessageManager(
  sessionId: string | null,
  options?: MessageManagerOptions
): UseMessageManagerResult {
  const [state, setState] = useState<MessageState>({
    messages: [],
    latestMessageId: null,
    hasMore: true,
    totalCount: 0,
    isLoading: false,
    isLoadingMore: false,
    error: null,
  });
  
  const managerRef = useRef<MessageManager | null>(null);
  const sessionIdRef = useRef(sessionId);
  
  // 初始化和会话切换时的处理
  useEffect(() => {
    // 清理旧的管理器
    if (managerRef.current) {
      managerRef.current.destroy();
      managerRef.current = null;
    }
    
    // 重置状态
    setState({
      messages: [],
      latestMessageId: null,
      hasMore: true,
      totalCount: 0,
      isLoading: false,
      isLoadingMore: false,
      error: null,
    });
    
    if (!sessionId) return;
    
    sessionIdRef.current = sessionId;
    
    // 创建新的管理器
    const manager = new MessageManager(sessionId, options);
    managerRef.current = manager;
    
    // 设置状态回调
    manager.setOnStateChange((newState) => {
      // 只有当 sessionId 仍然匹配时才更新状态
      if (sessionIdRef.current === sessionId) {
        setState(newState);
      }
    });
    
    // 初始加载
    manager.loadInitial();
    
    return () => {
      manager.destroy();
    };
  }, [sessionId]); // options 不应该作为依赖，避免重复创建
  
  // 加载更多
  const loadMore = useCallback(async () => {
    if (managerRef.current) {
      await managerRef.current.loadMore();
    }
  }, []);
  
  // 检查新消息
  const checkForNewMessages = useCallback(async () => {
    if (managerRef.current) {
      return await managerRef.current.checkForNewMessages();
    }
    return false;
  }, []);
  
  // 添加本地消息
  const addLocalMessage = useCallback((message: Message) => {
    if (managerRef.current) {
      managerRef.current.addLocalMessage(message);
    }
  }, []);
  
  // 更新本地消息
  const updateLocalMessage = useCallback((messageId: string, updates: Partial<Message>) => {
    if (managerRef.current) {
      managerRef.current.updateLocalMessage(messageId, updates);
    }
  }, []);
  
  // 删除本地消息
  const deleteLocalMessage = useCallback((messageId: string) => {
    if (managerRef.current) {
      managerRef.current.deleteLocalMessage(messageId);
    }
  }, []);
  
  // 回退到指定消息
  const rollbackToMessage = useCallback(async (messageId: string) => {
    if (managerRef.current) {
      return await managerRef.current.rollbackToMessage(messageId);
    }
    return false;
  }, []);
  
  // 刷新缓存
  const refreshCache = useCallback(async () => {
    if (managerRef.current) {
      await managerRef.current.refreshCache();
    }
  }, []);
  
  // 清空本地缓存
  const clearCache = useCallback(() => {
    if (managerRef.current) {
      managerRef.current.clearCache();
    }
  }, []);
  
  // 获取消息
  const getMessageById = useCallback((messageId: string) => {
    if (managerRef.current) {
      return managerRef.current.getMessageById(messageId);
    }
    return undefined;
  }, []);
  
  // 重新加载
  const reload = useCallback(async () => {
    if (managerRef.current) {
      managerRef.current.clearCache();
      await managerRef.current.loadInitial();
    }
  }, []);
  
  return {
    ...state,
    loadMore,
    checkForNewMessages,
    addLocalMessage,
    updateLocalMessage,
    deleteLocalMessage,
    rollbackToMessage,
    refreshCache,
    clearCache,
    getMessageById,
    reload,
  };
}

/**
 * 媒体消息 Hook
 * 用于媒体浏览器
 */
export function useMediaMessages(
  sessionId: string | null,
  options?: MessageManagerOptions
): UseMediaMessagesResult {
  const [state, setState] = useState<MediaState>({
    mediaMessages: [],
    totalCount: 0,
    isLoading: false,
  });
  
  const managerRef = useRef<MessageManager | null>(null);
  
  useEffect(() => {
    if (managerRef.current) {
      managerRef.current.destroy();
      managerRef.current = null;
    }
    
    setState({
      mediaMessages: [],
      totalCount: 0,
      isLoading: false,
    });
    
    if (!sessionId) return;
    
    const manager = new MessageManager(sessionId, options);
    managerRef.current = manager;
    
    manager.setOnMediaStateChange((newState) => {
      setState(newState);
    });
    
    return () => {
      manager.destroy();
    };
  }, [sessionId]);
  
  const loadMediaMessages = useCallback(async (limit = 50, offset = 0) => {
    if (managerRef.current) {
      await managerRef.current.loadMediaMessages(limit, offset);
    }
  }, []);
  
  return {
    ...state,
    loadMediaMessages,
  };
}

export default useMessageManager;

