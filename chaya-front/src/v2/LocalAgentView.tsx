/**
 * Local Agents 视图 —— 纯本地功能，与 Chaya 后端无关。
 *
 * 拆成两块共享 useLocalAgent 状态（类似 Codex）：
 *  - <LocalAgentTree>：放进主导航侧栏。顶部切 provider，下方项目树形结构。
 *  - <LocalAgentConversation>：放进右侧主区域，会话记录像普通聊天一样渲染。
 *
 * 对话用时间线渲染（状态点 + 工具卡片：Edit 代码块 / Bash IN/OUT），配色走 Chaya token。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basename, PERM_META, permModesFor, defaultPermMode, type TranscriptMessage, type SlashCommand, type SessionSummary, type PermissionRequest, type QuestionRequest, type TabGroup as TabGroupT, type McpAvailable, type ModelInfo, type Attachment } from './services/localAgent';
import type { LocalAgentState, LayoutNode, DropSide, Tab } from './useLocalAgent';
import { TAB_COLORS } from './useLocalAgent';
import { IconSend, IconAgentCode, IconPlus, IconChevron, IconTrash, IconSkill, IconModel } from './icons';
import { CodeBlock, PreBlock, mdRehypePlugins } from './codeBlock';
import { useI18n, t } from '../i18n';

// 公共组件：链接新窗口打开、宽表格局部横滚。
const MD_COMMON = {
  a: ({ node: _n, ...p }: any) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _n, ...p }: any) => <div className="v2-la-xscroll"><table {...p} /></div>,
};
// 定稿态：用 Shiki 高亮代码。
const MD_RICH = { ...MD_COMMON, code: CodeBlock, pre: PreBlock } as React.ComponentProps<typeof ReactMarkdown>['components'];
// 流式态：代码走原生 <pre>，不上 Shiki —— 否则每个 rAF tick 都对增长中的代码重新高亮，
// CPU/内存暴涨直接把渲染进程拖崩（黑屏）。定稿后再用 MD_RICH 高亮一次。
const MD_PLAIN = { ...MD_COMMON } as React.ComponentProps<typeof ReactMarkdown>['components'];

/** 从模型 id / displayName 猜测厂商。SDK 的 supportedModels 不带 vendor 字段，
 *  这里用一组保守的正则覆盖主流模型族。命中顺序很重要：先匹配特征更强的别名
 *  （如 haiku/sonnet/opus），再匹配通用前缀（claude-）。未命中归到「其他」末尾。 */
const VENDOR_ORDER = [
  'Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'xAI', 'Mistral',
  'Meta', 'Alibaba', 'Moonshot', '智谱', '零一万物', '豆包',
  'Cohere', 'Perplexity', 'Groq', '其他',
] as const;
/** 只有这几个厂商名是中文显示串，需走 i18n；其余是专有名词（Anthropic/OpenAI…）原样显示。 */
const VENDOR_I18N: Record<string, string> = {
  '智谱': 'local.vendor.zhipu',
  '零一万物': 'local.vendor.lingyi',
  '豆包': 'local.vendor.doubao',
  '其他': 'local.vendor.other',
};
function vendorOfModel(m: ModelInfo): string {
  const v = (m.value || '').toLowerCase();
  const d = (m.displayName || '').toLowerCase();
  const hit = (re: RegExp) => re.test(v) || re.test(d);
  if (hit(/^claude|anthropic|haiku|sonnet|opus/)) return 'Anthropic';
  if (hit(/^gpt-|^o1\b|^o3\b|^o4\b|openai/)) return 'OpenAI';
  if (hit(/^gemini|^palm|google/)) return 'Google';
  if (hit(/^deepseek/)) return 'DeepSeek';
  if (hit(/^grok|xai/)) return 'xAI';
  if (hit(/^mistral|^mixtral|^magistral|^codestral/)) return 'Mistral';
  if (hit(/^llama|^codellama|meta-/)) return 'Meta';
  if (hit(/^qwen|通义|dashscope|alibaba/)) return 'Alibaba';
  if (hit(/^moonshot|^kimi/)) return 'Moonshot';
  if (hit(/^glm-|^zhipu|^chatglm/)) return '智谱';
  if (hit(/^yi-|^01-?ai/)) return '零一万物';
  if (hit(/^doubao|^volc|火山/)) return '豆包';
  if (hit(/^command|cohere/)) return 'Cohere';
  if (hit(/^pplx|perplex/)) return 'Perplexity';
  if (hit(/^groq/)) return 'Groq';
  return '其他';
}
/** 按厂商分组并按 VENDOR_ORDER 排序；每组内保留传入顺序（一般 SDK 返回的就是
 *  能力从强到弱的顺序）。返回 [vendor, models[]] 元组列表。 */
function groupModelsByVendor(models: ModelInfo[]): [string, ModelInfo[]][] {
  const buckets = new Map<string, ModelInfo[]>();
  models.forEach((m) => {
    const v = vendorOfModel(m);
    const arr = buckets.get(v);
    if (arr) arr.push(m); else buckets.set(v, [m]);
  });
  return Array.from(buckets.entries()).sort(
    (a, b) => VENDOR_ORDER.indexOf(a[0] as typeof VENDOR_ORDER[number]) - VENDOR_ORDER.indexOf(b[0] as typeof VENDOR_ORDER[number]),
  );
}

const MD: React.FC<{ text: string; live?: boolean }> = React.memo(({ text, live }) => (
  <div className="v2-md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={live ? [] : mdRehypePlugins}
      components={live ? MD_PLAIN : MD_RICH}
    >{text}</ReactMarkdown>
  </div>
));

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
};

// 终端风 icon，匹配 app 的 24×24 线性图标风格（同 IconChat/IconKB）。
const IconTerminal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M7.5 9.5l3 2.5-3 2.5M13 14.5h4" />
  </svg>
);

const IconFolder = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
  </svg>
);

const IconPaperclip = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.5 7.5l-5.6 5.6a3 3 0 0 1-4.2-4.2l6-6a2 2 0 0 1 2.8 2.8l-6 6a1 1 0 0 1-1.4-1.4l5.3-5.3" />
  </svg>
);

const IconFileGeneric = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 1.5h5l3 3v9a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5Z" /><path d="M9 1.5v3h3" />
  </svg>
);

/** 把拖入/粘贴的 File 列表转成附件（图片读成 dataUrl 走视觉；其它按 path 让 agent 读取）。
 *  ≤8MB 的图片才内联 dataUrl，否则退化成按路径引用（与主进程 pickFiles 规则一致）。 */
const IMG_MIME_RE = /^image\//;
function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
}
async function filesToAttachments(files: File[]): Promise<Omit<Attachment, 'id'>[]> {
  const out: Omit<Attachment, 'id'>[] = [];
  for (const f of files) {
    const p = (f as unknown as { path?: string }).path || undefined;   // Electron 给 File 挂了 .path
    const canInlineImg = IMG_MIME_RE.test(f.type) && f.size > 0 && f.size <= 8 * 1024 * 1024;
    let dataUrl: string | undefined;
    if (canInlineImg) { try { dataUrl = await readAsDataUrl(f); } catch { /* */ } }
    const ext = (f.type.split('/')[1] || 'png').replace('+xml', '');
    out.push({
      kind: dataUrl ? 'image' : 'file',
      name: f.name || (dataUrl ? `${t('local.att.pastedImage')}.${ext}` : t('local.att.file')),
      path: p, mime: f.type || null, size: f.size, dataUrl,
    });
  }
  // 没有 path 也没有 dataUrl 的（如粘贴的纯文本片段、无法读取的项）丢弃——无从引用。
  return out.filter((a) => a.path || a.dataUrl);
}

const Spinner: React.FC<{ label?: string }> = ({ label }) => (
  <div className="v2-la-loading">
    <span className="v2-la-spinner" />
    {label && <span>{label}</span>}
  </div>
);

/* ================================================================== *
 * 侧栏：provider 切换 + 项目树
 * ================================================================== */
