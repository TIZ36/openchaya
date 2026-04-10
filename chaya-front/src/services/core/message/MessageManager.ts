/**
 * 消息管理器
 * 高效管理消息获取、缓存和同步
 * 
 * 设计原则：
 * 1. 按需加载：默认只加载最新 50 条消息
 * 2. 增量同步：通过 latestMessageId 检测新消息
 * 3. 分页加载：支持向上滚动加载更多历史消息
 * 4. 本地缓存：减少重复请求
 */

import { messageApi, Message, PaginatedMessagesResponse, MediaMessageItem } from '../../api';

export interface MessageManagerOptions {
  /** 每页消息数量，默认 50 */
  pageSize?: number;
  /** 是否启用本地缓存，默认 true */
  enableLocalCache?: boolean;
  /** 本地缓存过期时间（毫秒），默认 5 分钟 */
  localCacheTTL?: number;
}

export interface MessageState {
  /** 消息列表 */
  messages: Message[];
  /** 最新消息 ID */
  latestMessageId: string | null;
  /** 是否有更多历史消息 */
  hasMore: boolean;
  /** 消息总数 */
  totalCount: number;
  /** 是否正在加载 */
  isLoading: boolean;
  /** 是否正在加载更多 */
  isLoadingMore: boolean;
  /** 错误信息 */
  error: string | null;
}

export interface MediaState {
  /** 媒体消息列表 */
  mediaMessages: MediaMessageItem[];
  /** 媒体总数 */
  totalCount: number;
  /** 是否正在加载 */
  isLoading: boolean;
}

interface CacheEntry {
  messages: Message[];
  latestMessageId: string | null;
  hasMore: boolean;
  totalCount: number;
  timestamp: number;
}

/**
 * 消息管理器类
 */
export class MessageManager {
  private sessionId: string;
  private options: Required<MessageManagerOptions>;
  
  // 本地缓存
  private static cache = new Map<string, CacheEntry>();
  
  // 状态
  private state: MessageState = {
    messages: [],
    latestMessageId: null,
    hasMore: true,
    totalCount: 0,
    isLoading: false,
    isLoadingMore: false,
    error: null,
  };
  
  private mediaState: MediaState = {
    mediaMessages: [],
    totalCount: 0,
    isLoading: false,
  };
  
  // 状态变更回调
  private onStateChange?: (state: MessageState) => void;
  private onMediaStateChange?: (state: MediaState) => void;
  
  constructor(sessionId: string, options: MessageManagerOptions = {}) {
    this.sessionId = sessionId;
    this.options = {
      pageSize: options.pageSize ?? 50,
      enableLocalCache: options.enableLocalCache ?? true,
      localCacheTTL: options.localCacheTTL ?? 5 * 60 * 1000, // 5 分钟
    };
  }
  
  /**
   * 设置状态变更回调
   */
  setOnStateChange(callback: (state: MessageState) => void): void {
    this.onStateChange = callback;
  }
  
  /**
   * 设置媒体状态变更回调
   */
  setOnMediaStateChange(callback: (state: MediaState) => void): void {
    this.onMediaStateChange = callback;
  }
  
  /**
   * 获取当前状态
   */
  getState(): MessageState {
    return { ...this.state };
  }
  
  /**
   * 获取媒体状态
   */
  getMediaState(): MediaState {
    return { ...this.mediaState };
  }
  
  /**
   * 更新状态并触发回调
   */
  private updateState(updates: Partial<MessageState>): void {
    this.state = { ...this.state, ...updates };
    this.onStateChange?.(this.state);
  }
  
  /**
   * 更新媒体状态并触发回调
   */
  private updateMediaState(updates: Partial<MediaState>): void {
    this.mediaState = { ...this.mediaState, ...updates };
    this.onMediaStateChange?.(this.mediaState);
  }
  
  /**
   * 检查本地缓存是否有效
   */
  private getCachedData(): CacheEntry | null {
    if (!this.options.enableLocalCache) return null;
    
    const entry = MessageManager.cache.get(this.sessionId);
    if (!entry) return null;
    
    const now = Date.now();
    if (now - entry.timestamp > this.options.localCacheTTL) {
      MessageManager.cache.delete(this.sessionId);
      return null;
    }
    
    return entry;
  }
  
