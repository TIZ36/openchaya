import { useCallback, useEffect, useRef, useState } from 'react';

export type HybridHistoryLoadSource = 'manual' | 'auto';

export type UseHybridHistoryLoadOptions = {
  enabled: boolean;
  isLoading: boolean;
  loadMore: () => Promise<number>;
  onPrepend?: (added: number) => void;
  nearTopPx?: number;
  wheelTriggerPx?: number;
  stayMs?: number;
  cooldownMs?: number;
};

export function useHybridHistoryLoad(options: UseHybridHistoryLoadOptions) {
  const {
    enabled,
    isLoading,
    loadMore,
    onPrepend,
    nearTopPx = 150,
    wheelTriggerPx = 80,
    stayMs = 800,
    cooldownMs = 900,
  } = options;

  const [isNearTop, setIsNearTop] = useState(false);
  const scrollTopRef = useRef(0);
  const cooldownUntilRef = useRef(0);
  const autoFiredRef = useRef(false);
  const inflightRef = useRef(false);
  const stayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetNearTopCycle = useCallback(() => {
    autoFiredRef.current = false;
    if (stayTimerRef.current) {
      clearTimeout(stayTimerRef.current);
      stayTimerRef.current = null;
    }
  }, []);

  const trigger = useCallback(
    async (source: HybridHistoryLoadSource) => {
      if (!enabled) return;
      if (isLoading) return;
      if (inflightRef.current) return;

      const now = Date.now();
      if (now < cooldownUntilRef.current) return;
      if (source === 'auto' && autoFiredRef.current) return;

      // 触发一次后，在离开顶部前不再自动触发
      autoFiredRef.current = true;
      if (stayTimerRef.current) {
        clearTimeout(stayTimerRef.current);
        stayTimerRef.current = null;
      }

      inflightRef.current = true;
      try {
        const added = await loadMore();
        if (added > 0) onPrepend?.(added);
      } finally {
        inflightRef.current = false;
        cooldownUntilRef.current = Date.now() + cooldownMs;
      }
    },
    [cooldownMs, enabled, isLoading, loadMore, onPrepend]
  );

  const onScrollTopChange = useCallback(
    (scrollTop: number) => {
      scrollTopRef.current = scrollTop;
      const nextNearTop = scrollTop < nearTopPx;
      setIsNearTop(nextNearTop);
      if (!nextNearTop) resetNearTopCycle();
    },
    [nearTopPx, resetNearTopCycle]
  );

  const onWheel = useCallback(
    (e: { deltaY: number }) => {
      // 继续上拉（滚轮向上）触发一次性自动加载
      if (e.deltaY < 0 && isNearTop && scrollTopRef.current < wheelTriggerPx) {
        void trigger('auto');
      }
    },
    [isNearTop, trigger, wheelTriggerPx]
  );

  useEffect(() => {
    if (!enabled) return;
    if (!isNearTop) return;
    if (autoFiredRef.current) return;

    if (stayTimerRef.current) clearTimeout(stayTimerRef.current);
    stayTimerRef.current = setTimeout(() => {
      if (!enabled) return;
      if (!isNearTop) return;
      if (scrollTopRef.current > 20) return;
      void trigger('auto');
    }, stayMs);

    return () => {
      if (stayTimerRef.current) {
        clearTimeout(stayTimerRef.current);
        stayTimerRef.current = null;
      }
    };
  }, [enabled, isNearTop, stayMs, trigger]);

  const reset = useCallback(() => {
    cooldownUntilRef.current = 0;
    scrollTopRef.current = 0;
    setIsNearTop(false);
    resetNearTopCycle();
  }, [resetNearTopCycle]);

  return {
    isNearTop,
    onScrollTopChange,
    onWheel,
    triggerManual: () => trigger('manual'),
    triggerAuto: () => trigger('auto'),
    reset,
  };
}