export const LocalAgentTree: React.FC<{
  la: LocalAgentState;
  /** 打开会话/新建时切到 CLI 视图（点击标题进入并触发探测）。 */
  onEnter: () => void;
  /** 单击 provider 徽标循环切换：claude → codex → gemini。 */
  onCycleProvider: () => void;
}> = React.memo(({ la, onEnter, onCycleProvider }) => {
  const { t: tr } = useI18n();
  const openSess = (cwd: string, sid: string, title: string) => { onEnter(); void la.openSession(cwd, sid, title); };
  const fresh = (cwd: string) => { onEnter(); la.newSession(cwd); };
  const cur = la.current;
  const ready = !la.detecting && !!cur?.installed && !!cur?.live;
  return (
    <div className="v2-la-tree">
      {/* 顶部：CLI 品牌行 + 当前 provider 彩色徽标。
          点击标题进入并探测；探测中转圈，就绪打勾。单击徽标循环切换 provider。 */}
      <div className="v2-sec v2-la-brand">
        <span className="v2-la-brand-ic"><IconTerminal /></span>
        <span className="v2-la-title" onClick={onEnter}>CLI</span>
        <button
          className={`v2-la-badge prov-${la.provider}${ready ? ' ready' : ''}`}
          onClick={onCycleProvider}
          title={tr('local.tree.providerBadge', { provider: PROVIDER_LABELS[la.provider] })}
        >
          <span className="ic">
            {la.detecting ? <span className="v2-la-spinner sm" /> : ready ? <span className="ck">✓</span> : null}
          </span>
          {PROVIDER_LABELS[la.provider]}
        </button>
      </div>

      {/* 项目列表 */}
      <div className="v2-sec v2-la-projsec">
        <span>Projects</span>
        <button className="v2-add" title={tr('local.tree.addProject')} onClick={la.addProject}><IconPlus /></button>
      </div>

      <div className="v2-la-projlist">
        {la.projects.map((p) => {
          const open = la.expanded.has(p.id);
          const ss = la.sessionsByPath[p.path];
          return (
            <div key={p.id} className="v2-la-proj">
              <div className={`v2-la-proj-row${la.activeCwd === p.path ? ' active' : ''}`} onClick={() => la.toggleProject(p)}>
                <span className={`v2-la-caret${open ? ' open' : ''}`}><IconChevron /></span>
                <span className="v2-la-proj-ic"><IconFolder /></span>
                <span className="v2-la-proj-nm" title={p.path}>{p.name}</span>
                <span className="v2-la-proj-acts">
                  <button title={tr('local.tree.newSession')} onClick={(e) => { e.stopPropagation(); fresh(p.path); }}><IconPlus /></button>
                  <button title={tr('local.tree.removeProject')} onClick={(e) => { e.stopPropagation(); la.removeProject(p.id, p.path); }}><IconTrash /></button>
                </span>
              </div>
              {open && (
                <div className="v2-la-sessions">
                  {ss === 'loading' && <Spinner label={tr('local.tree.scanningSessions')} />}
                  {Array.isArray(ss) && ss.length === 0 && <div className="v2-la-hint sub">{tr('local.tree.noSessions')}</div>}
                  {Array.isArray(ss) && ss.map((s) => (
                    <SessionRow
                      key={s.sessionId}
                      s={s}
                      active={la.activeSessionId === s.sessionId && la.activeCwd === p.path}
                      open={la.tabs.some((t) => t.cwd === p.path && t.sessionId === s.sessionId)}
                      onOpen={() => openSess(p.path, s.sessionId, s.title || s.preview || tr('local.untitledSession'))}
                      onDelete={() => la.deleteSession(p.path, s.sessionId)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
LocalAgentTree.displayName = 'LocalAgentTree';

/* 标签栏（类浏览器）—— 放进主区顶栏，与面包屑合并成一行。每项目一个标签。 */
type MenuState = { x: number; y: number; kind: 'tab' | 'group'; id: string };

/** 单个标签 chip：点击切主区内容、可拖到右侧平铺、右键唤出分组菜单。 */
const TabChip: React.FC<{ la: LocalAgentState; t: Tab; grouped?: boolean; onMenu: (e: React.MouseEvent, kind: 'tab', id: string) => void; dropProps?: React.HTMLAttributes<HTMLDivElement>; dropBefore?: boolean; onActivate?: (cwd: string) => void; activeCwd?: string | null }> = ({ la, t, grouped, onMenu, dropProps, dropBefore, onActivate, activeCwd }) => {
  const { t: tr } = useI18n();
  const proj = la.projects.find((p) => p.path === t.cwd);
  // 高亮判断：上层（TopTabs）提供 activeCwd 覆盖时，以它为准 —— 这样当全局 activeId
  // 是一个 chat tab 时，本地 tab 不会还残留 hairline；未提供则回退到 la.activeCwd
  // （非 inline 模式下旧行为）。
  const isActive = (activeCwd === undefined ? la.activeCwd : activeCwd) === t.cwd;
  return (
    <div
      className={`v2-la-tab${isActive ? ' active' : ''}${la.gridCwds.includes(t.cwd) ? ' ingrid' : ''}${grouped ? ' grouped' : ''}${dropBefore ? ' dropbefore' : ''}`}
      onClick={() => { la.setActiveTab(t.cwd); onActivate?.(t.cwd); }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/cwd', t.cwd); e.dataTransfer.effectAllowed = 'copy'; }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e, 'tab', t.cwd); }}
      title={`${t.cwd}\n${tr('local.tab.chipHint')}`}
      {...dropProps}
    >
      <span className="proj">{proj?.name || basename(t.cwd)}</span>
      <span className="sep">/</span>
      <span className="sess">{t.sessionId ? t.title : tr('local.newSession')}</span>
      {t.running && <span className="rundot" title={tr('local.running')} />}
      <button className="x" title={tr('local.tab.close')} onClick={(e) => { e.stopPropagation(); la.closeTab(t.cwd); }}>✕</button>
    </div>
  );
};

/** 标签/分组右键菜单：新建分组、加入/移出、改色、重命名、折叠、解散。 */
const TabMenu: React.FC<{ la: LocalAgentState; menu: MenuState; onClose: () => void; onRename: (id: string) => void }> = ({ la, menu, onClose, onRename }) => {
  const { t: tr } = useI18n();
  useEffect(() => {
    const h = () => onClose();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('mousedown', h); window.removeEventListener('keydown', k); };
  }, [onClose]);
  const style: React.CSSProperties = { left: Math.min(menu.x, window.innerWidth - 220), top: menu.y };

  if (menu.kind === 'tab') {
    const t = la.tabs.find((x) => x.cwd === menu.id);
    if (!t) return null;
    return (
      <div className="v2-la-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
        {!t.groupId && <button onClick={() => { const id = la.createGroupFromTab(t.cwd); onRename(id); }}>{tr('local.menu.newGroup')}</button>}
        {!t.groupId && la.groups.length > 0 && <div className="sec">{tr('local.menu.addToGroup')}</div>}
        {!t.groupId && la.groups.map((g) => (
          <button key={g.id} onClick={() => { la.addTabToGroup(t.cwd, g.id); onClose(); }}>
            <span className="sw" style={{ background: g.color }} />{g.name}
          </button>
        ))}
        {t.groupId && <button onClick={() => { la.removeTabFromGroup(t.cwd); onClose(); }}>{tr('local.menu.removeFromGroup')}</button>}
        <div className="div" />
        <button className="danger" onClick={() => { la.closeTab(t.cwd); onClose(); }}>{tr('local.tab.close')}</button>
      </div>
    );
  }

  const g = la.groups.find((x) => x.id === menu.id);
  if (!g) return null;
  return (
    <div className="v2-la-menu" style={style} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={() => onRename(g.id)}>{tr('local.menu.rename')}</button>
      <div className="sec">{tr('local.menu.color')}</div>
      <div className="v2-la-swatches">
        {/* 纸色 = 无色 / opt-out。放在 leading 位上、形状与底下的色点不同
            （hairline dashed 圈 + 斜杠），视觉上"它不是另一个颜色，它是
            空状态"。点击之后整个组色变成 #ffffff —— group 容器底色 mix 白后
            ≈ 主卡 bg，组本身退化为"只剩文字的纯色 chip"。 */}
        <button
          className={`sw clear${g.color === '#ffffff' ? ' on' : ''}`}
          title={tr('local.menu.paperColor')}
          aria-label={tr('local.menu.noColor')}
          onClick={() => { la.setGroupColor(g.id, '#ffffff'); onClose(); }}
        />
        <span className="v2-la-swatches-div" aria-hidden />
        {TAB_COLORS.map((c) => (
          <button key={c} className={`sw${g.color === c ? ' on' : ''}`} style={{ background: c }} title={c} onClick={() => { la.setGroupColor(g.id, c); onClose(); }} />
        ))}
      </div>
      <div className="div" />
      <button onClick={() => { la.toggleGroup(g.id); onClose(); }}>{g.collapsed ? tr('local.menu.expandGroup') : tr('local.menu.collapseGroup')}</button>
      <button className="danger" onClick={() => { la.ungroupGroup(g.id); onClose(); }}>{tr('local.menu.ungroup')}</button>
    </div>
  );
};

export const LocalAgentTabs: React.FC<{ la: LocalAgentState; inline?: boolean; onTabActivate?: (cwd: string) => void; activeCwd?: string | null }> = ({ la, inline, onTabActivate, activeCwd }) => {
  const { t: tr } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);   // 分组重排：悬停的锚点（cwd 或 'end'）
  const openMenu = (e: React.MouseEvent, kind: 'tab' | 'group', id: string) => setMenu({ x: e.clientX, y: e.clientY, kind, id });

  // 顶栏重排放置区：接收 'text/group'（整组）或 'text/cwd'（单标签），移到 anchor 之前（'end'=末尾）。
  const groupDrop = (anchor: string): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (e) => {
      const ty = e.dataTransfer.types;
      if (ty.includes('text/group') || ty.includes('text/cwd')) { e.preventDefault(); if (dropAt !== anchor) setDropAt(anchor); }
    },
    onDragLeave: () => setDropAt((a) => (a === anchor ? null : a)),
    onDrop: (e) => {
      setDropAt(null);
      const gid = e.dataTransfer.getData('text/group');
      const cwd = e.dataTransfer.getData('text/cwd');
      const before = anchor === 'end' ? null : anchor;
      if (gid) { e.preventDefault(); la.moveGroupBefore(gid, before); }
      else if (cwd) { e.preventDefault(); la.moveTabBefore(cwd, before); }
    },
  });

  if (la.tabs.length === 0) return inline ? null : <span className="v2-la-tabs-empty">Local Agents</span>;

  // 把已聚拢的标签按 groupId 折成渲染单元：连续同组 → 一个分组块，否则单标签。
  type Unit = { kind: 'tab'; tab: Tab } | { kind: 'group'; group: TabGroupT; members: Tab[] };
  // 每个分组只渲染一个单元（在其首个成员的位置），把所有成员聚到一起——
  // 即便 tabs 里成员暂不连续也不会出现重复 key / 重复分组块。
  const units: Unit[] = [];
  const emittedGroups = new Set<string>();
  for (const t of la.tabs) {
    const g = t.groupId ? la.groups.find((x) => x.id === t.groupId) : undefined;
    if (t.groupId && g) {
      if (emittedGroups.has(g.id)) continue;   // 该分组已渲染过 → 跳过后续散落成员
      emittedGroups.add(g.id);
      units.push({ kind: 'group', group: g, members: la.tabs.filter((x) => x.groupId === g.id) });
    } else {
      units.push({ kind: 'tab', tab: t });
    }
  }

  const body = (<>
      {units.map((u) => u.kind === 'tab' ? (
        <TabChip key={u.tab.cwd} la={la} t={u.tab} onMenu={openMenu} dropProps={groupDrop(u.tab.cwd)} dropBefore={dropAt === u.tab.cwd} onActivate={onTabActivate} activeCwd={activeCwd} />
      ) : (
        <div
          key={u.group.id}
          className={`v2-la-group${u.group.collapsed ? ' collapsed' : ''}${dropAt === u.members[0].cwd ? ' dropbefore' : ''}`}
          style={{ ['--g' as string]: u.group.color } as React.CSSProperties}
          {...groupDrop(u.members[0].cwd)}
        >
          <div
            className="v2-la-group-chip"
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/group', u.group.id); e.dataTransfer.effectAllowed = 'move'; }}
            onClick={() => la.toggleGroup(u.group.id)}
            onContextMenu={(e) => { e.preventDefault(); openMenu(e, 'group', u.group.id); }}
            title={tr('local.groupChipHint')}
          >
            <span className="gdot" />
            {renaming === u.group.id ? (
              <input
                autoFocus
                className="gname-input"
                defaultValue={u.group.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { la.renameGroup(u.group.id, (e.target as HTMLInputElement).value.trim() || tr('local.groupFallbackName')); setRenaming(null); }
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={(e) => { la.renameGroup(u.group.id, e.target.value.trim() || tr('local.groupFallbackName')); setRenaming(null); }}
              />
            ) : (
              <span className="gname">{u.group.name}</span>
            )}
            {u.group.collapsed && <span className="gcnt">{u.members.length}</span>}
          </div>
          {!u.group.collapsed && u.members.map((m) => <TabChip key={m.cwd} la={la} t={m} grouped onMenu={openMenu} dropProps={groupDrop(m.cwd)} dropBefore={dropAt === m.cwd} onActivate={onTabActivate} activeCwd={activeCwd} />)}
        </div>
      ))}
      {/* 末尾放置区：把分组拖到这里 = 移到最右。inline 模式下不撑满（不要把后面的 chat tabs 推走）。 */}
      <div className={`v2-la-tabs-end${dropAt === 'end' ? ' dropbefore' : ''}${inline ? ' inline' : ''}`} {...groupDrop('end')} />
      {menu && <TabMenu la={la} menu={menu} onClose={() => setMenu(null)} onRename={(id) => { setRenaming(id); setMenu(null); }} />}
  </>);
  return inline ? body : <div className="v2-la-tabs">{body}</div>;
};

/* 会话行：hover 出垃圾桶；点一下进入两步确认，避免误删。删除走系统回收站可恢复。 */
const SessionRow: React.FC<{
  s: SessionSummary;
  active: boolean;
  open?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}> = ({ s, active, open, onOpen, onDelete }) => {
  const { t: tr } = useI18n();
  const [confirm, setConfirm] = useState(false);
  return (
    <div
      className={`v2-la-sess${active ? ' active' : ''}${open && !active ? ' open' : ''}${confirm ? ' confirming' : ''}`}
      onClick={() => { if (!confirm) onOpen(); }}
      title={s.preview || s.sessionId}
    >
      <span className="t">{s.title || s.preview || tr('local.untitledSession')}</span>
      {confirm ? (
        <span className="v2-la-sess-confirm" onClick={(e) => e.stopPropagation()}>
          <button className="del" title={tr('local.session.deleteToTrash')} onClick={() => { onDelete(); setConfirm(false); }}>{tr('common.delete')}</button>
          <button className="cancel" title={tr('common.cancel')} onClick={() => setConfirm(false)}>{tr('common.cancel')}</button>
        </span>
      ) : (
        <>
          <span className="m">{fmtTime(s.updatedAt)}</span>
          <button className="v2-la-sess-del" title={tr('local.session.delete')} onClick={(e) => { e.stopPropagation(); setConfirm(true); }}><IconTrash /></button>
        </>
      )}
    </div>
  );
};

/* agent 权限/批准弹窗 —— canUseTool 触发时让用户选：允许 / 始终允许 / 拒绝。 */
const PermissionPrompt: React.FC<{
  perm: PermissionRequest;
  onAllow: () => void;
  onAlways: () => void;
  onDeny: () => void;
}> = ({ perm, onAllow, onAlways, onDeny }) => {
  const { t: tr } = useI18n();
  const lower = (perm.toolName || '').toLowerCase();
  const input = perm.input || {};
  const heading = perm.title || perm.displayName || tr('local.perm.requests', { tool: perm.toolName });
  let detail: React.ReactNode = null;
  if (lower === 'bash') detail = <pre className="cmd">{input.command || ''}</pre>;
  else if (lower === 'edit' || lower === 'write' || lower === 'multiedit' || lower === 'notebookedit') {
    detail = <code className="file">{basename(input.file_path || input.notebook_path || '')}</code>;
  } else if (lower === 'exitplanmode' && input.plan) detail = <div className="plan"><MD text={String(input.plan)} /></div>;
  else if (perm.description) detail = <div className="desc">{perm.description}</div>;
  const canAlways = Array.isArray(perm.suggestions) && perm.suggestions.length > 0;
  return (
    <div className="v2-la-perm">
      <div className="v2-la-perm-hd"><span className="dot" /><b>{perm.toolName}</b><span className="t">{heading}</span></div>
      {detail && <div className="v2-la-perm-body">{detail}</div>}
      <div className="v2-la-perm-acts">
        <button className="allow" onClick={onAllow}>{tr('local.perm.allow')}</button>
        {canAlways && <button className="always" onClick={onAlways}>{tr('local.perm.always')}</button>}
        <button className="deny" onClick={onDeny}>{tr('local.perm.deny')}</button>
      </div>
    </div>
  );
};

/* agent 的 AskUserQuestion → 在对话里渲染成可选卡片（仿 VSCode 插件），
   提交后把选择经 deny-message 回传给 agent 继续。 */
const QuestionPrompt: React.FC<{
  q: QuestionRequest;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}> = ({ q, onSubmit, onCancel }) => {
  const { t: tr } = useI18n();
  const questions = q.questions || [];
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [activeQ, setActiveQ] = useState(0);   // 多问题时的当前分页
  const multiQ = questions.length > 1;

  const answered = (qi: number) => (sel[qi]?.length || 0) > 0 || !!other[qi]?.trim();
  const pick = (qi: number, label: string, multi: boolean) => {
    setSel((s) => {
      const cur = s[qi] || [];
      if (multi) return { ...s, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      return { ...s, [qi]: [label] };
    });
    // 单选 → 自动跳到下一道未答的题，减少点击
    if (!multi && multiQ) {
      const next = questions.findIndex((_, i) => i > qi && !answered(i));
      if (next >= 0) setTimeout(() => setActiveQ(next), 160);
    }
  };
  const answeredCount = questions.filter((_, qi) => answered(qi)).length;
  const canSubmit = questions.length > 0 && answeredCount === questions.length;
  const submit = () => {
    const lines = questions.map((qq, qi) => {
      const parts = [...(sel[qi] || [])];
      if (other[qi]?.trim()) parts.push(other[qi].trim());
      return `- ${qq.header || qq.question}: ${parts.join('; ') || tr('local.question.unselected')}`;
    });
    onSubmit(`${tr('local.question.answeredLead')}\n${lines.join('\n')}`);
  };

  const renderQuestion = (qq: typeof questions[number], qi: number) => (
    <div className="v2-la-q-block">
      {!multiQ && qq.header && <div className="v2-la-q-head">{qq.header}</div>}
      <div className="v2-la-q-title">{qq.question}</div>
      <div className="v2-la-q-opts">
        {qq.options.map((o, oi) => {
          const on = (sel[qi] || []).includes(o.label);
          return (
            <button key={oi} className={`v2-la-q-opt${on ? ' on' : ''}${qq.multiSelect ? ' multi' : ''}`} onClick={() => pick(qi, o.label, !!qq.multiSelect)}>
              <span className="mk" />
              <span className="body">
                <span className="lab">{o.label}</span>
                {o.description && <span className="desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
        <div className={`v2-la-q-opt other${other[qi]?.trim() ? ' on' : ''}`}>
          <span className="mk" />
          <input placeholder={tr('local.question.otherPlaceholder')} value={other[qi] || ''} onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="v2-la-q">
      {/* 多问题：横向分页 tab（点击切题，答完打勾），只显示当前题，省高度 */}
      {multiQ && (
        <div className="v2-la-q-tabs">
          {questions.map((qq, qi) => (
            <button
              key={qi}
              className={`v2-la-q-tab${qi === activeQ ? ' active' : ''}${answered(qi) ? ' done' : ''}`}
              onClick={() => setActiveQ(qi)}
            >
              <span className="i">{answered(qi) ? '✓' : qi + 1}</span>
              {qq.header || tr('local.question.questionN', { n: qi + 1 })}
            </button>
          ))}
        </div>
      )}

      {multiQ
        ? (questions[activeQ] ? renderQuestion(questions[activeQ], activeQ) : null)
        : questions.map((qq, qi) => <React.Fragment key={qi}>{renderQuestion(qq, qi)}</React.Fragment>)}

      <div className="v2-la-q-acts">
        <button className="submit" disabled={!canSubmit} onClick={submit}>
          {tr('local.question.submit')}{multiQ ? ` (${answeredCount}/${questions.length})` : ''}
        </button>
        <button className="cancel" onClick={onCancel}>{tr('common.cancel')}</button>
      </div>
    </div>
  );
};

/* ================================================================== *
 * 主区域：单窗 = 一个 Pane；多窗 = 网格平铺多个独立 Pane（各自输入、各自流式）。
 * ================================================================== */
const NO_MSGS: TranscriptMessage[] = [];
const NO_ATTS: Attachment[] = [];

/** 一个独立会话窗格：自带时间线 + 输入框 + 斜杠/权限/选择，全部按 cwd 寻址。 */
type PaneProps = { la: LocalAgentState; cwd: string; inGrid?: boolean };
const LocalAgentPaneImpl: React.FC<PaneProps> = ({ la, cwd, inGrid }) => {
  const { t: tr } = useI18n();
  const tab = la.tabs.find((t) => t.cwd === cwd);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [dropSide, setDropSide] = useState<DropSide | null>(null);
  const [fileOver, setFileOver] = useState(false);   // 拖文件进窗格的高亮态
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgTab, setCfgTab] = useState<'model' | 'mcp'>('model');
  const [mcpList, setMcpList] = useState<McpAvailable[] | null>(null);

  const attachments = tab?.attachments ?? NO_ATTS;
  const draft = tab?.draft ?? '';
  const messages = tab?.messages ?? NO_MSGS;
  const liveMsgs = tab?.liveMsgs ?? NO_MSGS;
  const livePreview = tab?.livePreview ?? '';
  const running = tab?.running ?? false;
  const status = tab?.status ?? '';
  const loadingSession = tab?.loading ?? false;
  const perm = tab?.perm ?? null;
  const question = tab?.question ?? null;
  const sessionId = tab?.sessionId ?? null;

  // 折成「轮次」：分两段记忆——historyTurns 只随历史消息变（每回合一次），liveTurns 只随
  // 流式消息变（工具事件级，体量小）；livePreview（每帧都变）走渲染层「尾巴」，不进 memo。
  // 这样长会话里：① 打字机出字不再触发 groupTurns；② 工具事件也只重排小段 liveTurns，
  // historyTurns 在 messages 引用不变时直接复用——之前是该处「对话多了就卡」的根因。
  // 边界正确性：历史末尾必为 user turn（用户刚发的），液体段以 agent 起头，拼接后分组天然衔接。
  const historyBlocks = useMemo(() => buildBlocks(messages), [messages]);
  const liveBlocks = useMemo(() => buildBlocks(liveMsgs), [liveMsgs]);
  const historyTurns = useMemo(() => groupTurns(historyBlocks, false), [historyBlocks]);
  const liveTurns = useMemo(() => groupTurns(liveBlocks, false), [liveBlocks]);
  const turns = useMemo(() => (liveTurns.length ? [...historyTurns, ...liveTurns] : historyTurns), [historyTurns, liveTurns]);
  const hasConversation = turns.length > 0 || !!livePreview || running;

  // 斜杠命令弹层：draft 以 / 开头且还在敲命令 token（无空白）时打开。
  const slashQuery = (!slashDismissed && draft.startsWith('/') && !/\s/.test(draft)) ? draft.slice(1) : null;
  const slashItems = useMemo(() => {
    if (slashQuery === null) return [] as SlashCommand[];
    const q = slashQuery.toLowerCase();
    return la.commands.filter((c) => c.name.slice(1).toLowerCase().includes(q)).slice(0, 8);
  }, [slashQuery, la.commands]);
  const slashOpen = slashQuery !== null;
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);
  const pickSlash = (c: SlashCommand) => { la.setDraft(cwd, `${c.name} `); setSlashDismissed(true); requestAnimationFrame(() => taRef.current?.focus()); };

  // 自动滚到底（与 ClientShell 主聊保持同款 + 远端挂载的稳态加固）：
  //  ① rAF 队列防 thrash：多个状态变化挤进一帧只测一次 scrollHeight。
  //  ② 切 cwd OR 重挂载 → 强制滚到底；但 markdown / 代码高亮 / tool 块在挂载
  //     之后还会继续撑高内容若干帧。单次 rAF 测到的是「半成品高度」，scrollTop
  //     设完就被后续高度顶上去 → 视口卡在中段。所以切换/挂载时分多帧重测：
  //     当帧、下一帧、~60ms、~240ms，覆盖代码块异步 highlight / 字体落定。
  //     之后才把 lastScrolledCwdRef 记为「已结算」。
  //  ③ 同 cwd 持续追流式：用户已经滚到上面看历史 → 不强行拉回；近底 → 跟字。
  const scrollRafRef = useRef<number | null>(null);
  const lastScrolledCwdRef = useRef<string | null>(null);
  const settleTimersRef = useRef<number[]>([]);
  const settleRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = streamRef.current; if (!el) return;
      const cwdChanged = lastScrolledCwdRef.current !== cwd;
      if (cwdChanged) {
        // Stage 1: immediate hard snap to whatever height we have now.
        el.scrollTop = el.scrollHeight;
        // Stages 2-4: catch the async layout shifts after markdown / code
        // highlighting / images settle. Each pass re-reads scrollHeight off
        // the live ref so we end up at the final bottom, not the half-loaded
        // one. ALL timers + the chained rAF are tracked so unmount or a
        // re-queue cancels them — fixes a leak where the inner rAF kept
        // pinning the ref past unmount.
        for (const id of settleTimersRef.current) window.clearTimeout(id);
        settleTimersRef.current = [];
        if (settleRafRef.current != null) {
          cancelAnimationFrame(settleRafRef.current); settleRafRef.current = null;
        }
        const restick = () => {
          const el2 = streamRef.current; if (!el2) return;
          el2.scrollTop = el2.scrollHeight;
        };
        settleRafRef.current = requestAnimationFrame(() => {
          settleRafRef.current = null;
          restick();
        });
        settleTimersRef.current.push(
          window.setTimeout(restick, 60),
          window.setTimeout(restick, 240),
        );
        if (messages.length > 0) lastScrolledCwdRef.current = cwd;
        return;
      }
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distFromBottom > 200) return;
      el.scrollTop = el.scrollHeight;
    });
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
      if (settleRafRef.current != null) {
        cancelAnimationFrame(settleRafRef.current);
        settleRafRef.current = null;
      }
      for (const id of settleTimersRef.current) window.clearTimeout(id);
      settleTimersRef.current = [];
    };
  }, [cwd, messages.length, liveMsgs.length, livePreview, status, loadingSession]);
  // 载入完成且当前激活时聚焦输入框——直接续聊。
  useEffect(() => {
    if (!loadingSession && cwd === la.activeCwd && la.current?.live) requestAnimationFrame(() => taRef.current?.focus());
  }, [sessionId, loadingSession, cwd, la.activeCwd, la.current?.live]);
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    // 自适应高度：换行时撑高，显示每一行。分屏窗格较小，封顶更低。
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, inGrid ? 120 : 200)}px`;
  }, [draft, inGrid]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return; }
      if (slashItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashItems.length); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashItems.length) % slashItems.length); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(slashItems[slashIdx]); return; }
      }
    }
    if (e.key === 'Tab') { e.preventDefault(); la.cyclePermMode(cwd); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void la.send(cwd); }
  };
  const onDraftChange = (v: string) => { la.setDraft(cwd, v); if (slashDismissed) setSlashDismissed(false); };
  // 粘贴板里的图片（截图等）→ 作为参考图片附件，显示缩略图、随下条消息走视觉。
  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && IMG_MIME_RE.test(it.type)) { const f = it.getAsFile(); if (f) imgs.push(f); }
    }
    if (imgs.length) { e.preventDefault(); void filesToAttachments(imgs).then((a) => la.addAttachments(cwd, a)); }
  };

  const current = la.current;
  // Memoize the few per-render lookups so they don't run on every stream
  // chunk re-render. `la.projects` / `la.groups` references only change when
  // structural metadata mutates — well below token frequency.
  const proj = useMemo(
    () => la.projects.find((p) => p.path === cwd),
    [la.projects, cwd],
  );
  const group = useMemo(
    () => (tab?.groupId ? la.groups.find((g) => g.id === tab.groupId) : undefined),
    [la.groups, tab?.groupId],
  );
  const paneColor = group?.color ?? tab?.color;
  // 显示用：把不属于当前 provider 档位集的权限模式归一到该 provider 默认，避免 chip 串档。
  const effPerm = useMemo(
    () => (tab && permModesFor(la.provider).includes(tab.permMode))
      ? tab.permMode
      : defaultPermMode(la.provider),
    [tab?.permMode, la.provider],
  );
  const pm = PERM_META[effPerm];

  // 打开「模型 / MCP」对话框：拉一次 MCP 列表 + 探测状态（MCP 仅 claude——读 ~/.claude.json）。
  const hasMcp = la.provider === 'claude';
  const openCfg = () => { setCfgOpen(true); if (hasMcp) { if (!mcpList) void la.listMcp(cwd).then(setMcpList); la.refreshMcp(cwd); } else setCfgTab('model'); };
  // 对话框开启时：Esc 关闭（不冒泡去触发 Tab 切权限等全局键）。
  // 必须在 `if (!tab) return null` 之前调用 —— 之前放在 return 之后会让关闭最后
  // 一个 tab 时 hook 数量减少，触发 "Rendered fewer hooks than expected"。
  useEffect(() => {
    if (!cfgOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setCfgOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cfgOpen]);
  if (!tab) return null;

  // 拖到本窗格哪条边（最近边），就从那一侧分裂；拖的是另一个窗格则=移动重排。
  const computeSide = (e: React.DragEvent): DropSide => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return 'right';
    const dx = { left: (e.clientX - r.left) / r.width, right: (r.right - e.clientX) / r.width, top: (e.clientY - r.top) / r.height, bottom: (r.bottom - e.clientY) / r.height };
    return (Object.keys(dx) as DropSide[]).reduce((best, k) => (dx[k] < dx[best] ? k : best), 'right' as DropSide);
  };
  const onDragOver = (e: React.DragEvent) => {
    const ty = e.dataTransfer.types;
    // 拖文件进来 → 作为参考附件（高亮整窗，不走分裂逻辑）。
    if (ty.includes('Files')) { e.preventDefault(); if (!fileOver) setFileOver(true); return; }
    if (!ty.includes('text/cwd')) return;
    e.preventDefault();
    const s = computeSide(e); if (s !== dropSide) setDropSide(s);
  };
  const onDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      e.preventDefault(); e.stopPropagation(); setFileOver(false); setDropSide(null);
      void filesToAttachments(Array.from(e.dataTransfer.files)).then((a) => la.addAttachments(cwd, a));
      return;
    }
    const c = e.dataTransfer.getData('text/cwd'); const s = dropSide || computeSide(e); setDropSide(null);
    if (c && c !== cwd) { e.preventDefault(); e.stopPropagation(); la.placePane(cwd, c, s); }
  };

  return (
    <div
      ref={rootRef}
      className={`v2-la-pane${cwd === la.activeCwd ? ' focused' : ''}${inGrid ? ' ingrid' : ''}${fileOver ? ' fileover' : ''}`}
      style={{ ['--pane' as string]: paneColor } as React.CSSProperties}
      onMouseDown={inGrid ? () => la.setActiveTab(cwd) : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => { setDropSide(null); setFileOver(false); }}
      onDrop={onDrop}
    >
      {dropSide && <div className={`v2-la-drop ${dropSide}`} aria-hidden />}
      {fileOver && <div className="v2-la-filedrop" aria-hidden><span><IconPaperclip />{tr('local.pane.dropToAttach')}</span></div>}
      {inGrid && (
        <div
          className="v2-la-pane-hd"
          draggable
          onDragStart={(e) => { e.dataTransfer.setData('text/cwd', cwd); e.dataTransfer.effectAllowed = 'move'; }}
          title={tr('local.pane.dragToRearrange')}
        >
          <span className="dot" />
          <b>{proj?.name || basename(cwd)}</b>
          <span className="sess">{sessionId ? tab.title : tr('local.newSession')}</span>
          {running && <span className="run" title={tr('local.running')} />}
          <div className="v2-grow" />
          <button className="x" title={tr('local.pane.removeFromSplit')} onClick={(e) => { e.stopPropagation(); la.removePane(cwd); }}>✕</button>
        </div>
      )}

      <section className="v2-la-pane-stream" ref={streamRef}>
        <div className="v2-la-tl">
          {loadingSession && <Spinner label={tr('local.pane.loadingSession')} />}
          {!loadingSession && !hasConversation && (
            <div className="v2-la-hint center">{sessionId ? tr('local.pane.emptySession') : tr('local.pane.newSessionHint')}</div>
          )}
          {!loadingSession && turns.map((t, i) => (
            t.role === 'user'
              ? <UserTurn key={i} text={t.text} />
              : <AgentTurn
                  key={i}
                  blocks={t.blocks}
                  provider={la.provider}
                  streaming={t.streaming}
                  // livePreview 只挂到「最后一条」agent 轮的尾巴——只有这一个 AgentTurn 会随打字机重渲，
                  // 其余历史轮在 React.memo 下引用未变即整体跳过（与块的 markdown 一起）。
                  tail={i === turns.length - 1 && livePreview ? livePreview : undefined}
                  working={i === turns.length - 1 && running && !perm && !question}
                />
          ))}
          {/* 回合在跑但还没有 agent 轮（刚发出/工具前）：给个带头像的「寒暄」轮，定在左侧；
              此时若已经在出字，尾巴显示 livePreview。 */}
          {!loadingSession && running && !perm && !question && (turns.length === 0 || turns[turns.length - 1].role === 'user') && (
            <AgentTurn blocks={[]} provider={la.provider} tail={livePreview || undefined} working />
          )}
          {!loadingSession && !running && status && <div className="v2-la-note err">{status}</div>}
        </div>
      </section>

      <div className="v2-composer-wrap v2-la-composer-wrap">
        {/* 需要你介入的事（权限/选择）锚定在本窗输入框上方——绝不随对话流滚走。 */}
        {question && (
          <div className="v2-la-anchor">
            <QuestionPrompt
              q={question}
              onSubmit={(text) => la.answerQuestion(cwd, question.permId, text)}
              onCancel={() => la.answerQuestion(cwd, question.permId, tr('local.question.cancelMessage'))}
            />
          </div>
        )}
        {perm && (
          <div className="v2-la-anchor">
            <PermissionPrompt
              perm={perm}
              onAllow={() => la.respondPermission(cwd, perm.permId, { behavior: 'allow' })}
              onAlways={() => la.respondPermission(cwd, perm.permId, { behavior: 'allow', updatedPermissions: perm.suggestions || undefined })}
              onDeny={() => la.respondPermission(cwd, perm.permId, { behavior: 'deny', message: tr('local.perm.denyMessage') })}
            />
          </div>
        )}
        <div className={`v2-composer${inGrid ? ' v2-la-slim' : ''}`} data-mode="chat">
          <div className="v2-box">
            {inGrid && (current?.live
              ? <button className="v2-la-tri" onClick={openCfg} title={tr('local.cfg.modelMcp')}>▷</button>
              : <span className="v2-la-prompt" aria-hidden><IconSkill /></span>)}
            {slashOpen && (
              <div className="v2-la-slash">
                <div className="v2-la-slash-hd">{tr('local.slash.header')}</div>
                {slashItems.length === 0 && (
                  <div className="v2-la-slash-empty">
                    {la.commands.length === 0
                      ? tr('local.slash.noCommands')
                      : tr('local.slash.noMatch')}
                  </div>
                )}
                {slashItems.map((c, i) => (
                  <button
                    key={c.name}
                    className={`v2-la-slash-item${i === slashIdx ? ' active' : ''}`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onMouseDown={(e) => { e.preventDefault(); pickSlash(c); }}
                  >
                    <span className="nm">{c.name}</span>
                    {c.description && <span className="ds">{c.description}</span>}
                    <span className="sc">{c.scope === 'project' ? tr('local.scope.project') : c.scope === 'user' ? tr('local.scope.user') : tr('local.scope.builtin')}</span>
                  </button>
                ))}
              </div>
            )}
            {/* 参考附件条：图片显缩略图、其它文件显图标 + 名；× 移除。随下条消息发出。 */}
            {attachments.length > 0 && (
              <div className="v2-la-atts">
                {attachments.map((a) => (
                  <div key={a.id} className={`v2-la-att ${a.kind}`} title={a.path || a.name}>
                    {a.kind === 'image' && a.dataUrl
                      ? <img src={a.dataUrl} alt={a.name} />
                      : <span className="fic"><IconFileGeneric /></span>}
                    <span className="nm">{a.name}</span>
                    <button className="x" title={tr('local.att.remove')} onClick={() => la.removeAttachment(cwd, a.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={taRef}
              rows={1}
              placeholder={
                !current?.live ? tr('local.composer.unsupported', { provider: current?.label || la.provider })
                  : sessionId ? '' : inGrid ? tr('local.composer.placeholderSlim') : tr('local.composer.placeholder')
              }
              value={draft}
              disabled={!current?.live}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <div className="v2-row">
              <div className="v2-l">
                {proj && (
                  <span className="v2-la-ctx" title={proj.path}><IconFolder />{proj.name}</span>
                )}
                <button
                  className={`v2-la-mode tone-${pm.tone}`}
                  onClick={() => la.cyclePermMode(cwd)}
                  title={tr('local.permMode.title', { hint: tr(`local.permMode.${effPerm}.hint`) })}
                >{tr(`local.permMode.${effPerm}.label`)}</button>
                {current?.live && (
                  <button
                    className={`v2-la-attach${attachments.length ? ' on' : ''}`}
                    onClick={() => la.pickAttachments(cwd)}
                    title={tr('local.att.addHint')}
                  ><IconPaperclip />{attachments.length > 0 && <span className="n">{attachments.length}</span>}</button>
                )}
                {!inGrid && current?.live && (
                  <button className="v2-la-cfg" onClick={openCfg} title={tr('local.cfg.modelMcp')}>
                    <span className="tri" aria-hidden><IconModel /></span>
                    <span className="m">{(la.modelOptions.find((m) => m.value === tab.model)?.displayName) || (tab.model || tr('local.cfg.defaultModel'))}</span>
                    {(tab.mcp?.length ?? 0) > 0 && <span className="mcpn">MCP {tab.mcp!.length}</span>}
                  </button>
                )}
              </div>
              <div className="v2-grow" />
              {running ? (
                <button className="v2-send stop" title={tr('local.composer.interrupt')} onClick={() => la.interrupt(cwd)}>■</button>
              ) : (
                <button className="v2-send" title={tr('local.composer.send')} onClick={() => la.send(cwd)} disabled={(!draft.trim() && attachments.length === 0) || !current?.live}>
                  <IconSend />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {cfgOpen && (
        <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setCfgOpen(false); }} style={{ zIndex: 120 }}>
          <div className="v2-modal v2-la-cfgmodal" role="dialog" aria-modal="true" aria-label={hasMcp ? tr('local.cfg.modalLabelMcp') : tr('local.cfg.modalLabel')} onMouseDown={(e) => e.stopPropagation()}>
            <div className="v2-modal-hd">
              <h3>{hasMcp ? tr('local.cfg.modelMcp') : tr('local.cfg.model')}{proj ? ` · ${proj.name}` : ''}</h3>
              <button className="x" onClick={() => setCfgOpen(false)} aria-label={tr('common.close')}>✕</button>
            </div>
            <div className="v2-la-cfgtabs" role="tablist">
              <button role="tab" aria-selected={cfgTab === 'model'} className={cfgTab === 'model' ? 'on' : ''} onClick={() => setCfgTab('model')}>{tr('local.cfg.model')}</button>
              {hasMcp && <button role="tab" aria-selected={cfgTab === 'mcp'} className={cfgTab === 'mcp' ? 'on' : ''} onClick={() => setCfgTab('mcp')}>MCP{(tab.mcp?.length ?? 0) > 0 ? ` · ${tab.mcp!.length}` : ''}</button>}
            </div>
            <div className="v2-la-cfgbody" role="tabpanel" key={cfgTab}>
              {cfgTab === 'model' ? (
                la.modelOptions.length === 0 ? (
                  <div className="v2-la-slash-empty">{tr('local.cfg.modelsAfterSend')}</div>
                ) : (
                  <>
                    <button className={`v2-la-model-item${!tab.model ? ' on' : ''}`} onClick={() => { la.setModel(cwd, ''); setCfgOpen(false); }}>
                      <span className="nm">{tr('local.cfg.defaultModel')}</span><span className="ds">{tr('local.cfg.defaultModelDesc')}</span>
                    </button>
                    {groupModelsByVendor(la.modelOptions).map(([vendor, models]) => (
                      <div key={vendor} className="v2-la-model-group">
                        <div className="v2-la-model-vendor">{VENDOR_I18N[vendor] ? tr(VENDOR_I18N[vendor]) : vendor}</div>
                        {models.map((m) => (
                          <button key={m.value} className={`v2-la-model-item${tab.model === m.value ? ' on' : ''}`} onClick={() => { la.setModel(cwd, m.value); setCfgOpen(false); }}>
                            <span className="nm">{m.displayName}</span>
                            {m.description && <span className="ds">{m.description}</span>}
                          </button>
                        ))}
                      </div>
                    ))}
                    <div className="v2-la-cfg-foot">{tr('local.cfg.modelFoot')}</div>
                  </>
                )
              ) : (
                <>
                  <div className="v2-la-cfg-hd">
                    <span>{tr('local.cfg.mcpSource')}</span>
                    <button className="v2-la-probe" onClick={() => la.refreshMcp(cwd)} title={tr('local.cfg.probeStatus')}>{tr('local.cfg.probe')}</button>
                  </div>
                  {!mcpList && <div className="v2-la-slash-empty">{tr('local.cfg.mcpLoading')}</div>}
                  {mcpList && mcpList.length === 0 && <div className="v2-la-slash-empty">{tr('local.cfg.mcpEmpty')}</div>}
                  {mcpList && mcpList.map((m) => {
                    const on = (tab.mcp || []).includes(m.name);
                    const st = tab.mcpStatus?.find((x) => x.name === m.name)?.status;
                    return (
                      <div key={m.name} className={`v2-la-mcprow${on ? ' on' : ''}`}>
                        <button className="tog" onClick={() => { const cur = tab.mcp || []; la.setMcp(cwd, on ? cur.filter((n) => n !== m.name) : [...cur, m.name]); }}>
                          <span className="nm">{m.name}{st && <span className={`v2-la-mcp-dot ${st}`} title={st} />}</span>
                          <span className="ds">{m.scope === 'project' ? tr('local.scope.project') : tr('local.scope.global')} · {m.type}{st ? ` · ${st}` : ''}</span>
                        </button>
                        {on && st && st !== 'connected' && st !== 'pending' && (
                          <button className="rc" title={tr('local.cfg.reconnect')} onClick={() => la.reconnectMcp(cwd, m.name)}>{tr('local.cfg.reconnect')}</button>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** 窗格 memo 比较器：根因修复——`la` 每帧换新引用（任一标签 patchTab 都重建 tabs 数组），
 *  没有这个比较器时分屏里每个窗格都会随「任意一窗」的流式/打字/草稿全量重渲，
 *  N 个窗格 → O(N²) 渲染，「多了之后每个都卡」。这里只在本窗真正读取的字段变化时才放行重渲：
 *   · 自己那一片 tab（引用变 = 自己的消息/流式/草稿/权限变）——非本窗流式时它引用不变；
 *   · 少数共享字段（provider/current/projects/groups/modelOptions/commands/activeCwd），均非每帧变化。
 *  → A 窗出字/打字时 B/C/D 直接 skip。新增从 la 读取的字段时务必同步更新此处。 */
const paneEqual = (a: PaneProps, b: PaneProps): boolean => {
  if (a.cwd !== b.cwd || a.inGrid !== b.inGrid) return false;
  const la = a.la, lb = b.la;
  if (la.tabs.find((t) => t.cwd === a.cwd) !== lb.tabs.find((t) => t.cwd === b.cwd)) return false;
  return (
    la.activeCwd === lb.activeCwd &&
    la.provider === lb.provider &&
    la.current === lb.current &&
    la.projects === lb.projects &&
    la.groups === lb.groups &&
    la.modelOptions === lb.modelOptions &&
    la.commands === lb.commands
  );
};
const LocalAgentPane = React.memo(LocalAgentPaneImpl, paneEqual);
LocalAgentPane.displayName = 'LocalAgentPane';

/** 分屏树递归渲染：叶子 = 一个窗格；split = 两子树 + 一条可拖拽分隔线。 */
const PaneLayout: React.FC<{ la: LocalAgentState; node: LayoutNode }> = ({ la, node }) => {
  if (node.kind === 'leaf') return <LocalAgentPane la={la} cwd={node.cwd} inGrid />;
  return <SplitView la={la} node={node} />;
};

const SplitView: React.FC<{ la: LocalAgentState; node: Extract<LayoutNode, { kind: 'split' }> }> = ({ la, node }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  // 指针拖动分隔线 → 实时改 ratio（夹在 15%~85%，避免某格被挤没）。
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const raw = node.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      la.setSplitRatio(node.id, Math.min(0.85, Math.max(0.15, raw)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.classList.remove('v2-la-resizing');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = node.dir === 'row' ? 'col-resize' : 'row-resize';
    document.body.classList.add('v2-la-resizing');
  };
  return (
    <div ref={ref} className={`v2-la-split ${node.dir}`}>
      <div className="v2-la-split-a" style={{ flexBasis: `${node.ratio * 100}%` }}><PaneLayout la={la} node={node.a} /></div>
      <div className={`v2-la-divider ${node.dir}`} onPointerDown={onDown} />
      <div className="v2-la-split-b"><PaneLayout la={la} node={node.b} /></div>
    </div>
  );
};

/** 主区域：layout 非空 → 渲染分屏树；否则单窗（activeCwd）或欢迎页。
 *  把标签拖到任一窗格上即分裂该窗格（见 LocalAgentPane 的放置逻辑）。 */
export const LocalAgentConversation: React.FC<{ la: LocalAgentState }> = React.memo(({ la }) => {
  const { t: tr } = useI18n();
  const [over, setOver] = useState(false);

  // 主区跟随当前激活标签：激活的是分屏里的窗格 → 显示分屏；否则（未分组/未平铺标签）→ 单屏显示该会话。
  const activeInLayout = !!la.activeCwd && la.gridCwds.includes(la.activeCwd);
  if (la.layout && activeInLayout) {
    return <div className="v2-la-grid-root"><PaneLayout la={la} node={la.layout} /></div>;
  }
  if (la.activeCwd) {
    return <div className="v2-la-single"><LocalAgentPane la={la} cwd={la.activeCwd} /></div>;
  }
  // 欢迎页：还没有任何激活会话；拖标签到这里就把它打开。
  const onDragOver = (e: React.DragEvent) => { if (e.dataTransfer.types.includes('text/cwd')) { e.preventDefault(); setOver(true); } };
  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    const cwd = e.dataTransfer.getData('text/cwd');
    if (cwd) { e.preventDefault(); la.setActiveTab(cwd); }
  };
  return (
    <div className={`v2-la-single empty${over ? ' over' : ''}`} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="v2-la-tl">
        <div className="v2-la-welcome">
          <IconAgentCode />
          <h3>Local Agents</h3>
          <p>{tr('local.welcome.body')}</p>
          {!la.providers.some((p) => p.installed && p.live) && !la.detecting && (
            <p className="warn">{tr('local.welcome.noAgent')}</p>
          )}
          <button className="v2-la-pick" onClick={la.addProject}>{tr('local.welcome.start')}</button>
        </div>
      </div>
    </div>
  );
});
LocalAgentConversation.displayName = 'LocalAgentConversation';

/* ================================================================== *
 * 时间线区块：把消息折叠成块，并把 tool_use 与结果配对。
 * ================================================================== */
type Block =
  | { k: 'user'; text: string }
  | { k: 'text'; text: string }
  | { k: 'think'; text: string }
  | { k: 'tool'; name: string; input: any; id?: string; result?: string; isError?: boolean; pending: boolean; children?: Block[] };

/** 把消息折叠成块：tool_use↔tool_result 配对；子 agent(Task) 的块嵌进派生它的 Task.children。 */
function buildBlocks(msgs: TranscriptMessage[]): Block[] {
  const top: Block[] = [];
  const byId = new Map<string, Extract<Block, { k: 'tool' }>>();
  for (const m of msgs) {
    const parent = m.parentId || null;
    const sink = parent && byId.get(parent) ? (byId.get(parent)!.children ??= []) : top;
    for (const p of m.parts) {
      if (p.kind === 'text') {
        sink.push(m.role === 'user' ? { k: 'user', text: p.text } : { k: 'text', text: p.text });
      } else if (p.kind === 'thinking') {
        sink.push({ k: 'think', text: p.text });
      } else if (p.kind === 'tool_use') {
        const b: Extract<Block, { k: 'tool' }> = { k: 'tool', name: p.name, input: p.input, id: p.id, pending: true };
        sink.push(b);
        if (p.id) byId.set(p.id, b);   // 注册（含子 agent 的工具，供其 result 配对）
      } else if (p.kind === 'tool_result') {
        const b = p.toolUseId ? byId.get(p.toolUseId) : undefined;
        if (b) { b.result = p.text; b.isError = p.isError; b.pending = false; }
        else sink.push({ k: 'tool', name: 'result', input: undefined, result: p.text, isError: p.isError, pending: false });
      }
    }
  }
  return top;
}

/** 折成轮次：user → 一轮右侧气泡；连续 agent 块 → 一轮左侧带头像。 */
type AgentBlock = Exclude<Block, { k: 'user' }>;
type Turn =
  | { role: 'user'; text: string }
  | { role: 'agent'; blocks: AgentBlock[]; streaming?: boolean };

function groupTurns(blocks: Block[], streamingTail: boolean): Turn[] {
  const turns: Turn[] = [];
  for (const b of blocks) {
    if (b.k === 'user') { turns.push({ role: 'user', text: b.text }); continue; }
    const last = turns[turns.length - 1];
    if (last && last.role === 'agent') last.blocks.push(b);
    else turns.push({ role: 'agent', blocks: [b] });
  }
  if (streamingTail) {
    const last = turns[turns.length - 1];
    if (last && last.role === 'agent') last.streaming = true;
  }
  return turns;
}

/* 用户轮：右侧、柔色气泡——和主聊天的 user 气泡同一语言，一眼分得清。 */
const UserTurn: React.FC<{ text: string }> = React.memo(({ text }) => (
  <div className="v2-la-turn user">
    <div className="v2-la-ubub"><p>{text}</p></div>
  </div>
));
UserTurn.displayName = 'UserTurn';

/* agent 轮：左侧、provider 头像锚定身份，正文是裸排版散文（同主聊天 assistant），
   工具/思考是安静的卡片。 */
const TURN_CAP = 30;
const isSubagent = (b: AgentBlock) => b.k === 'tool' && ((b.name || '').toLowerCase() === 'task' || (b.children?.length ?? 0) > 0);

const AgentTurn: React.FC<{ blocks: AgentBlock[]; provider: string; streaming?: boolean; working?: boolean; tail?: string }> = React.memo(({ blocks, provider, streaming, working, tail }) => {
  const { t: tr } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const overflow = blocks.length - TURN_CAP;
  const shown = (showAll || overflow <= 0) ? blocks : blocks.slice(blocks.length - TURN_CAP);
  // 连续的子 agent(Task) 块并成一行 → 并行探索并排展示。
  const items: ({ row: AgentBlock[] } | { one: AgentBlock; i: number })[] = [];
  shown.forEach((b, i) => {
    if (isSubagent(b)) {
      const last = items[items.length - 1];
      if (last && 'row' in last) last.row.push(b);
      else items.push({ row: [b] });
    } else items.push({ one: b, i });
  });
  return (
    <div className="v2-la-turn agent">
      <div className={`v2-la-ava prov-${provider}`} title={PROVIDER_LABELS[provider] || provider}><IconTerminal /></div>
      <div className="v2-la-turn-body">
        {overflow > 0 && !showAll && (
          <button className="v2-la-earlier" onClick={() => setShowAll(true)}>{tr('local.turn.showEarlier', { n: overflow })}</button>
        )}
        {items.map((it, k) => (
          'row' in it
            ? (it.row.length > 1
                ? <div key={k} className="v2-la-subrow">{it.row.map((b, j) => <SubagentCard key={j} b={b as Extract<Block, { k: 'tool' }>} />)}</div>
                : <SubagentCard key={k} b={it.row[0] as Extract<Block, { k: 'tool' }>} />)
            : <AgentBlockView key={k} b={it.one} live={streaming && k === items.length - 1 && !tail} />
        ))}
        {/* 流式预览：只在「最后一条 agent 轮」上挂尾巴。打字机每帧仅本节点重渲，
            历史 AgentTurn 在 React.memo 下整体跳过 → 长会话不再因每字符全量重排。 */}
        {tail && <div className="v2-la-prose live"><MD text={tail} live /></div>}
        {/* 执行中始终在底部显示「寒暄」状态行：token 上下行动画 + 翻动的小词 + 计时（类 Claude CLI）。 */}
        {working && <RunningTicker />}
      </div>
    </div>
  );
});
AgentTurn.displayName = 'AgentTurn';

// 执行中状态行（仿 Claude CLI 的循环 gerund）：左侧 token「上下行」律动条 = 还在收发，
// 中间翻动的小词（换词即「还活着」的证据，几个带 落墨/誊写 的纸墨调性），右侧计时。
// 稳定 key 列表，文案在渲染处经 tr() 取——随语言切换即时变（别把翻译烤进常量）。
const TICKER_KEYS = [
  'local.ticker.0', 'local.ticker.1', 'local.ticker.2', 'local.ticker.3',
  'local.ticker.4', 'local.ticker.5', 'local.ticker.6', 'local.ticker.7',
  'local.ticker.8', 'local.ticker.9', 'local.ticker.10', 'local.ticker.11',
  'local.ticker.12', 'local.ticker.13', 'local.ticker.14', 'local.ticker.15',
];
function fmtElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const RunningTicker: React.FC = () => {
  const { t: tr } = useI18n();
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * TICKER_KEYS.length));
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    const word = window.setInterval(() => setIdx((x) => (x + 1) % TICKER_KEYS.length), 2600);
    const clock = window.setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000);
    return () => { window.clearInterval(word); window.clearInterval(clock); };
  }, []);
  return (
    <div className="v2-la-ticker" aria-live="polite">
      <span className="tok" aria-hidden><i /><i /><i /><i /></span>
      <span className="w" key={idx}>{tr(TICKER_KEYS[idx])}</span>
      {elapsed > 0 && <span className="m">{fmtElapsed(elapsed)}</span>}
    </div>
  );
};

// `live` = this is the actively-streaming tail block → show a blinking terminal
// caret so the stream always reads as alive (and visually distinct) even mid-token
// or right after switching back to its tab.
const AgentBlockView: React.FC<{ b: AgentBlock; live?: boolean }> = React.memo(({ b, live }) => {
  const { t: tr } = useI18n();
  if (b.k === 'think') {
    return (
      <details className="v2-la-think">
        <summary><span className="ic">✦</span>{tr('local.tool.thinking')}</summary>
        <div className="bd">{b.text}</div>
      </details>
    );
  }
  if (b.k === 'text') return <div className={`v2-la-prose${live ? ' live' : ''}`}><MD text={b.text} live={live} /></div>;
  return <ToolCard b={b} />;
});
AgentBlockView.displayName = 'AgentBlockView';

type ToolStatus = 'pending' | 'ok' | 'err';

/** 把一个 tool block 归一成：动词 + 细节(单行) + 可展开的正文。 */
function describeTool(b: Extract<Block, { k: 'tool' }>, tr: (key: string, vars?: Record<string, string | number>) => string): { verb: string; detail?: string; sub?: string; body: React.ReactNode } {
  const name = b.name || 'tool';
  const input = b.input || {};
  const lower = name.toLowerCase();
  if (lower === 'askuserquestion') {
    const qs = Array.isArray(input.questions) ? input.questions : [];
    return { verb: tr('local.tool.ask'), detail: qs[0]?.header || qs[0]?.question || '', body: b.result ? <OutBlock text={b.result} /> : null };
  }
  if (lower === 'bash') {
    return {
      verb: 'Bash', detail: input.description || firstLine(input.command),
      body: (
        <div className="v2-la-io">
          <div className="row"><span className="lbl">IN</span><code>{input.command || ''}</code></div>
          {b.result != null && <OutRow text={b.result} isError={b.isError} />}
        </div>
      ),
    };
  }
  if (lower === 'edit' || lower === 'write' || lower === 'multiedit' || lower === 'notebookedit') {
    const file = input.file_path || input.notebook_path || '';
    const code = lower === 'write' ? (input.content || '')
      : lower === 'multiedit' ? (input.edits || []).map((e: any) => e.new_string).join('\n…\n')
        : (input.new_string ?? input.content ?? '');
    const verb = lower === 'write' ? 'Write' : lower === 'multiedit' ? 'MultiEdit' : 'Edit';
    const lines = code ? String(code).split('\n').length : 0;
    return { verb, detail: basename(file), sub: lines > 0 ? tr('local.tool.lines', { n: lines }) : undefined, body: code ? <CodePreview code={String(code)} lang={langOf(file)} /> : null };
  }
  if (lower === 'todowrite') {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return {
      verb: 'Todo', sub: tr('local.tool.items', { n: todos.length }),
      body: todos.length > 0 ? (
        <ul className="v2-la-todos">
          {todos.map((t: any, i: number) => (
            <li key={i} className={t.status}><span className="mk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>{t.content || t.activeForm || ''}</li>
          ))}
        </ul>
      ) : null,
    };
  }
  if (lower === 'read') return { verb: 'Read', detail: basename(input.file_path || ''), body: b.result ? <OutBlock text={b.result} /> : null };
  if (lower === 'grep') return { verb: 'Grep', detail: input.pattern || '', body: b.result ? <OutBlock text={b.result} /> : null };
  if (lower === 'glob') return { verb: 'Glob', detail: input.pattern || '', body: b.result ? <OutBlock text={b.result} /> : null };
  if (lower === 'task') return { verb: 'Task', detail: input.description || input.subagent_type || '', body: b.result ? <OutBlock text={b.result} /> : null };
  return { verb: name, detail: firstStr(input), body: b.result ? <OutBlock text={b.result} /> : null };
}

/** 子 agent（Task）卡片：一眼看出有子 agent + 跑了多少步；展开看其内部活动。 */
const SubagentCard: React.FC<{ b: Extract<Block, { k: 'tool' }> }> = ({ b }) => {
  const { t: tr } = useI18n();
  const input = b.input || {};
  const children = b.children || [];
  const steps = children.filter((c) => c.k === 'tool').length;
  const status: ToolStatus = b.pending ? 'pending' : b.isError ? 'err' : 'ok';
  const [open, setOpen] = useState(false);
  const label = input.description || input.subagent_type || tr('local.sub.exploreTask');
  const kids = children.filter((c) => c.k !== 'user');   // 子 agent 的提示词不当气泡显示
  // 最近一步的「当前在做什么」——不展开也能看到进度（运行中才显示）。
  const lastTool = [...children].reverse().find((c) => c.k === 'tool') as Extract<Block, { k: 'tool' }> | undefined;
  const liveStep = b.pending && lastTool
    ? `${lastTool.name}${stepDetail(lastTool) ? ' · ' + stepDetail(lastTool) : ''}`
    : '';
  return (
    <div className={`v2-la-sub${open ? ' open' : ''}`}>
      <div className="v2-la-sub-hd" onClick={() => setOpen((o) => !o)}>
        <span className={`v2-la-tdot ${status}`} />
        <span className="ic"><IconAgentCode /></span>
        <b>{tr('local.sub.title')}</b>
        <span className="lab">{label}</span>
        <span className="cnt">{b.pending ? tr('local.sub.runningSteps', { n: steps }) : tr('local.sub.steps', { n: steps })}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>
      {liveStep && !open && (
        <div className="v2-la-sub-live" title={liveStep}><span className="arr">→</span>{liveStep}</div>
      )}
      {open && (
        <div className="v2-la-sub-body">
          {kids.length === 0 && !b.result && <div className="v2-la-hint">{tr('local.sub.noSteps')}</div>}
          {kids.map((c, i) => <AgentBlockView key={i} b={c as AgentBlock} />)}
          {b.result != null && b.result.trim() !== '' && <div className="v2-la-io"><OutRow text={b.result} /></div>}
        </div>
      )}
    </div>
  );
};

/** 工具卡片：默认折叠成紧凑一行（状态点+动词+目标），点击展开正文。错误自动展开。 */
const ToolCard: React.FC<{ b: Extract<Block, { k: 'tool' }> }> = ({ b }) => {
  const { t: tr } = useI18n();
  const status: ToolStatus = b.pending ? 'pending' : (b.isError && (b.name || '').toLowerCase() !== 'askuserquestion') ? 'err' : 'ok';
  const [open, setOpen] = useState(status === 'err');   // 失败默认展开，其余折叠
  // Task / 任何带子活动的工具 → 子 agent 分组卡片
  if ((b.name || '').toLowerCase() === 'task' || (b.children && b.children.length > 0)) return <SubagentCard b={b} />;
  const { verb, detail, sub, body } = describeTool(b, tr);
  const hasBody = !!body;
  // 过程默认可见但「弱」：折叠态也在行内给一句结果预览，不必点开就能扫读。
  const preview = !open && b.result ? firstLine(b.result) : '';
  return (
    <div className={`v2-la-tool${open ? ' open' : ''}`}>
      <div className={`v2-la-tool-hd${hasBody ? ' clickable' : ''}`} onClick={hasBody ? () => setOpen((o) => !o) : undefined}>
        <span className={`v2-la-tdot ${status}`} />
        <b>{verb}</b>
        {detail && <code className="file">{detail}</code>}
        {sub && <span className="sub">{sub}</span>}
        {preview && <span className="prev">{preview}</span>}
        {hasBody && <span className="v2-la-tool-chev">{open ? '▾' : '▸'}</span>}
      </div>
      {open && hasBody && <div className="v2-la-tool-body">{body}</div>}
    </div>
  );
};

function firstLine(s?: string): string { return s ? String(s).split('\n')[0].slice(0, 80) : ''; }

/** 一句话概括某工具步骤（用于子 agent 的「当前在做什么」预览）。 */
function stepDetail(b: Extract<Block, { k: 'tool' }>): string {
  const i = b.input || {};
  const l = (b.name || '').toLowerCase();
  if (l === 'bash') return i.description || firstLine(i.command);
  if (l === 'read' || l === 'edit' || l === 'write' || l === 'multiedit') return basename(i.file_path || i.notebook_path || '');
  if (l === 'grep' || l === 'glob') return i.pattern || '';
  return firstStr(i);
}

/** 折叠态默认隐藏、展开后显示的纯输出块（Read/Grep/Task 等）。 */
const OutBlock: React.FC<{ text: string }> = ({ text }) => (
  <div className="v2-la-io"><OutRow text={text} /></div>
);

const OutRow: React.FC<{ text: string; isError?: boolean }> = ({ text, isError }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > 12 || text.length > 1200;
  const shown = open || !long ? text : lines.slice(0, 12).join('\n');
  return (
    <div className={`row out${isError ? ' err' : ''}`}>
      <span className="lbl">OUT</span>
      <div className="outbody">
        <pre>{shown || tr('local.out.empty')}</pre>
        {long && <button className="v2-la-more" onClick={() => setOpen((v) => !v)}>{open ? tr('local.out.collapse') : tr('local.out.expandLines', { n: lines.length })}</button>}
      </div>
    </div>
  );
};

const CodePreview: React.FC<{ code: string; lang: string }> = ({ code, lang }) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const lines = code.split('\n');
  const long = lines.length > 24;
  const shown = open || !long ? code : lines.slice(0, 24).join('\n');
  return (
    <div className="v2-la-code">
      <MD text={`\`\`\`${lang}\n${shown}\n\`\`\``} />
      {long && <button className="v2-la-more" onClick={() => setOpen((v) => !v)}>{open ? tr('local.out.collapse') : tr('local.out.expandLines', { n: lines.length })}</button>}
    </div>
  );
};

function langOf(file: string): string {
  const ext = (file.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust',
    json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', html: 'html',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', sql: 'sql', java: 'java', c: 'c', cpp: 'cpp', h: 'cpp',
    rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift', toml: 'ini',
  };
  return map[ext] || '';
}

function firstStr(input: any): string {
  if (!input || typeof input !== 'object') return '';
  for (const v of Object.values(input)) if (typeof v === 'string') return v.slice(0, 60);
  return '';
}

function fmtTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('local.time.justNow');
  if (diff < 3600_000) return t('local.time.minutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t('local.time.hours', { n: Math.floor(diff / 3600_000) });
  if (diff < 30 * 86400_000) return t('local.time.days', { n: Math.floor(diff / 86400_000) });
  if (diff < 365 * 86400_000) return t('local.time.months', { n: Math.floor(diff / (30 * 86400_000)) });
  return t('local.time.years', { n: Math.floor(diff / (365 * 86400_000)) });
}
