/**
 * 全局 topbar tab 条 —— 把 Local Agent / 普通对话 / Agent 对话 / 画廊 / 知识库
 * 并到一行。Local 子段委托给现有 <LocalAgentTabs inline /> 以保留分组与拖拽；
 * 其它 tab 直接渲染 .v2-la-tab。
 *
 * 激活与状态同步由 ClientShell 负责（见 useTopTabs 注释）。
 */
import React, { useEffect, useRef } from 'react';
import { LocalAgentTabs } from './LocalAgentView';
import type { LocalAgentState } from './useLocalAgent';
import type { TopTab } from './useTopTabs';
import { IconChat, IconGallery, IconKB, IconAgentPrimary } from './icons';

interface Props {
  la: LocalAgentState;
  tabs: TopTab[];
  activeId: string | null;
  onActivate: (tab: TopTab) => void;
  onClose: (tab: TopTab) => void;
}

export const TopTabs: React.FC<Props> = React.memo(({ la, tabs, activeId, onActivate, onClose }) => {
  const nonLocal = tabs.filter((t) => t.kind !== 'local');
  const hasLocal = la.tabs.length > 0;
  if (!hasLocal && nonLocal.length === 0) {
    return <span className="v2-la-tabs-empty">无打开会话</span>;
  }
  // 点击 local tab 时同时通知壳层切换 activeNav 到 'local'（不然主区还停在 chat/gallery 上）。
  const onLocalActivate = (cwd: string) => {
    const id = `local:${cwd}`;
    const tab = tabs.find((t) => t.id === id);
    if (tab) onActivate(tab);
  };
  // 全局当前激活的 local cwd —— 仅当 activeId 是 local: 前缀时才有意义。
  // chat/gallery/kb 处于激活时，这里为 null，确保 local tab 上的高亮 hairline 消失。
  const activeLocalCwd = activeId && activeId.startsWith('local:') ? activeId.slice('local:'.length) : null;
  // 鼠标滚轮纵向 → 横向 tab 滚动。用非 passive 原生监听才能 preventDefault，
  // 否则在 Electron / macOS 上仍会被祖先 vertical scroll 抢走滚动语义。
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 已是横向滚动（trackpad / shift+wheel）就交给浏览器原生行为。
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div className="v2-la-tabs v2-toptabs" role="tablist" ref={scrollerRef}>
      {hasLocal && <LocalAgentTabs la={la} inline onTabActivate={onLocalActivate} activeCwd={activeLocalCwd} />}
      {/* 在 local 与 chat/系统 tabs 之间留一道极细分隔，避免两段视觉粘在一起。 */}
      {hasLocal && nonLocal.length > 0 && <span className="v2-toptabs-sep" aria-hidden />}
      {nonLocal.map((t) => (
        <ChatChip
          key={t.id}
          t={t}
          active={t.id === activeId}
          onActivate={() => onActivate(t)}
          onClose={() => onClose(t)}
        />
      ))}
    </div>
  );
});
TopTabs.displayName = 'TopTabs';

/** 单条非 local tab 的渲染。chat / gallery / kb 共用同一壳，只换图标。 */
const ChatChip: React.FC<{ t: TopTab; active: boolean; onActivate: () => void; onClose: () => void }> = ({ t, active, onActivate, onClose }) => {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`v2-la-tab${active ? ' active' : ''}${t.attn ? ' attn' : ''}`}
      onClick={onActivate}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}   // 中键关闭
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
        if (e.key === 'Delete' || (e.key === 'w' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); onClose(); }
      }}
      title={t.label}
    >
      <span className="ico" aria-hidden><IconFor t={t} /></span>
      <span className="sess">{t.label}</span>
      {t.unread && !active && <span className="unread" aria-label="未读" />}
      {t.attn && <span className="attn-mark" aria-label="需要批准">!</span>}
      <button
        className="x"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="关闭 (⌘W)"
        aria-label="关闭"
        tabIndex={-1}
      >×</button>
    </div>
  );
};

/** 类型图标：用 SVG 而非 unicode glyph，保证基线/字号在所有主题下都一致。 */
const IconFor: React.FC<{ t: TopTab }> = ({ t }) => {
  if (t.kind === 'gallery') return <IconGallery />;
  if (t.kind === 'kb') return <IconKB />;
  if (t.kind === 'chat') {
    if (t.isPrimary || t.sessionType === 'agent') return <IconAgentPrimary />;
    return <IconChat />;
  }
  return <IconChat />;
};
