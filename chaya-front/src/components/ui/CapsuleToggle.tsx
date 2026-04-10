/**
 * 胶囊双态滑动开关：轨道 + 滑动圆形高亮 + 左右语义图标。
 *
 * 尺寸标准（不可随意改）：
 *   轨道外框 50×26  border 1px  → 内框 48×24
 *   滑块 20×20  gap 2px        → 行程 24px
 *
 * 业务方必须显式传入 leftIcon / rightIcon。
 */

import * as React from 'react';
import { cn } from '@/utils/cn';

export interface CapsuleToggleProps {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const ICON_SIZE = 13;

function Icon({ node, className }: { node: React.ReactNode; className: string }) {
  if (!node) return null;
  if (React.isValidElement(node)) {
    return React.cloneElement(node as React.ReactElement<any>, {
      className,
      width: ICON_SIZE,
      height: ICON_SIZE,
      'aria-hidden': true,
    });
  }
  return <span className={className} aria-hidden>{node}</span>;
}

export const CapsuleToggle = React.forwardRef<HTMLButtonElement, CapsuleToggleProps>(
  ({ checked, onCheckedChange, disabled, className, 'aria-label': ariaLabel, leftIcon, rightIcon }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'capsule-toggle group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      style={{ width: 50, height: 26 }}
      onClick={() => !disabled && onCheckedChange(!checked)}
    >
      {/* 轨道内层微光 */}
      <span className="capsule-toggle-track pointer-events-none absolute inset-0 rounded-full" />

      {/* 左侧图标槽（固定位置） */}
      <span className="pointer-events-none absolute z-[1] flex items-center justify-center" style={{ left: 5, top: 0, bottom: 0, width: 20 }}>
        <Icon node={leftIcon} className={checked ? 'capsule-toggle-icon-muted' : 'capsule-toggle-icon-on-thumb'} />
      </span>

      {/* 右侧图标槽（固定位置） */}
      <span className="pointer-events-none absolute z-[1] flex items-center justify-center" style={{ right: 5, top: 0, bottom: 0, width: 20 }}>
        <Icon node={rightIcon} className={!checked ? 'capsule-toggle-icon-muted' : 'capsule-toggle-icon-on-thumb'} />
      </span>

      {/* 滑块（覆盖在当前激活侧上方） */}
      <span
        className="capsule-toggle-thumb pointer-events-none absolute z-[3] rounded-full transition-transform duration-300 ease-out"
        style={{ width: 20, height: 20, top: 2, left: 2 }}
        data-state={checked ? 'checked' : 'unchecked'}
      >
        <span className="flex h-full w-full items-center justify-center">
          <Icon node={checked ? rightIcon : leftIcon} className="capsule-toggle-icon-on-thumb" />
        </span>
      </span>

      {/* 用 CSS translateX 移动滑块 */}
      <style>{`
        .capsule-toggle-thumb[data-state="checked"] { transform: translateX(24px); }
        .capsule-toggle-thumb[data-state="unchecked"] { transform: translateX(0); }
      `}</style>
    </button>
  ),
);
CapsuleToggle.displayName = 'CapsuleToggle';
