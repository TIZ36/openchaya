import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import './theme.css';
import { getDisplayName, setDisplayName } from '../services/configStore';
import KnowledgeView, { KbAccountContext, type KbAccount, KbListContext } from './KnowledgeView';
import type { ClientSettings, ColorTheme } from '../components/settingsTypes';
import SettingsModal from './SettingsModal';

const LS_SETTINGS = 'settings';
const DEFAULT_SETTINGS: ClientSettings = {
  font: 'default',
  // 简化后 glassZones 只承载「侧栏」这一可调项（空 = 侧栏不开玻璃）。输入框/菜单/
  // 抽屉/用户气泡的磨砂是 CSS 无条件常开，不再走 zone 开关。
  glassZones: [],
  glassIntensity: 'standard',
  enableToolCalling: true,
  handRule: true,
  cmdEnterToSend: true,
  showTokenCost: false,
  autoTTS: false,
  ragEnabled: false,
  ragTopK: 5,
  ragScope: 'auto',
  chatStreamSmooth: true,
  chatStreamSpeed: 'normal',
  cliStreamSmooth: true,
  cliStreamSpeed: 'normal',
};
import { useI18n, t } from '../i18n';
import {
  IconGear, IconKB, IconTerminal, IconFbot,
  IconPlus, IconSidebar,
} from './icons';
import { LocalAgentTree, LocalAgentConversation, ForeignPaneContext, ProviderRail, ProviderLogo, PROVIDER_LABELS, AgentAskController, AgentMemoryController, AgentSummonReportController } from './LocalAgentView';
import { AgentsManagerHost } from './AgentsManager';
import { SessionBridgePanel } from './SessionBridgePanel';
import { getAsks, onAsksChange } from './services/sessionBridge';
import { useLocalAgent, realDir } from './useLocalAgent';
import { CodeEditorLayer } from './CodeEditorLayer';
import { JotDrawer } from './JotPanel';
import { CronDrawer } from './CronPanel';
import { InspectorColumn } from './InspectorColumn';
import { isLocalAgentAvailable, type ProviderId } from './services/localAgent';
import { isFbotAvailable, fbot, type SpecData } from './services/fbot';
import { shouldAutoDispatch, dispatchSubmission } from './services/fbotDispatch';
import FbotView, { FbotProvider, FbotSidebar } from './FbotView';
import { TopTabs } from './TopTabs';
import {
  useTopTabs, localTabId, KB_TAB_ID,
  type TopTab,
} from './useTopTabs';

type NavKey = 'kb' | 'local' | 'fbot';

// 登录不再是进入 app 的前置门禁：直接进主界面。本地功能（Local CLI 等）免登录可用，
// 访问云端功能时再「按需」提示登录（见 ShellInner 的 authed / requireLogin）。
const ClientShell: React.FC = () => <ShellInner />;

