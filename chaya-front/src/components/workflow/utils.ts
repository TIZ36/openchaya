/**
 * Utility functions for Workflow component
 */

// ==================== processSteps / processMessages 合并工具 ====================

interface HasTimestampAndType {
  timestamp?: number;
  type?: string;
  [key: string]: any;
}

/**
 * 追加模式合并：保留已有项，追加新项（按 timestamp+type 去重）
 */
export function mergeByAppend<T extends HasTimestampAndType>(existing: T[], incoming: T[]): T[] {
  const merged = [...existing];
  for (const item of incoming) {
    if (!merged.some(m => m.timestamp === item.timestamp && m.type === item.type)) {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Upsert 模式合并：已有项更新，新项追加（按 timestamp+type 匹配）
 */
export function mergeByUpsert<T extends HasTimestampAndType>(existing: T[], incoming: T[]): T[] {
  const merged = [...existing];
  for (const item of incoming) {
    const idx = merged.findIndex(m => m.timestamp === item.timestamp && m.type === item.type);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...item };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * 清理 avatar 字段：过滤 data URI 和过长字符串
 */
export function sanitizeAvatar(a?: string): string | undefined {
  if (!a) return undefined;
  if (typeof a !== 'string') return undefined;
  if (a.startsWith('data:image/')) return undefined;
  if (a.length > 1024) return undefined;
  return a;
}

type CursorMirrorCtx = {
  mirror: HTMLDivElement;
  beforeNode: Text;
  marker: HTMLSpanElement;
};

// 复用镜像节点：避免每次输入都 create/remove DOM 造成 GC 抖动与卡顿
const cursorMirrorMap = new WeakMap<HTMLTextAreaElement, CursorMirrorCtx>();

export function releaseCursorMirror(textarea?: HTMLTextAreaElement | null) {
  if (!textarea) return;
  const ctx = cursorMirrorMap.get(textarea);
  if (!ctx) return;
  if (ctx.mirror.parentNode) ctx.mirror.parentNode.removeChild(ctx.mirror);
  cursorMirrorMap.delete(textarea);
}

/**
 * Calculate the cursor position in a textarea for positioning selectors.
 * 使用 mirror + marker(span) 获取稳定的 caret rect，支持换行/滚动/字体样式。
 */
export const calculateCursorPosition = (
  textarea: HTMLTextAreaElement,
  textBeforeCursor: string
): { x: number; y: number } => {
  const textareaRect = textarea.getBoundingClientRect();
  const styles = window.getComputedStyle(textarea);

  let ctx = cursorMirrorMap.get(textarea);
  if (!ctx) {
    const mirror = document.createElement('div');
    const beforeNode = document.createTextNode('');
    const marker = document.createElement('span');
    // zero-width space：让 marker 在行尾/空内容也有稳定 rect
    marker.textContent = '\u200b';
    mirror.appendChild(beforeNode);
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    ctx = { mirror, beforeNode, marker };
    cursorMirrorMap.set(textarea, ctx);
  }

  const { mirror, beforeNode, marker } = ctx;

  // 固定定位到 textarea 的 viewport rect
  mirror.style.position = 'fixed';
  mirror.style.top = `${textareaRect.top}px`;
  mirror.style.left = `${textareaRect.left}px`;
  mirror.style.width = `${textareaRect.width}px`;
  mirror.style.height = `${textareaRect.height}px`;
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.overflow = 'auto';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordWrap = 'break-word';
  mirror.style.overflowWrap = 'break-word';

  // 复制关键样式以保证换行测量一致
  mirror.style.fontFamily = styles.fontFamily;
  mirror.style.fontSize = styles.fontSize;
  mirror.style.fontWeight = styles.fontWeight;
  mirror.style.fontStyle = styles.fontStyle;
  mirror.style.letterSpacing = styles.letterSpacing;
  mirror.style.lineHeight = styles.lineHeight;
  mirror.style.textTransform = styles.textTransform;
  mirror.style.textAlign = styles.textAlign;
  mirror.style.padding = styles.padding;
  mirror.style.border = styles.border;
  mirror.style.boxSizing = styles.boxSizing;

  beforeNode.data = textBeforeCursor;
  // 同步内部滚动（多行 textarea）
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;

  const rect = marker.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
};
