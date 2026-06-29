/* ------------------------------------------------------------------ *
 * InspectorColumn —— CLI 右侧检视列（grid 第二列）。把原来「代码改动 / 笔记 二选一」
 * 改成「上下分屏」：代码改动在上、笔记在下。两个面板各自 portal 进下面的子槽
 * (#v2-inspector-editor / #v2-inspector-note)，本组件只负责高度分配 + 中间可拖分隔条。
 *
 * 行为：都开 → 默认等分(ratio 0.5)，拖分隔条改比例(持久化)；只开其一 → 那块充满整列。
 * 宽度仍由各面板的 data-*-right + --insp-w 机制控制（不变）。
 * ------------------------------------------------------------------ */
import { useCallback, useEffect, useRef, useState } from 'react';

const RATIO_KEY = 'chaya:inspectorRatio';
const clampR = (r: number) => Math.min(0.82, Math.max(0.18, r));

export const InspectorColumn: React.FC<{ editorOpen: boolean; noteOpen: boolean; jotOpen?: boolean; cronOpen?: boolean }> = ({ editorOpen, noteOpen, jotOpen = false, cronOpen = false }) => {
  const colRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => {
    const v = Number((typeof localStorage !== 'undefined' && localStorage.getItem(RATIO_KEY)) || '');
    return v >= 0.18 && v <= 0.82 ? v : 0.5;
  });
  useEffect(() => { try { localStorage.setItem(RATIO_KEY, String(ratio)); } catch { /* */ } }, [ratio]);

  const both = editorOpen && noteOpen;

  const onDividerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = colRef.current; if (!el) return;
    document.body.style.cursor = 'row-resize';
    document.body.classList.add('v2-insp-resizing');
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0) setRatio(clampR((ev.clientY - r.top) / r.height));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.classList.remove('v2-insp-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return (
    <div className="v2-inspector-slot" id="v2-inspector-slot" ref={colRef}>
      <div
        className="v2-inspector-pane"
        id="v2-inspector-editor"
        style={{ flexGrow: both ? ratio : 1, display: editorOpen ? undefined : 'none' }}
      />
      {both && <div className="v2-inspector-vdivider" onPointerDown={onDividerDown} aria-hidden />}
      <div
        className="v2-inspector-pane"
        id="v2-inspector-note"
        style={{ flexGrow: both ? 1 - ratio : 1, display: noteOpen ? undefined : 'none' }}
      />
      {/* 速记：独立面板，与代码改动/笔记并列（不参与上面两者的拖分；开则占自己一份）。 */}
      <div
        className="v2-inspector-pane"
        id="v2-inspector-jot"
        style={{ flexGrow: 1, display: jotOpen ? undefined : 'none' }}
      />
      {/* 定时任务：独占面板（provider 无关，类似速记），与代码改动/笔记/速记并列。 */}
      <div
        className="v2-inspector-pane"
        id="v2-inspector-cron"
        style={{ flexGrow: 1, display: cronOpen ? undefined : 'none' }}
      />
    </div>
  );
};