const ShellInner: React.FC = () => {
  const { t: tr } = useI18n();
  // Settings are read before useChatBackend so the chat typewriter config can be
  // passed in. Persisted to localStorage by the effect further down.
  const [settings, setSettings] = useState<ClientSettings>(() => {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });

  // 纯客户端：无服务器、无登录。authed 恒为 false（仅用于隐藏遗留的云端 UI 分支）。
  const authed = false;
  // 称呼引导：首启没填过称呼就弹一次（无账号，仅为个性化）。
  const [nameOpen, setNameOpen] = useState<boolean>(() => !getDisplayName());

  // 纯客户端：本地 CLI agent 是唯一聊天面，默认落到本地视图。
  const [activeNav, setActiveNav] = useState<NavKey>('local');
  // keep-alive：记录访问过的功能视图。重的视图（kb/gallery/cli）首次进入后常驻
  // （切走时 hidden 而非卸载），切回不再整树重挂 → 切换不卡。
  const [visitedNav, setVisitedNav] = useState<Set<NavKey>>(() => new Set([activeNav]));
  useEffect(() => {
    setVisitedNav((prev) => (prev.has(activeNav) ? prev : new Set(prev).add(activeNav)));
  }, [activeNav]);
  // 「代码改动」右侧检视列（仅 code 视图）：与 wiki 抽屉互斥，共用 inspector-slot。
  const [editorOpen, setEditorOpen] = useState(false);
  // 固定引用：CodeEditorLayer 是 memo 组件，inline 箭头会让 memo 失效（每次渲染换新引用）。
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  // wiki 抽屉开关也移到右上角（与代码列同区）：状态由激活窗格的 WikiNotes 回报，这里只做镜像 + 触发。
  const [wikiOpen, setWikiOpen] = useState(false);
  // 速记抽屉（KV 速记，全局本地存）：独立开关，与代码改动/wiki 并列于检视列。
  const [jotOpen, setJotOpen] = useState(false);
  const closeJot = useCallback(() => setJotOpen(false), []);
  // 定时任务抽屉（provider 无关，扫 OS crontab）：独立开关，与代码改动/wiki/速记 并列于检视列。
  const [cronOpen, setCronOpen] = useState(false);
  const closeCron = useCallback(() => setCronOpen(false), []);
  // 轻量全局 toast：任意处 dispatch `chaya:toast` {text} 即弹一条短提示（如「会话已绑定 Agent」）。
  const [toast, setToast] = useState('');
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (!text) return;
      setToast(String(text));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(''), 4200);
    };
    window.addEventListener('chaya:toast', on as EventListener);
    return () => { window.clearTimeout(timer); window.removeEventListener('chaya:toast', on as EventListener); };
  }, []);
  useEffect(() => {
    const onWikiState = (e: Event) => { const d = (e as CustomEvent).detail; if (d?.active) setWikiOpen(!!d.open); };
    window.addEventListener('chaya:wiki-open', onWikiState as EventListener);
    return () => window.removeEventListener('chaya:wiki-open', onWikiState as EventListener);
  }, []);
  // 「会话互问」右侧检视列：与 wiki/代码列共用第二列。作为右栏书签可点开/收起；新提问发起时
  // 自动展开。订阅 sessionBridge 的提问数，决定书签是否出现 + 自动展开。
  const bridgeAsks = useSyncExternalStore(onAsksChange, getAsks, getAsks);
  const bridgeCount = bridgeAsks.length;
  const [bridgeOpen, setBridgeOpen] = useState(false);
  // 初值=挂载时的数量（含从快照恢复的历史），这样「恢复历史」不会在启动时误触自动展开。
  const prevBridgeCount = useRef(bridgeCount);
  // 收起 wiki + 代码列（让出第二列给互问列，避免叠盖）。wiki-toggle{open:false} 幂等。
  const closeInspectors = useCallback(() => {
    setEditorOpen(false);
    setWikiOpen(false);
    setJotOpen(false);
    setCronOpen(false);
    window.dispatchEvent(new CustomEvent('chaya:wiki-toggle', { detail: { open: false } }));
  }, []);
  useEffect(() => {
    // 不变量：绝不抢视口。只有用户没在看检视栏(wiki/code)时才自动展开互问/召唤列；否则只更新
    // 书签计数(badge)，等用户主动点开——修旧版「新提问就强关你正在看的检视栏」的不可控行为。
    if (bridgeCount > prevBridgeCount.current && !editorOpen && !wikiOpen) setBridgeOpen(true);
    prevBridgeCount.current = bridgeCount;
  }, [bridgeCount, editorOpen, wikiOpen]);
  // 「管理本地 Agent」(左树 Agents ★)：用户主动打开 Agent 面板（占用第二列，可关检视栏）。
  useEffect(() => {
    const on = () => { closeInspectors(); setBridgeOpen(true); };
    window.addEventListener('chaya:openAgents', on as EventListener);
    return () => window.removeEventListener('chaya:openAgents', on as EventListener);
  }, [closeInspectors]);
  useEffect(() => {
    if (activeNav !== 'local') {
      setEditorOpen(false);
      if (wikiOpen) { window.dispatchEvent(new CustomEvent('chaya:wiki-toggle', { detail: { open: false } })); setWikiOpen(false); }
    }
  }, [activeNav]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 纯客户端：无服务器、无登录 —— 不再弹登录提示。
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  // 全局事件：任意视图（如输入框「管理技能」）派发 chaya:openSettings{section} → 打开设置并滚到该分组。
  useEffect(() => {
    const onOpen = (e: Event) => {
      const sec = (e as CustomEvent).detail?.section as string | undefined;
      setSettingsSection(sec);
      setSettingsOpen(true);
    };
    window.addEventListener('chaya:openSettings', onOpen as EventListener);
    return () => window.removeEventListener('chaya:openSettings', onOpen as EventListener);
  }, []);
  // 知识库视图侧栏对 kb 收起 → 账号入口改由 KB rail 底部承载（经 KbAccountContext 注入）。
  const kbAccount = useMemo<KbAccount>(() => ({
    authed,
    name: userName(),
    initials: userInitials(),
    online: false,
    onOpen: () => setSettingsOpen(true),
  }), [authed]);
  // KB 停靠列表栏开合（提到 shell，使顶栏右上角折叠按钮也能驱动）。
  const [kbListOpen, setKbListOpen] = useState(true);   // 知识库默认展开左树（CLI 风格常驻两栏）
  const kbListCtx = useMemo(() => ({ open: kbListOpen, setOpen: setKbListOpen }), [kbListOpen]);

  useEffect(() => {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch { /* ignore */ }
    document.documentElement.setAttribute('data-font', settings.font);
  }, [settings]);

  // Local Agents（纯本地，与后端无关）：状态上提，侧栏树 + 主区对话共享。
  // provider 由设置决定；探测惰性触发（进入该 nav 才 detect，配合 loading 动画）。
  // typewriter 与 chat 共用一套设置 —— 用户期望"AI 输出体感"是统一的、跨 闲聊
  // / agent对话 / Local Agents 一致；分两套节奏让用户在三个面板间感觉割裂。
  // 旧字段 cliStreamSmooth/Speed 保留在 settings 类型里只为向后兼容，不再读。
  const la = useLocalAgent(activeNav === 'local', settings.localAgentProvider ?? 'claude', {
    enabled: settings.chatStreamSmooth ?? true,
    speed: settings.chatStreamSpeed ?? 'normal',
  });

  // Agent 换绑「绑定新会话」：在目标目录+provider 起一个新空会话；其首轮 init 拿到 id 后
  // 由 useLocalAgent 的待绑捕获回填给该 agent（见 takePendingBind）。挂在 la 初始化之后。
  // 用 ref 持有 la，listener 只订阅一次（ClientShell 每个 stream chunk 都重渲，避免反复增删监听）。
  const laRef = useRef(la); laRef.current = la;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { provider?: string; dir?: string };
      if (!d?.dir) return;
      const cur = laRef.current;
      const prov = (d.provider as ProviderId) || 'claude';
      if (prov !== cur.activeProvider) cur.switchActiveProvider(prov);
      cur.newSession(d.dir, undefined, prov);
    };
    window.addEventListener('chaya:bindNewSession', on as EventListener);
    return () => window.removeEventListener('chaya:bindNewSession', on as EventListener);
  }, []);

  // 全局 topbar tab 条：跨 Local / Chat / Gallery / KB。activeId 同步自现有状态机，
  // 这里只持有「打开了哪些 + 每条的未读/批准信号」。
  const topTabs = useTopTabs();

  // ----- 镜像：把 la.tabs 同步成 TopTabs 中的 local 类 tab（来源唯一 = useLocalAgent）。
  //   关键性能点：la.tabs 的引用在每个 stream chunk 都会变（liveMsgs 增长），
  //   但「这条 tab 在 topbar 上长什么样」只受 cwd / title / groupId / 项目名 影响。
  //   用结构指纹作为 dep，effect 只在真正结构变化时跑一次。
  const localTabsFingerprint = la.tabs.map((t) => `${t.cwd}|${t.title}|${t.groupId ?? ''}|${t.provider}`).join('§');
  const projectsFingerprint = la.projects.map((p) => `${p.path}|${p.name ?? ''}`).join('§');
  useEffect(() => {
    la.tabs.forEach((t) => {
      const proj = la.projects.find((p) => p.path === t.cwd);
      const label = proj?.name || t.title || t.cwd.split('/').pop() || t.cwd;
      topTabs.add({
        id: localTabId(t.cwd),
        kind: 'local',
        label,
        cwd: t.cwd,
        provider: t.provider,
      });
    });
    const live = new Set(la.tabs.map((t) => localTabId(t.cwd)));
    topTabs.tabs
      .filter((tt) => tt.kind === 'local' && !live.has(tt.id))
      .forEach((tt) => { topTabs.remove(tt.id); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localTabsFingerprint, projectsFingerprint]);

  // ----- attn / unread 信号：与上面同理，只看会触发信号变化的字段。
  //   messages.length 仅在 stream 落库时变化（liveMsgs 不算），所以指纹包含 length
  //   不会因 token 流而过度触发。
  const lastMsgCountRef = useRef<Record<string, number>>({});
  const signalsFingerprint = la.tabs.map((t) => `${t.cwd}:${t.messages.length}:${t.perm ? 1 : 0}:${t.question ? 1 : 0}`).join('§');
  useEffect(() => {
    la.tabs.forEach((t) => {
      const id = localTabId(t.cwd);
      const attn = !!(t.perm || t.question);
      topTabs.setAttn(id, attn);
      const prev = lastMsgCountRef.current[t.cwd] ?? t.messages.length;
      if (t.messages.length > prev && t.cwd !== la.activeCwd) topTabs.markUnread(id);
      lastMsgCountRef.current[t.cwd] = t.messages.length;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalsFingerprint, la.activeCwd]);

  // ----- 发起提问才置左：用户在某 local 会话发出消息时，把它对应的顶栏 tab 提到最左
  //   （点击 tab 本身不再 promote）。只认 lastSend.tick 变化，不随流式 chunk 抖动。
  useEffect(() => {
    const cwd = la.lastSend.cwd;
    if (cwd) topTabs.promote(localTabId(cwd));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [la.lastSend.tick]);

  // ----- 打开 / 激活 / 关闭。
  const openKBTab = useCallback(() => {
    topTabs.add({ id: KB_TAB_ID, kind: 'kb', label: tr('shell.nav.kb') });
    topTabs.setActiveId(KB_TAB_ID);
    setActiveNav('kb');
  }, [topTabs, tr]);

  // 固定到侧栏的 CLI tab 集合（按 cwd）——左栏 pin 行与内联 CLI 条共用：
  // 内联条据此隐藏，左栏据此常驻。CLI 为本地能力，不受 authed 门禁。
  const pinnedLocalCwds = useMemo(
    () => new Set(topTabs.tabs.filter((t) => t.pinned && t.kind === 'local' && t.cwd).map((t) => t.cwd as string)),
    [topTabs.tabs],
  );

  const activateTopTab = useCallback((t: TopTab) => {
    topTabs.setActiveId(t.id);
    topTabs.clearUnread(t.id);
    // 点击 tab 只聚焦、不置左（求稳：tab 不再因点击而跳位）。置左改由「发起提问」触发，
    // 见下方监听 la.lastSend 的 effect。非 local 类（kb）仍可点击即提左。
    if (t.kind !== 'local') topTabs.promote(t.id);

    if (t.kind === 'kb') setActiveNav('kb');
    else if (t.kind === 'local' && t.cwd) {
      setActiveNav('local');
      la.setActiveTab(t.cwd);
    }
  }, [topTabs, la]);

  // 分屏里异类窗格的渲染器（见 ForeignPaneContext）：wiki → 知识库（自包含/无流式）。
  const renderForeignPane = useCallback((id: string): React.ReactNode => {
    if (id === 'wiki') return <KnowledgeViewPane />;
    return null;
  }, []);

  const closeTopTab = useCallback((t: TopTab) => {
    if (t.kind === 'local' && t.cwd) {
      la.closeTab(t.cwd);   // 镜像 effect 会同步移除 topTabs 里的 entry
      return;
    }
    const wasActive = topTabs.activeId === t.id;
    const idx = topTabs.tabs.findIndex((x) => x.id === t.id);
    const remaining = topTabs.tabs.filter((x) => x.id !== t.id);
    topTabs.remove(t.id);
    if (wasActive) {
      const nextTab = remaining[Math.max(0, idx - 1)] ?? remaining[0];
      if (nextTab) activateTopTab(nextTab);
      else setActiveNav('local');
    }
  }, [la, topTabs, activateTopTab]);

  // ----- 同步 activeId：外部状态机变化时把 topTabs.activeId 拉到位。
  useEffect(() => {
    let id: string | null = null;
    if (activeNav === 'kb') id = KB_TAB_ID;
    else if (activeNav === 'local' && la.activeCwd) id = localTabId(la.activeCwd);
    if (id !== topTabs.activeId) topTabs.setActiveId(id);
    if (id) topTabs.clearUnread(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, la.activeCwd]);

  // 明暗策略：Pure(codex) 是我们自己的配色，支持 浅/深/自动 三态(settings.appearance)；
  // 自动 = 跟随 macOS 外观实时切换。其它都是品牌「联动主题」，只有一种固定配色：
  //   anthropic = 固定 light · razer = 固定 dark(纯黑)。
  // 退役主题(warm/linear/cursor/xcode/default…)统一规整回 anthropic。
  const rawTheme = settings.theme ?? 'codex';   // 默认主题 = Pure
  const theme: ColorTheme = (
    (rawTheme as string) === 'warm' ||
    (rawTheme as string) === 'linear' ||
    (rawTheme as string) === 'midnight' ||
    (rawTheme as string) === 'cursor' ||
    (rawTheme as string) === 'xcode' ||
    (rawTheme as string) === 'default'
  ) ? 'anthropic' : rawTheme;

  // 系统外观跟随：matchMedia 在浏览器/Electron 渲染层都能实时反映 OS（Electron 下
  // 由 nativeTheme.themeSource 驱动，见下方桥接 effect），切换 macOS 明暗会即时回调。
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  // Pure 的明暗：浅/深 直选，自动(system) 跟随 systemDark；默认 dark(保持既有观感)。
  const pureAppearance = settings.appearance ?? 'dark';
  const resolvedMode: 'light' | 'dark' =
    theme === 'anthropic' ? 'light'
    : theme === 'razer' ? 'dark'
    : (pureAppearance === 'system' ? (systemDark ? 'dark' : 'light') : pureAppearance);

  // Electron 原生外观桥：把目标外观推给主进程的 nativeTheme.themeSource。
  // 这一步同时解决两件事——① 渲染层 prefers-color-scheme 跟着走(自动模式实时切换)；
  // ② 窗口 under-window vibrancy 的明暗也跟着走，避免「浅色 CSS 罩在暗色毛玻璃上发灰」。
  useEffect(() => {
    const ap = (window as any).chateeElectron?.appearance;
    if (!ap?.set) return;
    // Pure 自动 → 'system'(交回 OS)；其余(含 Pure 浅/深、anthropic、razer) → 锁定具体明暗。
    ap.set(theme === 'codex' && pureAppearance === 'system' ? 'system' : resolvedMode);
  }, [theme, pureAppearance, resolvedMode]);

  // Frosted glass: per-zone toggles + global intensity. CSS matches each zone
  // via [data-glass~="<zone>"]. Sidebar/topbar vibrancy only reads when there's
  // a tinted backdrop behind the blur, so auto-append "ambient" when either is on.
  const glassZones = settings.glassZones ?? ['composer', 'menu', 'modal'];
  const glassIntensity = settings.glassIntensity ?? 'standard';
  const glassAttr = (
    glassZones.some((z) => z === 'sidebar' || z === 'topbar' || z === 'main')
      ? [...glassZones, 'ambient']
      : glassZones
  ).join(' ');

  const updateSettings = useCallback((patch: Partial<ClientSettings>) => {
    setSettings((p) => ({ ...p, ...patch }));
  }, []);
  // 直接切到指定 provider（供 composer 里的常规选择框用；底层仍是同一份 settings）。
  const setLocalAgentProvider = useCallback((id: ProviderId) => {
    setSettings((p) => (p.localAgentProvider === id ? p : { ...p, localAgentProvider: id }));
  }, []);
  // LocalAgentTree.onEnter 必须稳定，否则它的 React.memo 在 ShellInner 每次重渲时都失效。
  const enterLocal = useCallback(() => setActiveNav('local'), []);
  // 飞书录入助手：纯本地桌面功能，免登录（同 local）。
  const enterFbot = useCallback(() => setActiveNav('fbot'), []);
  // 飞书提单 → 本地 CLI 自动派发：应用层监听，与当前是否停在飞书页无关；
  // 只对配了 agent 路由且 trigger=auto 的表单生效（手动派发在 FbotView 提交记录里点）。
  useEffect(() => {
    if (!isFbotAvailable()) return;
    let spec: SpecData | null = null;
    void fbot.getSpec().then((s) => { if (s) spec = s; });
    return fbot.onEvent((e) => {
      if (e.type === 'spec') spec = { menu: e.menu, forms: e.forms };
      else if (e.type === 'submission') {
        const form = spec?.forms[e.item.formKey];
        if (shouldAutoDispatch(e.item, form)) void dispatchSubmission(e.item, form);
      }
    });
  }, []);

  return (
    <FbotProvider>
    <div className="chaya-v2" data-mode={resolvedMode} data-theme={theme} data-glass={glassAttr} data-glass-i={glassIntensity}>
      {/* L0 底层壁纸：固定铺满、置于内容之后（Pure 三层结构的最底层透明玻璃面） */}
      <div id="v2-wall" aria-hidden />
      {toast && <div className="v2-global-toast" role="status">{toast}</div>}
      {/* ===== 全宽统一顶栏：红绿灯 + 图标导航 + 置顶 + tab + 折叠，全在这一行（跨整窗宽） ===== */}
      <div className="v2-titlebar">
        <div className="v2-dots" aria-hidden><i /><i /><i /></div>
        <nav className="v2-tnav">
          {/* 纯客户端：云端 chat / gallery 随服务器退役，已从导航移除；本地 CLI agent 即聊天面。 */}
          {isLocalAgentAvailable() && (
            <button
              className={`v2-pin v2-pin-fn${activeNav === 'local' ? ' active' : ''}`}
              title={tr('shell.nav.localCli')} aria-label={tr('shell.nav.localCli')}
              onClick={enterLocal}
            ><IconTerminal /><span className="lb">code</span></button>
          )}
          <button
            className={`v2-pin v2-pin-fn${activeNav === 'kb' ? ' active' : ''}`}
            title={tr('shell.nav.kb')} aria-label={tr('shell.nav.kb')}
            onClick={() => openKBTab()}
          ><IconKB /><span className="lb">wiki</span></button>
          {isFbotAvailable() && (
            <button
              className={`v2-pin v2-pin-fn${activeNav === 'fbot' ? ' active' : ''}`}
              title="飞书录入助手" aria-label="飞书录入助手"
              onClick={enterFbot}
            ><IconFbot /><span className="lb">feishu</span></button>
          )}
        </nav>
        <span className="v2-tnav-sep" aria-hidden />
        {/* 自定义置顶（pin）—— 与 tab 同处一行 */}
        <div className="v2-tpins">
          {topTabs.tabs.filter((t) => t.pinned && (t.kind === 'local' || authed)).map((t) => {
            const typeKey = t.kind === 'chat' && (t.isPrimary || t.sessionType === 'agent') ? 'agent' : t.kind;
            const ch = (Array.from((t.label || '').trim())[0] || '·').toUpperCase();
            return (
              <button
                key={t.id}
                className={`v2-pin v2-pin-chip${topTabs.activeId === t.id ? ' active' : ''}${t.attn ? ' attn' : ''}`}
                data-kind={typeKey}
                title={tr('tabs.pinnedTitle', { label: t.label })}
                aria-label={t.label}
                onClick={() => activateTopTab(t)}
                onContextMenu={(e) => { e.preventDefault(); topTabs.togglePin(t.id); }}
              >
                <span className="ch" aria-hidden>{ch}</span>
                {t.unread && topTabs.activeId !== t.id && <span className="dot" aria-hidden />}
                {t.attn && <span className="attn-mark" aria-hidden>!</span>}
              </button>
            );
          })}
        </div>
        {/* 打开的 tab —— 占满顶栏剩余宽度、自身横向滚动 */}
        <TopTabs
          la={la}
          tabs={authed ? topTabs.tabs : topTabs.tabs.filter((t) => t.kind === 'local')}
          activeNav={activeNav}
          activeId={topTabs.activeId}
          onActivate={activateTopTab}
          onClose={closeTopTab}
          onTogglePin={(t) => topTabs.togglePin(t.id)}
          pinnedLocalCwds={pinnedLocalCwds}
          onLocalTogglePin={(cwd) => topTabs.togglePin(localTabId(cwd))}
        />
        {/* code 视图的 wiki 笔记 / 代码改动开关已移到右侧 provider 书签栏底部（反向书签，见 ProviderRail footer）。 */}
        {/* 顶栏全局运行指示已移除：运行中会话数只在右侧 provider 书签栏的计数气泡上显示，单一来源不重复。 */}
        {/* 知识库下侧栏本就收起，此按钮改为「展开/收起 KB 停靠列表栏」（复用同一个右上角按钮）。 */}
        {activeNav === 'kb' ? (
          <button
            className={`v2-pin v2-titlebar-collapse${kbListOpen ? ' active' : ''}`}
            title={tr(kbListOpen ? 'shell.collapseSidebar' : 'shell.expandSidebar')}
            aria-label={tr(kbListOpen ? 'shell.collapseSidebar' : 'shell.expandSidebar')}
            onClick={() => setKbListOpen((o) => !o)}
          ><IconSidebar /></button>
        ) : (
          <button
            className="v2-pin v2-titlebar-collapse"
            title={tr(collapsed ? 'shell.expandSidebar' : 'shell.collapseSidebar')}
            aria-label={tr(collapsed ? 'shell.expandSidebar' : 'shell.collapseSidebar')}
            onClick={() => setCollapsed((c) => !c)}
          ><IconSidebar /></button>
        )}
        {/* 常驻拖窗手柄：顶栏被 tab/按钮占满后没有空白可拖窗，这里固定留一小块可长按拖拽区。 */}
        <div className="v2-titlebar-drag" title={tr('shell.dragWindow')} aria-label={tr('shell.dragWindow')}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
            <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
            <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
            <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
          </svg>
        </div>
      </div>

      <div className={`v2-app${collapsed ? ' collapsed' : ''}`} data-nav={activeNav}>
        {/* ===== 功能轨（图标+文字）：唯一一层全局导航。点一个功能 → 右侧是该功能自己的
             「列表 + 内容」（见 view-frame 里的 v2-feat），不再出现两层侧栏。 ===== */}
        {/* ===== 统一侧栏：icon+文字横排导航 + 当前功能列表 + 底部账号，单栏同底色；
             白卡片只裹右侧内容（对话 / 画廊 / 知识库）。 ===== */}
        <aside className="v2-side v2-sidebar">
          {/* 文字导航已移除——顶栏图标导航是唯一一层（对齐原型「单层导航」）。
              此处只留当前栏目标题，给下方列表一个语境（对齐原型 .list-hd）。 */}
          {/* 顶部留一抹极简风格栏（功能名已在顶栏胶囊；CLI 的 provider 改放到「打开新项目」右侧）。 */}
          <div className="v2-side-hd v2-style-bar" data-style="mini" />

          {/* 子目录列表随顶部主功能切换（参考 design 的 .sb-list 面板切换）：
              对话 → Agents + Chats · CLI → Projects · 知识库 → Wikis · 画廊 → 相册。 */}
          <div className="v2-side-list">
            {/* CLI：基础动作行（打开新项目 + 右侧 provider 切换，紧凑、大图标）置顶 + 项目树 */}
            {activeNav === 'local' && isLocalAgentAvailable() && (
              <>
                <div className="v2-cli-actionrow">
                  <button className="v2-side-action" onClick={() => { void la.addProject(); }}>
                    <IconPlus /><span>{tr('shell.cliNewProject')}</span>
                  </button>
                </div>
                <LocalAgentTree la={la} onEnter={enterLocal} />
              </>
            )}

            {/* 知识库改 Focus 布局：60px 图标栏 + 单文档画布 + Peek 浮层全部自包含在
                KnowledgeView 内（main 区），app 侧栏对 kb 收起（见 theme.css data-nav=kb）。
                不再 portal 树进侧栏槽位。 */}

            {/* 飞书助手：分区导航 + 提交列表（与 chat/CLI 同骨架） */}
            {activeNav === 'fbot' && isFbotAvailable() && <FbotSidebar />}
          </div>

          <button className="v2-railme" onClick={() => setSettingsOpen(true)} title={tr('shell.settings')}>
            <span className="v2-av">·</span>
            <span className="v2-railme-meta">
              <span className="n">{tr('shell.settings')}</span>
              <span className="s">{tr('shell.acct.localOnly')}</span>
            </span>
            <span className="lb"><IconGear /></span>
          </button>
        </aside>

        {/* ===== provider 书签栏：依附主卡左上角（侧栏与主卡之间），仅 code/local 视图。
             工作目录多 provider 共享，切书签 = 在当前活动目录换执行器（开新 session）。 ===== */}
        {activeNav === 'local' && isLocalAgentAvailable() && (
          <ProviderRail
            provider={la.activeProvider}
            providers={la.providers}
            runningByProvider={la.runningByProvider}
            attnByProvider={la.attnByProvider}
            doneByProvider={la.doneByProvider}
            onPick={(id) => { setLocalAgentProvider(id); la.switchActiveProvider(id); }}
            footer={<>
              <button
                type="button"
                className={`v2-prov-bm insp${wikiOpen ? ' active' : ''}`}
                title={tr('local.wiki.openTitle')}
                aria-label={tr('local.wiki.pill')}
                aria-pressed={wikiOpen}
                onClick={() => { setBridgeOpen(false); window.dispatchEvent(new CustomEvent('chaya:wiki-toggle')); }}
              >
                <span className="v2-prov-bm-glyph">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
                </span>
              </button>
              <button
                type="button"
                className={`v2-prov-bm insp${editorOpen ? ' active' : ''}`}
                title={tr('local.editor.openTitle')}
                aria-label={tr('local.editor.title')}
                aria-pressed={editorOpen}
                onClick={() => { setBridgeOpen(false); setEditorOpen((o) => !o); }}
              >
                <span className="v2-prov-bm-glyph">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
                </span>
              </button>
              {/* 速记：KV 速记抽屉（全局本地存）。独立开关，与代码改动/wiki 可并列。 */}
              <button
                type="button"
                className={`v2-prov-bm insp${jotOpen ? ' active' : ''}`}
                title={tr('jot.openTitle')}
                aria-label={tr('jot.tab')}
                aria-pressed={jotOpen}
                onClick={() => { setBridgeOpen(false); setJotOpen((o) => !o); }}
              >
                <span className="v2-prov-bm-glyph">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><path d="M9 7h7M9 11h5" /></svg>
                </span>
              </button>
              {/* 定时任务：provider 无关，扫 OS crontab（关终端/重启都跑）。独立开关，与代码改动/wiki/速记可并列。 */}
              <button
                type="button"
                className={`v2-prov-bm insp${cronOpen ? ' active' : ''}`}
                title={tr('cron.openTitle')}
                aria-label={tr('cron.tab')}
                aria-pressed={cronOpen}
                onClick={() => { setBridgeOpen(false); setCronOpen((o) => !o); }}
              >
                <span className="v2-prov-bm-glyph">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 14l2 2-2 2M13 18h4" /></svg>
                </span>
              </button>
              {/* Agents 书签：常驻（与 wiki/代码列互斥）；点开/收起 Agent 管理面板。有召唤进行中时带呼吸点。 */}
              <button
                type="button"
                className={`v2-prov-bm insp${bridgeOpen ? ' active' : ''}`}
                title="Agents"
                aria-label="Agents"
                aria-pressed={bridgeOpen}
                onClick={() => { if (!bridgeOpen) closeInspectors(); setBridgeOpen((o) => !o); }}
              >
                <span className="v2-prov-bm-glyph">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden><rect x="4.5" y="7.5" width="15" height="12" rx="3.4" /><path d="M12 7.5V4" /><circle cx="12" cy="3" r="1.4" /><path d="M2.6 12v3M21.4 12v3" /><path d="M9 13h.01M15 13h.01" /></svg>
                </span>
                {bridgeAsks.some((a) => a.phase === 'pending' || a.phase === 'running') && <span className="v2-prov-bm-dot" aria-hidden />}
              </button>
            </>}
          />
        )}

        {/* ===== main ===== 顶栏(tab/导航)已上移到全宽 .v2-titlebar；主卡只剩内容。 */}
        <main className="v2-main">
          {/* keep-alive：重的视图首访后常驻、用 hidden 切显隐（不再 key={activeNav} 整树
             重挂）。切换=切 CSS 显隐，瞬时；首访仍挂载一次。chat 是首页/较轻，仍走条件渲染。 */}
          <div className="v2-view-frame">
          <KbAccountContext.Provider value={kbAccount}>
          <KbListContext.Provider value={kbListCtx}>
          {visitedNav.has('kb') && (
            <div className="v2-view-slot" hidden={activeNav !== 'kb'}><KnowledgeViewKA /></div>
          )}
          {visitedNav.has('fbot') && (
            <div className="v2-view-slot" hidden={activeNav !== 'fbot'}><FbotViewKA /></div>
          )}
          {visitedNav.has('local') && (
            <div className="v2-view-slot" hidden={activeNav !== 'local'}>
              <div className="v2-feat">
                <div className="v2-feat-main">
                  {/* 分屏里的异类窗格由这里渲染：wiki → 知识库（自包含、无流式）。 */}
                  <ForeignPaneContext.Provider value={renderForeignPane}>
                    <LocalAgentConversation la={la} />
                  </ForeignPaneContext.Provider>
                  {/* 会话互问：agent 端控制器（ask_session 工具回传）+ 围观面板（portal 到 body）。 */}
                  <AgentAskController la={la} />
                  <AgentSummonReportController la={la} />
                  <AgentMemoryController />
                  <AgentsManagerHost />
                  <SessionBridgePanel
                    open={bridgeOpen && activeNav === 'local'}
                    dir={la.activeCwd ? realDir(la.activeCwd) : null}
                    onAdopt={(fromCwd, text) => { la.setActiveTab(fromCwd); la.appendDraft(fromCwd, text); }}
                    onOpenAgent={(a) => { if (a.provider !== la.activeProvider) la.switchActiveProvider(a.provider); void la.openSession(a.dir, a.sessionId, a.description || `@${a.name}`); }}
                    logo={(p) => <ProviderLogo id={p} mono />}
                    labelFor={(p) => PROVIDER_LABELS[p] || p}
                  />
                </div>
              </div>
            </div>
          )}

          </KbListContext.Provider>
          </KbAccountContext.Provider>
          </div>{/* /.v2-view-frame */}
        </main>

        {/* ===== inspector ===== grid 第二列（--insp-w 控宽）。上下分屏：代码改动在上、笔记在下，
             各自 portal 进 #v2-inspector-editor / #v2-inspector-note 子槽；默认等分、可拖、可各自关闭。 */}
        <InspectorColumn
          editorOpen={editorOpen && activeNav === 'local'}
          noteOpen={wikiOpen && activeNav === 'local'}
          jotOpen={jotOpen && activeNav === 'local'}
          cronOpen={cronOpen && activeNav === 'local'}
        />
        {/* 「代码改动」检视列：portal 进 inspector-slot，与 wiki 抽屉互斥（共用第二列）。 */}
        <CodeEditorLayer
          open={editorOpen && activeNav === 'local'}
          onClose={closeEditor}
          messages={la.messages}
          cwd={la.activeCwd ? realDir(la.activeCwd) : null}
          activeSessionId={la.activeSessionId}
          provider={settings.localAgentProvider ?? 'claude'}
          modelOptions={la.modelOptions}
          activeProvider={la.provider}
          onSendToChat={(text) => { if (la.activeCwd) la.appendDraft(la.activeCwd, text); }}
        />
        {/* 速记抽屉：portal 进 #v2-inspector-jot，独立开关（与代码改动/wiki 共用第二列）。 */}
        <JotDrawer
          open={jotOpen && activeNav === 'local'}
          onClose={closeJot}
          onSendToChat={(text) => { if (la.activeCwd) la.appendDraft(la.activeCwd, text); }}
        />
        {/* 定时任务抽屉：portal 进 #v2-inspector-cron，provider 无关（扫 OS crontab）。 */}
        <CronDrawer
          open={cronOpen && activeNav === 'local'}
          onClose={closeCron}
          onSendToChat={(text) => { if (la.activeCwd) la.appendDraft(la.activeCwd, text); }}
        />
      </div>


      {settingsOpen && (
        <SettingsModal
          settings={settings}
          updateSettings={updateSettings}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
          initialSection={settingsSection as any}
        />
      )}

      {nameOpen && <NamePrompt onDone={() => setNameOpen(false)} />}

    </div>
    </FbotProvider>
  );
};


/* ============== 称呼引导（首启，无账号） ============== */
const NamePrompt: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t: tr } = useI18n();
  const [val, setVal] = useState('');
  const save = () => { setDisplayName(val.trim()); onDone(); };
  return (
    <div className="v2-agent-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(); }}>
      <div className="v2-agent-modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-agent-modal-hd"><span>{tr('name.title')}</span></div>
        <div className="v2-agent-modal-bd">
          <p style={{ fontSize: 12.5, color: 'var(--c-ink-3)', lineHeight: 1.6, margin: '0 0 10px' }}>{tr('name.desc')}</p>
          <label><input autoFocus value={val} onChange={(e) => setVal(e.target.value)} placeholder={tr('name.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) save(); }} /></label>
        </div>
        <div className="v2-agent-modal-ft">
          <button className="ghost" onMouseDown={onDone}>{tr('name.skip')}</button>
          <button className="primary" disabled={!val.trim()} onMouseDown={save}>{tr('name.save')}</button>
        </div>
      </div>
    </div>
  );
};

/* ============== utils ============== */

function userName(): string {
  return getDisplayName() || t('shell.notSignedIn');
}
function userInitials(): string {
  const n = getDisplayName();
  if (!n) return '?';
  if (/[a-zA-Z]/.test(n[0])) {
    const parts = n.split(/[^a-zA-Z]/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || n[0].toUpperCase();
  }
  return n.slice(0, 1).toUpperCase();
}

// keep-alive 包装：无 props 的视图 memo 化，常驻挂载后不随 ClientShell 每次重渲；
// 只在自身内部状态变化时重渲。
const KnowledgeViewKA = React.memo(KnowledgeView);
const FbotViewKA = React.memo(FbotView);
// 分屏 wiki 窗格：standalone（自带左树、不抢主侧栏 portal 槽位），memo 避免随父重渲。
const KnowledgeViewPane = React.memo(() => <KnowledgeView standalone />);
KnowledgeViewPane.displayName = 'KnowledgeViewPane';

export default ClientShell;
