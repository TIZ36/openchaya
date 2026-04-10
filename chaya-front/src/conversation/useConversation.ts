import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationAdapter, ConversationCursor, UnifiedMessage } from './types';

type CacheEntry = {
  messages: UnifiedMessage[];
  nextCursor: ConversationCursor;
  hasMore: boolean;
  updatedAt: number;
};

type UseConversationOptions = {
  pageSize?: number;
  /** 默认开启：切换会话不重复拉取 */
  enableCache?: boolean;
  /** LRU 容量（会话数量维度） */
  cacheSize?: number;
};

const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_CACHE_SIZE = 20;

const cacheStore = new Map<string, CacheEntry>();
const cacheOrder: string[] = [];

function touchKey(key: string) {
  const idx = cacheOrder.indexOf(key);
  if (idx >= 0) cacheOrder.splice(idx, 1);
  cacheOrder.unshift(key);
}

function setCache(key: string, entry: CacheEntry, maxSize: number) {
  cacheStore.set(key, entry);
  touchKey(key);
  while (cacheOrder.length > maxSize) {
    const evict = cacheOrder.pop();
    if (!evict) break;
    cacheStore.delete(evict);
  }
}

function getCache(key: string): CacheEntry | undefined {
  const entry = cacheStore.get(key);
  if (entry) touchKey(key);
  return entry;
}

