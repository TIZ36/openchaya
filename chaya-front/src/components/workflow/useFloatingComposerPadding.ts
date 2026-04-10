import { useEffect, useRef, useState } from 'react';

type Options = {
  /** 最小 padding，避免浮岛太矮时消息被遮挡 */
  minPadding?: number;
  /** 额外补偿（浮岛阴影/安全距离） */
  extraPadding?: number;
  /** 初始值（首帧未测量前） */
  initialPadding?: number;
};

export function useFloatingComposerPadding(options?: Options) {
  const minPadding = options?.minPadding ?? 120;
  const extraPadding = options?.extraPadding ?? 20;
  const initialPadding = options?.initialPadding ?? 140;

  const ref = useRef<HTMLDivElement>(null);
  const [padding, setPadding] = useState(initialPadding);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const h = el.getBoundingClientRect().height || 0;
      setPadding(Math.max(minPadding, Math.ceil(h + extraPadding)));
    };

    update();

    const RO = (window as any).ResizeObserver as any;
    if (!RO) return;
    const ro = new RO(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [extraPadding, minPadding]);

  return { ref, padding };
}


