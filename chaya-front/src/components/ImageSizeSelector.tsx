/**
 * Image Size Selector Component
 * 宽高比 + 数量选择（分辨率已移除，当前模型不支持）
 */

import React from 'react';
import { Maximize2 } from 'lucide-react';

export interface ImageSizeConfig {
  width: number;
  height: number;
  aspectRatio: string;
  count: number;
}

interface ImageSizeSelectorProps {
  value: ImageSizeConfig;
  onChange: (config: ImageSizeConfig) => void;
  disabled?: boolean;
  /** 隐藏标题（由父级提供标题时使用） */
  hideTitle?: boolean;
}

const ASPECT_RATIOS: { label: string; ratio: number; w: number; h: number }[] = [
  { label: '1:1', ratio: 1, w: 56, h: 56 },
  { label: '4:3', ratio: 1.33, w: 64, h: 48 },
  { label: '3:4', ratio: 0.75, w: 48, h: 64 },
  { label: '16:9', ratio: 1.78, w: 72, h: 40 },
  { label: '9:16', ratio: 0.56, w: 40, h: 72 },
];

const DEFAULT_SIZE = 1024;

export const ImageSizeSelector: React.FC<ImageSizeSelectorProps> = ({ value, onChange, disabled, hideTitle }) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = React.useState<'compact' | 'balanced' | 'comfy'>('balanced');

  React.useEffect(() => {
    const pickDensity = () => {
      const root = rootRef.current;
      if (!root) return;

      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportWidth = window.innerWidth;
      const leftCol = root.closest('.media-create-left-col') as HTMLElement | null;
      const leftColHeight = leftCol?.clientHeight ?? 0;

      const isNarrow = viewportWidth < 900;
      const isShort = viewportHeight < 760 || (!!leftColHeight && leftColHeight < 620);
      const isRoomy = !isNarrow && (viewportHeight > 920 || leftColHeight > 760);

      const nextDensity = isShort ? 'compact' : isRoomy ? 'comfy' : 'balanced';
      setDensity((prev) => (prev === nextDensity ? prev : nextDensity));
    };

    pickDensity();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pickDensity) : null;
    const root = rootRef.current;
    const leftCol = root?.closest('.media-create-left-col') as HTMLElement | null;

    if (observer && root) observer.observe(root);
    if (observer && leftCol) observer.observe(leftCol);

    window.addEventListener('resize', pickDensity);
    window.visualViewport?.addEventListener('resize', pickDensity);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', pickDensity);
      window.visualViewport?.removeEventListener('resize', pickDensity);
    };
  }, []);

  const handleAspectRatioChange = (label: string) => {
    const aspectItem = ASPECT_RATIOS.find(a => a.label === label);
    if (!aspectItem) return;
    const newWidth = DEFAULT_SIZE;
    const newHeight = label === '1:1' ? DEFAULT_SIZE : Math.round(newWidth / aspectItem.ratio);
    onChange({ ...value, aspectRatio: label, width: newWidth, height: newHeight });
  };

  const handleCountChange = (count: number) => {
    onChange({ ...value, count });
  };

  return (
    <div ref={rootRef} className={`image-size-block image-size-selector image-size-selector--${density}`}>
      {!hideTitle && (
        <div className="flex items-center gap-2 mb-2">
          <Maximize2 className="w-5 h-5 text-[var(--color-accent)]" />
          <span className="text-sm font-semibold text-[var(--text-primary)]">图片规格设置</span>
        </div>
      )}

      <div className="image-size-selector__layout">
        <div className="image-size-selector__section min-w-0">
          <div className="image-size-selector__section-head">
            <span>画幅比例</span>
            <span className="image-size-selector__meta">当前 {value.aspectRatio}</span>
          </div>
          <div className="image-size-selector__aspect-grid">
            {ASPECT_RATIOS.map((aspect) => {
              const isSelected = value.aspectRatio === aspect.label;
              const maxEdge = Math.max(aspect.w, aspect.h);
              const targetEdge = density === 'comfy' ? 68 : density === 'compact' ? 52 : 60;
              const scale = targetEdge / maxEdge;
              const previewWidth = Math.round(aspect.w * scale);
              const previewHeight = Math.round(aspect.h * scale);
              return (
                <button
                  key={aspect.label}
                  disabled={disabled}
                  onClick={() => handleAspectRatioChange(aspect.label)}
                  className={`
                    image-size-selector__aspect-btn
                    ${isSelected ? 'is-selected' : ''}
                    ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                  `}
                  title={aspect.label}
                >
                  <div className="image-size-selector__aspect-preview-wrap">
                  <div
                    className="image-size-selector__aspect-preview"
                    style={{ width: previewWidth, height: previewHeight }}
                  />
                  </div>
                  <span className="image-size-selector__aspect-label">{aspect.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="image-size-selector__section image-size-selector__section--count min-w-0">
          <div className="image-size-selector__section-head">
            <span>数量</span>
            <span className="image-size-selector__meta">{value.count}</span>
          </div>
          <div className="image-size-selector__count-grid">
            {[1, 2, 3, 4].map((num) => (
              <button
                key={num}
                disabled={disabled}
                onClick={() => handleCountChange(num)}
                className={`
                  image-size-selector__count-btn
                  ${value.count === num ? 'is-selected' : ''}
                  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <span className="image-size-selector__count-label">{num}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
