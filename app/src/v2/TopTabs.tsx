/**
 * 全局 topbar tab 条 —— 把 Local Agent / 普通对话 / Agent 对话 / 画廊 / 知识库
 * 并到一行。Local 子段委托给现有 <LocalAgentTabs inline /> 以保留分组与拖拽；
 * 其它 tab 直接渲染 .v2-la-tab。
 *
 * 激活与状态同步由 ClientShell 负责（见 useTopTabs 注释）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LocalAgentTabs } from './LocalAgentView';
import type { LocalAgentState } from './useLocalAgent';
import type { TopTab } from './useTopTabs';
import { IconChat, IconGallery, IconKB, IconAgentPrimary, IconTerminal } from './icons';
import { useI18n } from '../i18n';

interface Props {
  la: LocalAgentState;
  tabs: TopTab[];
  /** 当前大功能：tab 栏只显示该功能的 tab（chat/local/kb/gallery），不跨功能混排。 */
  activeNav: 'chat' | 'local' | 'kb' | 'gallery' | 'fbot';
  activeId: string | null;
  onActivate: (tab: TopTab) => void;
  onClose: (tab: TopTab) => void;
  onTogglePin: (tab: TopTab) => void;
  /** 已固定到侧栏的 CLI cwd —— 从内联 CLI tab 条隐藏（改在左栏常驻）。 */
  pinnedLocalCwds?: Set<string>;
  /** 右键菜单里「固定」CLI tab。 */
  onLocalTogglePin?: (cwd: string) => void;
}

interface MenuState { x: number; y: number; tab: TopTab }

export const TopTabs: React.FC<Props> = React.memo(({ la, tabs, activeNav, activeId, onActivate, onClose, onTogglePin, pinnedLocalCwds, onLocalTogglePin }) => {
  const { t: tr } = useI18n();
  // tab 同质化：切到某大功能后，顶栏只显示该功能的 tab（不跨功能混排）。
  //   chat→chat chip · local→内联 CLI tab · kb→kb chip · gallery→gallery chip · fbot→无 tab。
  const nonLocal = tabs.filter((t) => t.kind !== 'local' && t.kind === activeNav);
  // Pinned tabs live in the left rail (see ClientShell .v2-rail-pins). Show the
  // ACTIVE pinned one here too — as a dimmed/gray tab — so an opened pin still
  // gets a tab on the right; it drops back out of the bar when you switch away.
  const visible = nonLocal.filter((t) => !t.pinned || t.id === activeId);
  // 仅 code(local) 视图渲染内联 CLI tab 段；其余功能不显示 CLI tab。
  const hasLocal = activeNav === 'local' && la.tabs.some((t) => !pinnedLocalCwds?.has(t.cwd));
  const [menu, setMenu] = useState<MenuState | null>(null);
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
  const openMenu = (e: React.MouseEvent, t: TopTab) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, tab: t }); };
  // 空 tab 条的早退必须在所有 hooks 之后 —— 否则 tab 条从「空 → 有」时 hook 数量变化，
  // 触发 React #310「Rendered more hooks than during the previous render」（白屏崩溃）。
  if (!hasLocal && nonLocal.length === 0) {
    return <span className="v2-la-tabs-empty">{tr('tabs.empty')}</span>;
  }
  return (
    <div className="v2-la-tabs v2-toptabs" role="tablist" ref={scrollerRef}>
      {hasLocal && <LocalAgentTabs la={la} inline onTabActivate={onLocalActivate} activeCwd={activeLocalCwd} pinnedCwds={pinnedLocalCwds} onTogglePin={onLocalTogglePin} />}
      {visible.map((t) => (
        <ChatChip
          key={t.id}
          t={t}
          active={t.id === activeId}
          dimmed={t.pinned}
          onActivate={() => onActivate(t)}
          onClose={() => onClose(t)}
          onMenu={(e) => openMenu(e, t)}
        />
      ))}
      {menu && (
        <TabMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onPin={() => { onTogglePin(menu.tab); setMenu(null); }}
          onCloseTab={() => { onClose(menu.tab); setMenu(null); }}
        />
      )}
    </div>
  );
});
TopTabs.displayName = 'TopTabs';

/** 单条非 local tab。chat / gallery / kb 共用同一壳，只换图标。
 *  pinned：缩略（仅图标、无标题、无关闭），钉在最左。右键唤出菜单。 */