  /**
   * 保存到本地缓存
   */
  private saveToCache(data: Omit<CacheEntry, 'timestamp'>): void {
    if (!this.options.enableLocalCache) return;
    
    MessageManager.cache.set(this.sessionId, {
      ...data,
      timestamp: Date.now(),
    });
  }
  
  /**
   * 清空本地缓存
   */
  clearCache(): void {
    MessageManager.cache.delete(this.sessionId);
  }
  
  /**
   * 清空所有缓存
   */
  static clearAllCache(): void {
    MessageManager.cache.clear();
  }
  
  /**
   * 初始加载消息
   * 优先从缓存加载，然后异步检查更新
   */
  async loadInitial(): Promise<void> {
    // 检查本地缓存
    const cached = this.getCachedData();
    if (cached) {
      this.updateState({
        messages: cached.messages,
        latestMessageId: cached.latestMessageId,
        hasMore: cached.hasMore,
        totalCount: cached.totalCount,
        isLoading: false,
        error: null,
      });
      
      // 异步检查是否有新消息
      this.checkForNewMessages();
      return;
    }
    
    // 从服务器加载
    this.updateState({ isLoading: true, error: null });
    
    try {
      const response = await messageApi.getMessagesPaginated(this.sessionId, {
        limit: this.options.pageSize,
        use_cache: true,
      });
      
      this.updateState({
        messages: response.messages,
        latestMessageId: response.latest_message_id,
        hasMore: response.has_more,
        totalCount: response.total_count,
        isLoading: false,
      });
      
      // 保存到本地缓存
      this.saveToCache({
        messages: response.messages,
        latestMessageId: response.latest_message_id,
        hasMore: response.has_more,
        totalCount: response.total_count,
      });
    } catch (error) {
      this.updateState({
        isLoading: false,
        error: error instanceof Error ? error.message : '加载消息失败',
      });
    }
  }
  