function uniqById(list: UnifiedMessage[]): UnifiedMessage[] {
  const seen = new Set<string>();
  const out: UnifiedMessage[] = [];
  for (const m of list) {
    if (!m?.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function useConversation(adapter: ConversationAdapter | null, options?: UseConversationOptions) {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const enableCache = options?.enableCache ?? true;
  const cacheSize = options?.cacheSize ?? DEFAULT_CACHE_SIZE;

  const adapterKey = adapter?.key ?? null;
  const currentKeyRef = useRef<string | null>(null);

  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<ConversationCursor>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const saveToCache = useCallback(
    (key: string, next: { messages: UnifiedMessage[]; nextCursor: ConversationCursor; hasMore: boolean }) => {
      if (!enableCache) return;
      setCache(
        key,
        {
          messages: next.messages,
          nextCursor: next.nextCursor,
          hasMore: next.hasMore,
          updatedAt: Date.now(),
        },
        cacheSize
      );
    },
    [cacheSize, enableCache]
  );

  const loadInitial = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!adapter) return;
      const key = adapter.key;
      const force = opts?.force ?? false;

      if (enableCache && !force) {
        const cached = getCache(key);
        if (cached) {
          setMessages(cached.messages);
          setNextCursor(cached.nextCursor);
          setHasMore(cached.hasMore);
          setError(null);
          return;
        }
      }

      setIsLoading(true);
      setError(null);
      try {
        const res = await adapter.listMessages({ cursor: null, pageSize });
        const items = uniqById(res.items);
        setMessages(items);
        setNextCursor(res.nextCursor);
        setHasMore(res.hasMore);
        saveToCache(key, { messages: items, nextCursor: res.nextCursor, hasMore: res.hasMore });
      } catch (e: any) {
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setIsLoading(false);
      }
    },
    [adapter, enableCache, pageSize, saveToCache]
  );

  const loadMoreBefore = useCallback(async (): Promise<number> => {
    if (!adapter) return;
    const key = adapter.key;
    if (!hasMore || !nextCursor) return 0;
    setIsLoading(true);
    setError(null);
    try {
      const res = await adapter.listMessages({ cursor: nextCursor, pageSize });
      const nextItems = uniqById(res.items);
      let addedCount = 0;
      setMessages(prev => {
        const merged = uniqById([...nextItems, ...prev]);
        // 以最终去重后的长度差作为“实际 prepend 成功的数量”
        addedCount = Math.max(0, merged.length - prev.length);
        saveToCache(key, { messages: merged, nextCursor: res.nextCursor, hasMore: res.hasMore });
        return merged;
      });
      setNextCursor(res.nextCursor);
      setHasMore(res.hasMore);
      // React 的 setState(updater) 会在同一 tick 执行 updater；如遇并发模式导致 addedCount 未及时赋值，fallback 用 nextItems.length
      return addedCount || nextItems.length || 0;
    } catch (e: any) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return 0;
    } finally {
      setIsLoading(false);
    }
  }, [adapter, hasMore, nextCursor, pageSize, saveToCache]);

  const appendMessage = useCallback(
    (m: UnifiedMessage) => {
      if (!adapter) return;
      const key = adapter.key;
      setMessages(prev => {
        const merged = uniqById([...prev, m]);
        saveToCache(key, { messages: merged, nextCursor, hasMore });
        return merged;
      });
    },
    [adapter, hasMore, nextCursor, saveToCache]
  );

  const setMessagesState = useCallback(
    (nextOrUpdater: UnifiedMessage[] | ((prev: UnifiedMessage[]) => UnifiedMessage[])) => {
      if (!adapter) return;
      const key = adapter.key;
      setMessages(prev => {
        const next = typeof nextOrUpdater === 'function' ? (nextOrUpdater as any)(prev) : nextOrUpdater;
        const merged = uniqById(next);
        saveToCache(key, { messages: merged, nextCursor, hasMore });
        return merged;
      });
    },
    [adapter, hasMore, nextCursor, saveToCache]
  );

  const replaceMessage = useCallback(
    (messageId: string, patch: Partial<UnifiedMessage>) => {
      if (!adapter) return;
      const key = adapter.key;
      setMessages(prev => {
        const next = prev.map(m => (m.id === messageId ? { ...m, ...patch } : m));
        saveToCache(key, { messages: next, nextCursor, hasMore });
        return next;
      });
    },
    [adapter, hasMore, nextCursor, saveToCache]
  );

  const finalizeMessage = useCallback(
    (tempId: string, finalMessage: UnifiedMessage) => {
      if (!adapter) return;
      const key = adapter.key;
      setMessages(prev => {
        const existsFinal = prev.some(m => m.id === finalMessage.id);
        const next = uniqById(
          prev.map(m => (m.id === tempId ? finalMessage : m)).concat(existsFinal ? [] : [finalMessage])
        );
        saveToCache(key, { messages: next, nextCursor, hasMore });
        return next;
      });
    },
    [adapter, hasMore, nextCursor, saveToCache]
  );

  const reset = useCallback(() => {
    setMessages([]);
    setNextCursor(null);
    setHasMore(false);
    setError(null);
    setIsLoading(false);
    if (adapterKey) {
      cacheStore.delete(adapterKey);
      const idx = cacheOrder.indexOf(adapterKey);
      if (idx >= 0) cacheOrder.splice(idx, 1);
    }
  }, [adapterKey]);

  // adapter key 变化时：优先读缓存，再触发初始化加载
  useEffect(() => {
    if (!adapterKey) return;
    if (currentKeyRef.current === adapterKey) return;
    currentKeyRef.current = adapterKey;

    if (enableCache) {
      const cached = getCache(adapterKey);
      if (cached) {
        setMessages(cached.messages);
        setNextCursor(cached.nextCursor);
        setHasMore(cached.hasMore);
        setError(null);
        return;
      }
    }

    // 无缓存则拉取
    void loadInitial({ force: true });
  }, [adapterKey, enableCache, loadInitial]);

  const state = useMemo(
    () => ({
      messages,
      hasMoreBefore: hasMore,
      isLoading,
      error,
    }),
    [error, hasMore, isLoading, messages]
  );

  const actions = useMemo(
    () => ({
      loadInitial,
      loadMoreBefore,
      appendMessage,
      setMessages: setMessagesState,
      replaceMessage,
      finalizeMessage,
      reset,
    }),
    [appendMessage, finalizeMessage, loadInitial, loadMoreBefore, replaceMessage, reset, setMessagesState]
  );

  return { ...state, ...actions };
}