const ChatChip: React.FC<{ t: TopTab; active: boolean; pinned?: boolean; dimmed?: boolean; onActivate: () => void; onClose: () => void; onMenu: (e: React.MouseEvent) => void }> = ({ t, active, pinned, dimmed, onActivate, onClose, onMenu }) => {
  const { t: tr } = useI18n();
  // `dimmed` = a pinned tab shown in the bar because it's active: keep the label
  // but render muted/gray, and no close affordance (it's managed from the rail).
  const noClose = pinned || dimmed;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`v2-la-tab${active ? ' active' : ''}${t.attn ? ' attn' : ''}${pinned ? ' pinned' : ''}${dimmed ? ' dim' : ''}`}
      onClick={onActivate}
      onContextMenu={onMenu}
      // 拖到 CLI 分屏的某个窗格上 → 把该「页」作为异类叶子加入分屏（wiki / chat:<sid>）。
      // 复用本地 pane 的 text/cwd 落点逻辑（见 LocalAgentPaneImpl.onDrop → la.placePane）。
      draggable
      onDragStart={(e) => {
        const fid = t.kind === 'kb' ? 'wiki' : (t.kind === 'chat' && t.sessionId) ? `chat:${t.sessionId}` : '';
        if (fid) { e.dataTransfer.setData('text/cwd', fid); e.dataTransfer.effectAllowed = 'copy'; }
      }}
      onMouseDown={(e) => { if (e.button === 1 && !noClose) { e.preventDefault(); onClose(); } }}   // 中键关闭（固定项除外）
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
        if (!noClose && (e.key === 'Delete' || (e.key === 'w' && (e.metaKey || e.ctrlKey)))) { e.preventDefault(); onClose(); }
      }}
      title={(pinned || dimmed) ? tr('tabs.pinnedTitle', { label: t.label }) : t.label}
    >
      <span className="ico" aria-hidden><TabTypeIcon t={t} /></span>
      {!pinned && <span className="sess">{t.label}</span>}
      {t.unread && !active && <span className="unread" aria-label={tr('tabs.unread')} />}
      {t.attn && <span className="attn-mark" aria-label={tr('tabs.needApproval')}>!</span>}
      {!noClose && (
        <button
          className="x"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title={tr('tabs.closeHint')}
          aria-label={tr('tabs.close')}
          tabIndex={-1}
        >×</button>
      )}
    </div>
  );
};

/** Tab 右键菜单：固定/取消固定 · 关闭。 */
const TabMenu: React.FC<{ menu: MenuState; onClose: () => void; onPin: () => void; onCloseTab: () => void }> = ({ menu, onClose, onPin, onCloseTab }) => {
  const { t: tr } = useI18n();
  useEffect(() => {
    const onDoc = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onDoc), 0);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const style: React.CSSProperties = {
    left: Math.min(menu.x, window.innerWidth - 180),
    top: Math.min(menu.y, window.innerHeight - 96),
  };
  // Portal 到 .chaya-v2 根：菜单用 position:fixed + clientX/Y 定位，必须脱离 topbar
  // （带 backdrop-filter / transform 的祖先会让 fixed 相对它而非视口，导致错位）。
  // 落在根而非 body，既逃出 topbar 的合成层，又保留 .chaya-v2 主题/玻璃样式作用域。
  const host = (typeof document !== 'undefined' && document.querySelector('.chaya-v2')) || document.body;
  return createPortal(
    <div className="v2-rowmenu v2-toptab-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={onPin}>{menu.tab.pinned ? tr('tabs.unpin') : tr('tabs.pin')}</button>
      <button onClick={onCloseTab}>{tr('tabs.closeTab')}</button>
    </div>,
    host,
  );
};

/** 类型图标：用 SVG 而非 unicode glyph，保证基线/字号在所有主题下都一致。
 *  导出给左侧栏的固定 tab（pinned）小图标复用，保持图标语义一致。 */
export const TabTypeIcon: React.FC<{ t: TopTab }> = ({ t }) => {
  if (t.kind === 'gallery') return <IconGallery />;
  if (t.kind === 'kb') return <IconKB />;
  if (t.kind === 'local') return <IconTerminal />;
  if (t.kind === 'chat') {
    if (t.isPrimary || t.sessionType === 'agent') return <IconAgentPrimary />;
    return <IconChat />;
  }
  return <IconChat />;
};