  /**
   * 检查是否有新消息
   */
  async checkForNewMessages(): Promise<boolean> {
    try {
      const { latest_message_id } = await messageApi.getLatestMessageId(this.sessionId);
      
      if (latest_message_id && latest_message_id !== this.state.latestMessageId) {
        // 有新消息，加载增量
        await this.loadNewMessages(latest_message_id);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('[MessageManager] Error checking for new messages:', error);
      return false;
    }
  }
  
  /**
   * 加载新消息（增量同步）
   */
  private async loadNewMessages(newLatestId: string): Promise<void> {
    try {
      const response = await messageApi.getMessagesPaginated(this.sessionId, {
        after: this.state.latestMessageId || undefined,
        limit: 100, // 最多加载 100 条新消息
        use_cache: false, // 强制从数据库获取
      });
      
      // 合并新消息到列表末尾
      const newMessages = [...this.state.messages, ...response.messages];
      
      this.updateState({
        messages: newMessages,
        latestMessageId: newLatestId,
        totalCount: response.total_count,
      });
      
      // 更新缓存
      this.saveToCache({
        messages: newMessages,
        latestMessageId: newLatestId,
        hasMore: this.state.hasMore,
        totalCount: response.total_count,
      });
    } catch (error) {
      console.error('[MessageManager] Error loading new messages:', error);
    }
  }
  
  /**
   * 加载更多历史消息（向上滚动）
   */
  async loadMore(): Promise<void> {
    if (this.state.isLoadingMore || !this.state.hasMore) return;
    
    this.updateState({ isLoadingMore: true });
    
    try {
      const oldestMessage = this.state.messages[0];
      const response = await messageApi.getMessagesPaginated(this.sessionId, {
        before: oldestMessage?.message_id,
        limit: this.options.pageSize,
        use_cache: true,
      });
      
      // 合并旧消息到列表开头
      const allMessages = [...response.messages, ...this.state.messages];
      
      this.updateState({
        messages: allMessages,
        hasMore: response.has_more,
        isLoadingMore: false,
      });
      
      // 更新缓存
      this.saveToCache({
        messages: allMessages,
        latestMessageId: this.state.latestMessageId,
        hasMore: response.has_more,
        totalCount: this.state.totalCount,
      });
    } catch (error) {
      this.updateState({
        isLoadingMore: false,
        error: error instanceof Error ? error.message : '加载更多消息失败',
      });
    }
  }
  
  /**
   * 添加本地消息（乐观更新）
   * 用于发送消息时立即显示
   */
  addLocalMessage(message: Message): void {
    const newMessages = [...this.state.messages, message];
    this.updateState({
      messages: newMessages,
      latestMessageId: message.message_id,
      totalCount: this.state.totalCount + 1,
    });
    
    // 更新缓存
    this.saveToCache({
      messages: newMessages,
      latestMessageId: message.message_id,
      hasMore: this.state.hasMore,
      totalCount: this.state.totalCount,
    });
  }
  
  /**
   * 更新本地消息（乐观更新）
   */
  updateLocalMessage(messageId: string, updates: Partial<Message>): void {
    const newMessages = this.state.messages.map(msg =>
      msg.message_id === messageId ? { ...msg, ...updates } : msg
    );
    this.updateState({ messages: newMessages });
    
    // 更新缓存
    this.saveToCache({
      messages: newMessages,
      latestMessageId: this.state.latestMessageId,
      hasMore: this.state.hasMore,
      totalCount: this.state.totalCount,
    });
  }
  
  /**
   * 删除本地消息（乐观更新）
   */
  deleteLocalMessage(messageId: string): void {
    const newMessages = this.state.messages.filter(msg => msg.message_id !== messageId);
    this.updateState({
      messages: newMessages,
      totalCount: Math.max(0, this.state.totalCount - 1),
    });
    
    // 更新缓存
    this.saveToCache({
      messages: newMessages,
      latestMessageId: this.state.latestMessageId,
      hasMore: this.state.hasMore,
      totalCount: Math.max(0, this.state.totalCount - 1),
    });
  }
  
  /**
   * 回退到指定消息
   */
  async rollbackToMessage(messageId: string): Promise<boolean> {
    try {
      const result = await messageApi.rollbackToMessage(this.sessionId, messageId);
      
      if (result.success) {
        // 清空缓存并重新加载
        this.clearCache();
        await this.loadInitial();
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('[MessageManager] Error rolling back messages:', error);
      return false;
    }
  }
  
  /**
   * 刷新缓存（在消息编辑后调用）
   */
  async refreshCache(): Promise<void> {
    try {
      await messageApi.refreshCache(this.sessionId);
      this.clearCache();
      await this.loadInitial();
    } catch (error) {
      console.error('[MessageManager] Error refreshing cache:', error);
    }
  }
  
  /**
   * 加载媒体消息列表
   */
  async loadMediaMessages(limit = 50, offset = 0): Promise<void> {
    this.updateMediaState({ isLoading: true });
    
    try {
      const response = await messageApi.getMediaMessages(this.sessionId, { limit, offset });
      
      this.updateMediaState({
        mediaMessages: offset === 0 
          ? response.media_messages 
          : [...this.mediaState.mediaMessages, ...response.media_messages],
        totalCount: response.total_count,
        isLoading: false,
      });
    } catch (error) {
      console.error('[MessageManager] Error loading media messages:', error);
      this.updateMediaState({ isLoading: false });
    }
  }
  
  /**
   * 根据媒体消息 ID 获取消息详情
   */
  getMessageById(messageId: string): Message | undefined {
    return this.state.messages.find(msg => msg.message_id === messageId);
  }
  
  /**
   * 销毁管理器
   */
  destroy(): void {
    this.onStateChange = undefined;
    this.onMediaStateChange = undefined;
  }
}

/**
 * 创建消息管理器的 React Hook 使用示例
 */
export function createMessageManager(
  sessionId: string,
  options?: MessageManagerOptions
): MessageManager {
  return new MessageManager(sessionId, options);
}

export default MessageManager;

