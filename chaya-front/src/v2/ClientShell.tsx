import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock, PreBlock, mdRehypePlugins } from './codeBlock';
import './theme.css';
import { api } from '../utils/apiClient';
import type { Session, Message } from '../services/chat';
import { useChatBackend } from './useChatBackend';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import KnowledgeView, { domainColor, KbAccountContext, type KbAccount, KbListContext } from './KnowledgeView';
import {
  smartnoteTags, smartnoteRetrieve, getSmartnoteApiKey, type Tag as DomainTag,
} from '../services/smartnoteApi';
import type { ClientSettings, ColorTheme } from '../components/SettingsPage';
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
import { useCreateMode, type RefImage, ASPECT_OPTIONS, COUNT_OPTIONS } from './useCreateMode';
import {
  BUILTIN_STYLES, loadCustomStyles, findPresetBySuffix,
  addCustomStyle, deleteCustomStyle, type StylePreset,
  syncCustomStylesFromBackend,
  getHiddenBuiltinIds, setHiddenBuiltinIds,
} from './stylePresets';
import LoginPage from './LoginPage';
import { useI18n, t } from '../i18n';
import {
  IconAgentCode, IconAgentDoc, IconAgentPainter, IconAgentPrimary,
  IconAttach, IconChat, IconTeahouse, IconGallery, IconGear, IconKB, IconTerminal, IconFbot,
  IconPlus, IconSend, IconSidebar,
  IconAspect, IconModel,
  IconEdit, IconRevert, IconQuote,
  IconCopy, IconCheck, IconDownload, IconTrash,
} from './icons';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { updateSessionLLMConfig, getSessionMessages } from '../services/chat';
import { updateRoleProfile } from '../services/roleApi';
import { mcpApi, type MCPServer } from '../services/integrationsApi';
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
  useTopTabs, localTabId, chatTabId, GALLERY_TAB_ID, KB_TAB_ID,
  type TopTab,
} from './useTopTabs';

type NavKey = 'chat' | 'gallery' | 'kb' | 'local' | 'fbot';
type Mode = 'chat' | 'create';

interface Batch {
  batchId: string;
  /** The conversation this batch belongs to. Batches are session-scoped:
   *  switching to another session must not bleed in-progress batches into
   *  the other surface. `null` means "no session" (rare). */
  sessionId: string | null;
  /** Raw user prompt (what they typed) — shown verbatim on the spec card. */
  promptDisplay: string;
  /** Snapshot of the creation config at the moment of send. */
  spec: {
    aspect: string;
    count: number;
    style: string;
    negative: string;
    refs: { id: string; data: string; mimeType: string; directive: string }[];
    /** Model selection at the moment of send — needed by "重新生成" so the
     *  rerun targets the same provider/model even if the user has switched
     *  models in between. Optional so historical batches still type-check. */
    configId?: string;
    model?: string;
    provider?: string;
  };
  slots: (string | null)[];
  errors: (string | null)[];
  pending: boolean;
  /** Wall-clock generation time in ms, set once the batch settles. */
  elapsedMs?: number;
  /** ms timestamp when generation started — used by the BatchView ticker to
   *  show "正在画 N 张 · 12s" while pending so users see progress, not a static
   *  shimmer. Absent on rows reloaded from DB (they're never pending). */
  startedAt?: number;
}

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

  // 登录是「按需」的：本地功能免登录可用；访问云端功能（聊天/画廊/知识库、发消息/生图）时才提示。
  const [authed, setAuthed] = useState<boolean>(() => api.isLoggedIn());
  const [loginOpen, setLoginOpen] = useState(false);
  const requireLogin = useCallback(() => setLoginOpen(true), []);

  const {
    loadingMeta, agents, recents, teahouses, activeSessionId, messages, stream, thinking,
    sending, wsState,
    setActiveSessionId, sendMessage, createTopicAndOpen, startTeahouseDraft,
    setTeahouseModel, reloadActiveMessages,
    renameSession, removeSession, refreshMeta, isTeahouseSession: isTeahouseSessionFn,
    quoted, quoteMessage, clearQuote, revertToMessage,
  } = useChatBackend({
    enabled: settings.chatStreamSmooth ?? true,
    speed: settings.chatStreamSpeed ?? 'normal',
  }, authed);

  /* ---- teahouse picker (choose llm_config + optional model) ---- */
  const [teahousePickerOpen, setTeahousePickerOpen] = useState(false);

  // 未登录且本地 CLI 可用 → 默认落到本地视图（免登录即可用）；否则默认聊天。
  const [activeNav, setActiveNav] = useState<NavKey>(() =>
    (!api.isLoggedIn() && isLocalAgentAvailable()) ? 'local' : 'chat');
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
  // 进入主界面后若未登录，温和提示一次登录（可关闭，不挡本地功能）。
  useEffect(() => { if (!api.isLoggedIn()) setLoginOpen(true); }, []);
  const [mode, setMode] = useState<Mode>('chat');
  const [draft, setDraft] = useState<string>('');
  const [batches, setBatches] = useState<Batch[]>([]);
  // Batches whose assistant images we've already persisted — guards against a
  // double POST leaving duplicate image messages in the conversation.
  const persistedBatchRef = useRef<Set<string>>(new Set());
  const [generating, setGenerating] = useState(false);
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
    online: wsState === 'open',
    onOpen: () => { if (authed) setSettingsOpen(true); else requireLogin(); },
  }), [authed, wsState, requireLogin]);
  // KB 停靠列表栏开合（提到 shell，使顶栏右上角折叠按钮也能驱动）。
  const [kbListOpen, setKbListOpen] = useState(true);   // 知识库默认展开左树（CLI 风格常驻两栏）
  const kbListCtx = useMemo(() => ({ open: kbListOpen, setOpen: setKbListOpen }), [kbListOpen]);
  const [rowMenu, setRowMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [agentSettingsFor, setAgentSettingsFor] = useState<Session | null>(null);
  /** Full-screen lightbox for any chat image (persisted or live-batch). */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  /** "创作配方" 详情弹框 —— 点击 spec 气泡触发；只读，配套外部已有的重生入口。 */
  const [specDetail, setSpecDetail] = useState<Batch | null>(null);
  /** Pending destructive confirm for 回退 / 回退并编辑 (both rewind history). */
  const [confirmRewind, setConfirmRewind] = useState<{ kind: 'revert' | 'edit' | 'rerun'; m: Message } | null>(null);

  /* ---- knowledge domains (@提及): smartnote workspace tags ---- */
  const [domains, setDomains] = useState<DomainTag[]>([]);
  // Domains the user @-attached for the NEXT send; their knowledge is retrieved
  // and injected as ext.knowledge, then cleared after sending.
  const [pickedDomains, setPickedDomains] = useState<string[]>([]);
  // @mention autocomplete popover: open + current query + caret token span.
  const [mention, setMention] = useState<{ query: string; from: number; to: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const loadDomains = useCallback(() => {
    if (!getSmartnoteApiKey()) { setDomains([]); return; }
    setDomainsLoading(true);
    smartnoteTags.list()
      .then((t) => setDomains(t || []))
      .catch(() => {})
      .finally(() => setDomainsLoading(false));
  }, []);
  // Reload domains on mount, when settings close, and when returning to a chat
  // view — so a domain just created in 知识库 is @-mentionable without a restart.
  useEffect(() => { loadDomains(); }, [loadDomains, settingsOpen, activeNav]);

  // chat-mode attachments (images sent inline with the next user message)
  const [attachments, setAttachments] = useState<Array<{ id: string; data: string; mimeType: string; fileName?: string }>>([]);
  const addAttachmentFile = useCallback(async (f: File) => {
    if (!f.type.startsWith('image/')) return;
    const b64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ''); const i = s.indexOf('base64,'); resolve(i >= 0 ? s.slice(i + 7) : s); };
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    setAttachments((xs) => [...xs, { id: `att-${Date.now()}-${xs.length}`, data: b64, mimeType: f.type, fileName: f.name }]);
  }, []);
  const removeAttachment = (id: string) => setAttachments((xs) => xs.filter((x) => x.id !== id));

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
  // 侧栏点击 chat / agent 会话 → 加到 topTabs（重复点击会被 topTabs.add 的短路过滤掉）
  // + setActiveSessionId 触发 chat backend 切换。
  const openChatTab = useCallback((s: Session) => {
    const id = chatTabId(s.session_id);
    topTabs.add({
      id, kind: 'chat',
      label: s.name || s.title || s.preview_text || tr('shell.newChat'),
      sessionId: s.session_id,
      sessionType: s.session_type,
      isPrimary: s.is_primary,
    });
    topTabs.setActiveId(id);
    topTabs.clearUnread(id);
    setActiveNav('chat');
    setActiveSessionId(s.session_id);
  }, [topTabs, setActiveSessionId]);

  const openGalleryTab = useCallback(() => {
    topTabs.add({ id: GALLERY_TAB_ID, kind: 'gallery', label: tr('shell.nav.gallery') });
    topTabs.setActiveId(GALLERY_TAB_ID);
    setActiveNav('gallery');
  }, [topTabs, tr]);

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
    // 见下方监听 la.lastSend 的 effect。非 local 类（gallery/kb/chat）仍可点击即提左。
    if (t.kind !== 'local') topTabs.promote(t.id);

    if (t.kind === 'gallery') setActiveNav('gallery');
    else if (t.kind === 'kb') setActiveNav('kb');
    else if (t.kind === 'local' && t.cwd) {
      setActiveNav('local');
      la.setActiveTab(t.cwd);
    } else if (t.kind === 'chat' && t.sessionId) {
      setActiveNav('chat');
      setActiveSessionId(t.sessionId);
    }
  }, [topTabs, la, setActiveSessionId]);

  // 分屏里异类窗格的渲染器（见 ForeignPaneContext）：wiki → 知识库（自包含/无流式）；
  // chat:<sid> → 只读会话面板（拉历史并渲染，不接 WS，不占额外流式开销，性能安全）。
  const renderForeignPane = useCallback((id: string): React.ReactNode => {
    if (id === 'wiki') return <KnowledgeViewPane />;
    if (id.startsWith('chat:')) return <ChatSessionPane sessionId={id.slice('chat:'.length)} />;
    return null;
  }, []);
  // 分屏聊天窗格的后端通道：注入唯一的 useChatBackend（被聚焦者实时，其余静态历史）。
  const chatPaneCtx = useMemo(
    () => ({ activeSessionId, messages, stream, sendMessage, setActiveSessionId }),
    [activeSessionId, messages, stream, sendMessage, setActiveSessionId],
  );

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
      else setActiveNav('chat');
    }
  }, [la, topTabs, activateTopTab]);

  // ----- 同步 activeId：外部状态机变化时把 topTabs.activeId 拉到位（teahouse picker
  // 创建新会话、createTopicAndOpen、首次进入某 view 等路径）。
  useEffect(() => {
    let id: string | null = null;
    if (activeNav === 'gallery') id = GALLERY_TAB_ID;
    else if (activeNav === 'kb') id = KB_TAB_ID;
    else if (activeNav === 'local' && la.activeCwd) id = localTabId(la.activeCwd);
    else if (activeNav === 'chat' && activeSessionId) id = chatTabId(activeSessionId);
    if (id !== topTabs.activeId) topTabs.setActiveId(id);
    if (id) topTabs.clearUnread(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, activeSessionId, la.activeCwd]);

  // ----- 新创建的 / 外部切换到的 chat session 自动建 tab。
  // 关键性能点：deps 只放 (activeNav, activeSessionId) —— effect 只在「切到不同会话」
  // 那一刻跑一次。元数据列表（agents/recents/teahouses）通过 ref 读取，不参与 dep
  // 比较，避免后端拉新一次 → effect 重跑 → topTabs 抖动 → ShellInner 全树重渲。
  const chatMetaRef = useRef({ agents, recents, teahouses });
  useEffect(() => { chatMetaRef.current = { agents, recents, teahouses }; }, [agents, recents, teahouses]);
  useEffect(() => {
    if (activeNav !== 'chat' || !activeSessionId) return;
    const meta = chatMetaRef.current;
    const s = [...meta.agents, ...meta.recents, ...meta.teahouses].find((x) => x.session_id === activeSessionId);
    // topTabs.add 已带短路：spec 相同时不会 setState，对长会话流式期完全无开销。
    topTabs.add({
      id: chatTabId(activeSessionId),
      kind: 'chat',
      label: s?.name || s?.title || s?.preview_text || tr('shell.newChat'),
      sessionId: activeSessionId,
      sessionType: s?.session_type,
      isPrimary: s?.is_primary,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, activeSessionId]);

  // ----- Label 同步：会话改名后刷新已开 chat tab 的显示名。
  // deps 是 (agents, recents, teahouses) —— 后端元数据更新时跑（频率很低，非每帧）。
  // 内部对每条 chat tab 做 add(...)；spec 没变则 add 直接返回原数组（不重渲）。
  useEffect(() => {
    const all = [...agents, ...recents, ...teahouses];
    topTabs.tabs.forEach((t) => {
      if (t.kind !== 'chat' || !t.sessionId) return;
      const s = all.find((x) => x.session_id === t.sessionId);
      if (!s) return;
      topTabs.add({
        id: t.id, kind: 'chat',
        label: s.name || s.title || s.preview_text || tr('shell.newChat'),
        sessionId: t.sessionId,
        sessionType: s.session_type,
        isPrimary: s.is_primary,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, recents, teahouses]);

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
  const handleLogout = useCallback(() => {
    api.clearToken();
    window.location.reload();
  }, []);

  /* ---- LLM configs cache (for showing current model name) ---- */
  const [llmConfigs, setLlmConfigs] = useState<LLMConfigFromDB[]>([]);
  useEffect(() => {
    getLLMConfigs().then((l) => setLlmConfigs(Array.isArray(l) ? l : [])).catch(() => {});
  }, [settingsOpen /* refresh after settings */]);

  const create = useCreateMode();

  // First time we see an LLM config list, if create-mode has no model picked
  // yet, default it to the user's chosen default LLM config so generation
  // doesn't 400 on a missing config_id. Picks the first Gemini-capable
  // config as a fallback.
  useEffect(() => {
    if (create.cfg.configId) return;
    if (llmConfigs.length === 0) return;
    // The default create model must be a 创作可见 (media_visible) config — the
    // same filter the model picker uses. The chat default
    // (settings.defaultLLMConfigId) usually isn't media-capable, so only honor
    // it when it's media-visible; otherwise prefer a Gemini media model, then
    // any media-visible one. Falls back to the full list only if nothing is
    // marked media-visible yet.
    const media = llmConfigs.filter((c) => (c as any).media_visible);
    const pool = media.length > 0 ? media : llmConfigs;
    const byDefault = settings.defaultLLMConfigId
      ? pool.find((c) => c.config_id === settings.defaultLLMConfigId)
      : undefined;
    const byGemini = pool.find((c) =>
      (c.provider || '').toLowerCase().includes('gemini') ||
      (c.model || '').toLowerCase().includes('gemini'),
    );
    const pick = byDefault || byGemini || pool[0];
    if (pick) create.setModelConfig(pick.config_id, pick.model, pick.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llmConfigs, settings.defaultLLMConfigId]);

  /* ---- mode pill spring indicator ---- */
  const pillsRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const chatBtnRef = useRef<HTMLButtonElement | null>(null);
  const createBtnRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const ind = indicatorRef.current, pills = pillsRef.current;
    const target = mode === 'chat' ? chatBtnRef.current : createBtnRef.current;
    if (!ind || !pills || !target) return;
    const r = target.getBoundingClientRect(), p = pills.getBoundingClientRect();
    ind.style.left = `${r.left - p.left}px`;
    ind.style.width = `${r.width}px`;
  }, [mode]);
  useEffect(() => {
    const f = () => setMode((m) => m);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);

  /* ---- textarea grow ---- */
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  /* 搜索框已下线（侧栏里塞个无功能空壳输入框没意义）。⌘K 保留给未来的
     全局命令面板（spotlight）时再接回。 */

  /* ---- scroll to bottom ----
   * `stream?.content` changes on every chunk; the old version did a sync
   * read of `scrollHeight` + write of `scrollTop` per chunk, which forces
   * layout/paint each time and tanks perf at 100+ messages. Now:
   *   1. rAF-batched so N chunks in one frame collapse into ONE scroll;
   *   2. bails if the user has scrolled up more than 200px — auto-scroll
   *      yanking someone away from history they're reading is the worst
   *      kind of jank. Reading mode now sticks.
   *   3. 切到不同会话时 (打开对话) 必须强制落底，无视上面的 200px 守卫——
   *      上一个会话的 scrollTop 对新会话没意义；不强制就会留在"看起来空白"
   *      的顶部（旧 bug）。等会话内有消息真正渲染完才把 ref 推进。 */
  const streamRef = useRef<HTMLDivElement | null>(null);
  const composerWrapRef = useRef<HTMLDivElement | null>(null);
  // chat keep-alive：hidden(display:none) 会把 scrollTop 丢成 0，恢复显示时按这份
  // 持续追踪的记忆复位 —— 之前贴底就继续贴底（吃掉隐藏期间的新消息），否则回原位。
  const chatScrollMemRef = useRef<{ top: number; nearBottom: boolean }>({ top: 0, nearBottom: true });
  useEffect(() => {
    if (activeNav !== 'chat') return;
    const id = requestAnimationFrame(() => {
      const el = streamRef.current;
      if (!el) return;
      const m = chatScrollMemRef.current;
      el.scrollTop = m.nearBottom ? el.scrollHeight : m.top;
    });
    return () => cancelAnimationFrame(id);
  }, [activeNav]);
  const scrollRafRef = useRef<number | null>(null);
  const lastScrolledSidRef = useRef<string | null>(null);
  // The composer floats (position:absolute) over the bottom of the stream, and
  // its height is variable — create-mode ref strips, chat attachments, domain
  // chips and textarea autogrow all change it. A fixed padding-bottom would let
  // the newest messages hide behind a tall composer. Measure the real height
  // and feed it back as the stream's --composer-h so content always clears it.
  useEffect(() => {
    const composer = composerWrapRef.current;
    const stream = streamRef.current;
    if (!composer || !stream || typeof ResizeObserver === 'undefined') return;
    const apply = () => {
      const nearBottom =
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 200;
      const h = composer.offsetHeight;
      // +14px = composer's bottom offset, +18px breathing room above it.
      stream.style.setProperty('--composer-h', `${h + 32}px`);
      // Growing the composer enlarges scrollHeight; if we were pinned to the
      // bottom, stay pinned so the newest message doesn't slide under it.
      if (nearBottom) stream.scrollTop = stream.scrollHeight;
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(composer);
    return () => ro.disconnect();
  }, [activeSessionId, mode]);
  useEffect(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = streamRef.current;
      if (!el) return;
      const sessionChanged = lastScrolledSidRef.current !== activeSessionId;
      if (sessionChanged) {
        el.scrollTop = el.scrollHeight;
        // 只有等消息真正落地 (length>0) 才认为"这次会话切换的滚动已结算"。
        // 否则后续 messages 异步加载完那帧会走"同 session"分支并被 200px
        // 守卫拦下，停在顶部。
        if (messages.length > 0) lastScrolledSidRef.current = activeSessionId;
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
    };
    // Dep is batches.length, not batches itself. Per-slot updates during
    // image streaming (partial frames) call setBatches with a new array
    // reference — depending on `batches` would refire the rAF scroll on
    // every partial frame, ~60Hz, allocating a new closure each time. The
    // scroll position is only interesting when a NEW batch appears (length
    // changes); slot refinement is contained to the BatchView itself.
  }, [messages.length, stream?.content, activeSessionId, batches.length]);

  /* ---- recents (topic + teahouse mixed, freshest first) ---- */
  const mergedRecents: Session[] = useMemo(() => {
    const all = [...recents, ...teahouses];
    const seen = new Set<string>();
    const uniq = all.filter((s) => {
      if (!s?.session_id || seen.has(s.session_id)) return false;
      seen.add(s.session_id);
      return true;
    });
    return uniq.sort((a, b) => {
      const ta = a.updated_at || a.last_message_at || a.created_at || '';
      const tb = b.updated_at || b.last_message_at || b.created_at || '';
      return tb.localeCompare(ta);
    });
  }, [recents, teahouses]);

  /* ---- topic title ---- */
  const activeRecord: Session | undefined = useMemo(() => {
    // Find via two early-exit scans instead of spreading both arrays into a
    // new one and walking the combined length — avoids an allocation on
    // every agents/teahouses change for what is almost always a one-list
    // hit (the active record lives in exactly one bucket).
    if (!activeSessionId) return undefined;
    return agents.find((x) => x.session_id === activeSessionId)
      || mergedRecents.find((x) => x.session_id === activeSessionId);
  }, [agents, mergedRecents, activeSessionId]);
  const activeTitle = activeRecord?.name || activeRecord?.title || (activeSessionId ? tr('shell.session') : '');

  /* ---- clipboard / drop → ref image (create) or chat attachment ---- */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            if (mode === 'create') void create.addRefFromFile(f);
            else void addAttachmentFile(f);
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [mode, create, addAttachmentFile]);

  const onDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    if (mode === 'create') for (const f of files) void create.addRefFromFile(f);
    else for (const f of files) void addAttachmentFile(f);
  };
  const swallowDragOver = (e: React.DragEvent) => { e.preventDefault(); };

  /* ---- send ---- */
  const onSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    if (!authed) { requireLogin(); return; }   // 聊天/生图走后端 —— 未登录先提示登录
    if (mode === 'chat') {
      if (sending) return;
      const agentId = (activeRecord as any)?.id || activeRecord?.session_id;
      const media = attachments.length > 0
        ? attachments.map((a) => ({ type: 'image' as const, mimeType: a.mimeType, data: a.data }))
        : undefined;
      const baseExt: Record<string, unknown> = { enable_tool_calling: settings.enableToolCalling };
      // No active session → user is on a fresh 茶话: create a topic, then send.
      if (!activeSessionId) {
        setDraft('');
        // @域 must ride the FIRST message too — createTopicAndOpen sends over WS
        // directly, so fold the retrieved knowledge into its ext (the regular
        // path below does the same via sendMessage).
        const firstExt: Record<string, unknown> = { ...baseExt };
        if (pickedDomains.length > 0) {
          // Record the @-referenced domains so the user bubble can show
          // "引用了 …" — persisted on the row, survives reload.
          firstExt.knowledge_domains = [...pickedDomains];
          try {
            const knowledge = await fetchDomainKnowledge(text, pickedDomains);
            if (knowledge.length) firstExt.knowledge = knowledge;
          } catch (e) { console.warn('[v2] domain retrieve failed', e); }
        }
        const sid = await createTopicAndOpen(text, agentId, firstExt);
        if (sid && media) {
          // first-send doesn't carry media; warn rather than silently drop
          console.warn('[v2] media on new-topic first send not supported yet');
        }
        if (!sid) setDraft(text); // restore on failure
        else setPickedDomains([]);
        setAttachments([]);
        return;
      }
      const ext: Record<string, unknown> = { ...baseExt };
      if (media) ext.media = media;
      // A queued quote rides along as context for this turn (backend folds it
      // into the prompt and persists it on the user row so the chip reloads).
      if (quoted) ext.quote = { role: quoted.role, content: quoted.content, message_id: quoted.messageId };
      // @域: retrieve each picked domain's top chunks (union) and inject as
      // ext.knowledge — the backend folds it into the prompt (extractKnowledgeBlock).
      if (pickedDomains.length > 0) {
        // Record the @-referenced domains so the user bubble can show
        // "引用了 …" — persisted on the row, survives reload.
        ext.knowledge_domains = [...pickedDomains];
        try {
          const knowledge = await fetchDomainKnowledge(text, pickedDomains);
          if (knowledge.length) ext.knowledge = knowledge;
        } catch (e) { console.warn('[v2] domain retrieve failed', e); }
      }
      // Optimistically clear input; sendMessage may now POST a draft teahouse
      // before sending, so we don't want the user to double-fire by re-typing.
      const prevDraft = text;
      setDraft(''); setAttachments([]);
      const ok = await sendMessage(text, { agentId, ext });
      if (ok) { clearQuote(); setPickedDomains([]); }
      else setDraft(prevDraft);
      return;
    }
    // create mode
    if (generating) return;
    const specSnapshot: Batch['spec'] = {
      aspect: create.cfg.aspect,
      count: create.cfg.count,
      style: create.cfg.style,
      negative: create.cfg.negative,
      refs: create.refs.map((r) => ({ id: r.id, data: r.data, mimeType: r.mimeType, directive: r.directive })),
      configId: create.cfg.configId,
      model: create.cfg.model,
      provider: create.cfg.provider,
    };
    setDraft('');
    await runCreationBatchRef.current(text, specSnapshot, activeSessionId);
    return;
  }, [draft, mode, sending, generating, activeRecord, sendMessage, create, activeSessionId, quoted, clearQuote, pickedDomains, authed, requireLogin]);

  // Hoisted creation-batch runner. Both the initial send (above) and 重新生成
  // (below) drive their state through this so the behaviour stays identical —
  // batches array, optimistic UI, persist user spec, run generate, persist
  // assistant images, reload, drop live batch.
  //
  // Stored on a ref so handleSend can forward to it without needing to list it
  // in its deps array (which would force a fresh handleSend on every batch).
  const runCreationBatchRef = useRef<(t: string, s: Batch['spec'], sid: string | null) => Promise<void>>(async () => {});
  const runCreationBatch = useCallback(async (
    text: string,
    specSnapshot: Batch['spec'],
    persistSid: string | null,
  ): Promise<void> => {
    const batchId = `b-${Date.now()}`;
    const count = specSnapshot.count;
    const startedAtMs = Date.now();
    setBatches((bs) => [...bs, {
      batchId,
      sessionId: persistSid,
      promptDisplay: text,
      spec: specSnapshot,
      slots: Array.from({ length: count }, () => null),
      errors: Array.from({ length: count }, () => null),
      pending: true,
      startedAt: startedAtMs,
    }]);
    setGenerating(true);
    // Persist the spec card as a user message in the current conversation so
    // the dialogue is durable across reloads. Best-effort — gen still works
    // even if no active session.
    if (persistSid) {
      void persistCreationUserSpec(persistSid, text, specSnapshot).catch(() => {});
    }
    // Accumulate the generated slots locally as they resolve. We must NOT rely
    // on reading the batch back out of `batches` state in the finally block:
    // React doesn't run the functional setState updater synchronously, so a
    // value assigned inside it is still undefined when read right after the
    // call. That race silently skipped persistCreationAssistantImages — images
    // showed live (from batch state) but were never saved, so they vanished on
    // reload. Building `settled` from these locals sidesteps React's timing.
    const localSlots: (string | null)[] = Array.from({ length: count }, () => null);
    const localErrors: (string | null)[] = Array.from({ length: count }, () => null);
    const startedAt = startedAtMs;
    try {
      // Always drive generate() with the explicit spec snapshot — for the
      // initial call it equals live state; for 重新生成 it equals the frozen
      // historical spec even if the user has since swapped models or refs.
      const overrideCfg = {
        aspect: specSnapshot.aspect,
        count: specSnapshot.count,
        style: specSnapshot.style,
        negative: specSnapshot.negative,
        configId: specSnapshot.configId,
        model: specSnapshot.model,
        provider: specSnapshot.provider,
      };
      const overrideRefs = specSnapshot.refs.map((r) => ({
        id: r.id, data: r.data, mimeType: r.mimeType, directive: r.directive,
      }));
      await create.generate(text, (idx, dataUri, err) => {
        if (dataUri) localSlots[idx] = dataUri;
        if (err) localErrors[idx] = err;
        setBatches((bs) => bs.map((b) => {
          if (b.batchId !== batchId) return b;
          const slots = b.slots.slice(); const errors = b.errors.slice();
          if (dataUri) slots[idx] = dataUri;
          if (err) errors[idx] = err;
          return { ...b, slots, errors };
        }));
      }, { cfg: overrideCfg, refs: overrideRefs }, (idx, partialUri) => {
        // Partial frames update the visual slot only — localSlots stays at
        // null until the final 'done' arrives. This keeps the persist step
        // honest: if streaming dies mid-way we don't save a blurry partial as
        // if it were the user's final art.
        setBatches((bs) => bs.map((b) => {
          if (b.batchId !== batchId) return b;
          const slots = b.slots.slice();
          slots[idx] = partialUri;
          return { ...b, slots };
        }));
      });
    } finally {
      // Mark batch settled (pure state update). Side-effects (persist + reload)
      // run OUTSIDE the updater so React StrictMode's double-invocation of
      // updaters in dev doesn't issue two POSTs, which would leave two
      // identical assistant messages in the DB.
      const elapsedMs = Date.now() - startedAt;
      const settled: Batch = {
        batchId,
        sessionId: persistSid,
        promptDisplay: text,
        spec: specSnapshot,
        slots: localSlots,
        errors: localErrors,
        pending: false,
        elapsedMs,
      };
      setBatches((bs) => bs.map((b) => (b.batchId === batchId ? { ...b, pending: false, elapsedMs } : b)));
      setGenerating(false);

      if (persistSid && !persistedBatchRef.current.has(batchId)) {
        // Mark persisted up-front so a re-entrant settle can't double-POST.
        persistedBatchRef.current.add(batchId);
        try {
          if (localSlots.some(Boolean)) {
            await persistCreationAssistantImages(persistSid, settled);
          } else {
            // No image came back — surface the error(s) as the AI's reply so the
            // failure (e.g. Gemini geo-block) is visible and persists on reload.
            await persistCreationError(persistSid, localErrors.filter(Boolean) as string[]);
          }
          // Await the reload so the persisted image message is in the message
          // list BEFORE we drop the live batch — otherwise there's a flicker,
          // and a lingering batch would render *below* any newer chat message
          // (the images appearing out of order — the reported "错位").
          await reloadActiveMessages();
          setBatches((cur) => cur.filter((b) => b.batchId !== batchId));
        } catch (e) {
          // Allow a later retry and keep the live batch as the only record.
          persistedBatchRef.current.delete(batchId);
          console.warn('[v2] persist creation assistant failed', e);
        }
      }
    }
  }, [create, reloadActiveMessages]);
  // Keep the ref pointing at the latest runCreationBatch so handleSend's stale
  // closure forwards to the current implementation.
  useEffect(() => { runCreationBatchRef.current = runCreationBatch; }, [runCreationBatch]);

  // Quote a message (works for both user and AI messages); focus the composer
  // so the user can immediately type the follow-up that references it.
  const onQuoteMessage = useCallback((m: Message) => {
    quoteMessage(m);
    setMode('chat');
    setTimeout(() => taRef.current?.focus(), 0);
  }, [quoteMessage]);
  // 稳定回调：前一版本里 messages.map 内联 (msg) => setConfirmRewind(...) 每次渲染
  // 都是新函数引用，会击穿 MessageView 的 React.memo。useCallback 锁住身份，let
  // memo 真正生效——长会话下的非激活消息不再每个 chunk 重渲。
  const onRevertMessage = useCallback((msg: Message) => setConfirmRewind({ kind: 'revert', m: msg }), []);
  const onEditMessage = useCallback((msg: Message) => setConfirmRewind({ kind: 'edit', m: msg }), []);
  const onRerunCreation = useCallback((msg: Message) => setConfirmRewind({ kind: 'rerun', m: msg }), []);
  // 持久化的 user-spec 消息点击 → 重建一个 Batch 形状喂给详情弹框。
  // refs 的真实 base64 在 ext.media 里；directive 在 ext.creation_spec.refs 里 —— 拉链合并。
  const onOpenSpecFromMessage = useCallback((msg: Message) => {
    const ext: any = typeof msg.ext === 'string'
      ? (() => { try { return JSON.parse(msg.ext as unknown as string); } catch { return {}; } })()
      : (msg.ext || {});
    const cs: any = ext.creation_spec || {};
    const mediaArr: any[] = Array.isArray(ext.media) ? ext.media : [];
    const specRefs: any[] = Array.isArray(cs.refs) ? cs.refs : [];
    const refs = mediaArr
      .filter((md: any) => !!md?.data && (md.type === 'image' || !md.type))
      .map((md: any, i: number) => ({
        id: `hist-${msg.message_id}-${i}`,
        data: typeof md.data === 'string' && md.data.startsWith('data:')
          ? md.data.slice(md.data.indexOf(',') + 1) : md.data,
        mimeType: md.mimeType || 'image/png',
        directive: specRefs[i]?.directive || '',
      }));
    setSpecDetail({
      batchId: `hist-${msg.message_id}`,
      sessionId: activeSessionId,
      promptDisplay: msg.content || '',
      spec: {
        aspect: cs.aspect || '1:1',
        count: cs.count || refs.length || 1,
        style: cs.style || '',
        negative: cs.negative || '',
        refs,
        configId: cs.configId,
        model: cs.model,
        provider: cs.provider,
      },
      slots: [],
      errors: [],
      pending: false,
    });
  }, [activeSessionId]);
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
  // 侧栏 ⋯ 菜单：稳定 handler，让 AgentRow/ChatRow 的 React.memo 真正生效。
  const onSidebarMore = useCallback((s: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setRowMenu({ session: s, x: r.right, y: r.bottom + 4 });
  }, []);

  // Run a confirmed rewind. 'edit' additionally lifts the message text back
  // into the composer so the user can amend and resend it. 'rerun' reads the
  // creation spec from the message's ext, wipes the message + everything
  // after, then fires runCreationBatch with the frozen spec so the result lands
  // in place — same prompt, same model, same refs, fresh images.
  const runRewind = useCallback(async (
    kind: 'revert' | 'edit' | 'rerun',
    m: Message,
    opts?: { useLiveModel?: boolean },
  ) => {
    const text = m.content || '';
    if (kind === 'rerun') {
      const sid = activeSessionId;
      if (!sid) return;
      const ext: any = typeof m.ext === 'string'
        ? (() => { try { return JSON.parse(m.ext as unknown as string); } catch { return {}; } })()
        : (m.ext || {});
      const cs = ext.creation_spec || {};
      const mediaArr: any[] = Array.isArray(ext.media) ? ext.media : [];
      // Rebuild refs by zipping creation_spec.refs (directive+mime) with
      // ext.media (the actual base64 payloads). Either side may be empty for
      // pure text→image batches.
      const specRefs: any[] = Array.isArray(cs.refs) ? cs.refs : [];
      const refs = mediaArr.map((md: any, i: number) => ({
        id: `rerun-${i}-${Date.now()}`,
        data: typeof md?.data === 'string' && md.data.startsWith('data:')
          ? (md.data.split(',')[1] || '')
          : (md?.data || ''),
        mimeType: md?.mimeType || specRefs[i]?.mimeType || 'image/png',
        directive: specRefs[i]?.directive || '',
      })).filter((r) => r.data);
      // Model selection on rerun:
      //   - opts.useLiveModel=true  → user explicitly chose to override in
      //                                the confirm dialog (e.g. escaping a
      //                                broken Gemini snapshot); use live cfg.
      //   - snapshot has model info → honour it ("记住当时" semantics).
      //   - snapshot missing        → fall back to live cfg (old messages
      //                                pre-date the per-message model persist).
      const hasModelSnapshot = !!(cs.configId || cs.model || cs.provider);
      const useLive = opts?.useLiveModel === true || !hasModelSnapshot;
      const fallbackConfigId = useLive ? create.cfg.configId : cs.configId;
      const fallbackModel = useLive ? create.cfg.model : cs.model;
      const fallbackProvider = useLive ? create.cfg.provider : cs.provider;
      const spec: Batch['spec'] = {
        aspect: cs.aspect || '1:1',
        count: typeof cs.count === 'number' ? cs.count : 1,
        style: cs.style || '',
        negative: cs.negative || '',
        refs,
        configId: fallbackConfigId,
        model: fallbackModel,
        provider: fallbackProvider,
      };
      // Switch UI into create mode and echo the historical config into the
      // live composer (model picker chip + aspect/count/style/negative chips +
      // ref strip), so the user *sees* what's being rerun before/during the
      // batch — not just images appearing out of nowhere.
      setMode('create');
      create.setModelConfig(spec.configId, spec.model, spec.provider);
      create.setStyle(spec.style);
      create.setNegative(spec.negative);
      create.setAspect(spec.aspect);
      create.setCount(spec.count);
      create.replaceRefs(refs);
      // Wipe the historical spec + everything after it. revertToMessage
      // deletes the anchor itself too — that's fine, runCreationBatch
      // re-persists a fresh user spec with identical content.
      await revertToMessage(m.message_id);
      await runCreationBatchRef.current(text, spec, sid);
      return;
    }
    await revertToMessage(m.message_id);
    if (kind === 'edit') {
      setMode('chat');
      setDraft(text);
      setTimeout(() => { const ta = taRef.current; if (ta) { ta.focus(); ta.setSelectionRange(text.length, text.length); } }, 0);
    }
  }, [revertToMessage, activeSessionId, create]);

  /* ---- @域 mention autocomplete ---- */
  // Domains matching the live @token, minus ones already picked.
  const mentionMatches = useMemo(() => {
    if (!mention) return [] as DomainTag[];
    const q = mention.query.toLowerCase();
    return domains
      .filter((d) => !pickedDomains.includes(d.name) && (!q || d.name.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [mention, domains, pickedDomains]);

  // Detect a trailing "@token" at the caret → open the picker; otherwise close.
  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setDraft(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    // Open whenever smartnote is configured — even before the domain list has
    // arrived — so a slow/failed initial load doesn't silently swallow `@`.
    // The popover shows a loading/empty hint and we (re)fetch on the spot.
    if (m && (domains.length || getSmartnoteApiKey())) {
      const opening = !mention; // refresh the list on each open, not just when empty —
      setMention({ query: m[1], from: caret - m[1].length - 1, to: caret });
      setMentionIdx(0);
      if (opening) loadDomains(); // so domains created in 知识库 this session show up without a restart
    } else if (mention) {
      setMention(null);
    }
  };

  const addPickedDomain = useCallback((name: string) => {
    setPickedDomains((p) => (p.includes(name) ? p : [...p, name]));
  }, []);
  const removePickedDomain = useCallback((name: string) => {
    setPickedDomains((p) => p.filter((x) => x !== name));
  }, []);

  // Commit a domain from the popover: strip the @token, attach the chip.
  const pickDomain = useCallback((name: string) => {
    setMention((mn) => {
      if (mn) setDraft((d) => d.slice(0, mn.from) + d.slice(mn.to));
      return null;
    });
    addPickedDomain(name);
    setTimeout(() => taRef.current?.focus(), 0);
  }, [addPickedDomain]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @域 popover steals nav keys while open. Escape always closes it, even
    // on the loading/empty hint (when there are no selectable matches).
    if (mention) {
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
      if (mentionMatches.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionMatches.length); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickDomain(mentionMatches[mentionIdx]?.name || mentionMatches[0].name); return; }
      }
    }
    // Tab quickly toggles 对话 ⇄ 创作 without leaving the input box. Plain Tab
    // only — Shift/⌘/Ctrl/Alt+Tab keep their normal focus/navigation behavior.
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setMode((m) => (m === 'chat' ? 'create' : 'chat'));
      return;
    }
    // settings.cmdEnterToSend:
    //   true  (default)  Enter = send,  Shift+Enter = newline.
    //   false            Enter = newline, ⌘/Ctrl+Enter = send.
    const wantsEnterSend = settings.cmdEnterToSend !== false;
    if (e.key !== 'Enter') return;
    if (wantsEnterSend) {
      if (!e.shiftKey) { e.preventDefault(); void onSend(); }
    } else {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); void onSend(); }
    }
  };

  /* ---- file picker (mode-aware) ---- */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const onPickFiles = () => fileRef.current?.click();
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    if (mode === 'create') for (const f of files) void create.addRefFromFile(f);
    else for (const f of files) void addAttachmentFile(f);
    e.target.value = '';
  };

  /* ---- context popover (model picker / agent settings) ---- */
  const [contextPopOpen, setContextPopOpen] = useState(false);
  const contextBtnRef = useRef<HTMLButtonElement | null>(null);
  const isAgentSession = useMemo(
    () => !!activeSessionId && agents.some((a) => a.session_id === activeSessionId),
    [agents, activeSessionId],
  );
  // Filter once per (batches, activeSessionId) change instead of twice per
  // render (empty-state guard + map). Previously this filter ran on every
  // stream chunk through ClientShell's re-render, allocating a fresh array
  // even when no batch existed for the session — wasted GC churn on the hot
  // streaming path.
  const activeBatches = useMemo(
    () => batches.filter((b) => b.sessionId === activeSessionId),
    [batches, activeSessionId],
  );

  /* ---- inline chip panel (only one open at a time) ---- */
  type ChipKey = null | 'style' | 'aspect' | 'count' | 'negative';
  const [openChip, setOpenChip] = useState<ChipKey>(null);
  const toggleChip = (k: Exclude<ChipKey, null>) => setOpenChip((p) => (p === k ? null : k));
  const styleLabel = useMemo(() => {
    const t = create.cfg.style.trim();
    if (!t) return tr('shell.create.unset');
    const preset = findPresetBySuffix(t);
    if (preset) return preset.custom ? preset.zh : tr('misc.style.' + preset.id);
    return t.length > 14 ? t.slice(0, 14) + '…' : t;
  }, [create.cfg.style, tr]);
  const negativeLabel = useMemo(() => {
    const t = create.cfg.negative.trim();
    if (!t) return tr('shell.create.none');
    return t.length > 18 ? t.slice(0, 18) + '…' : t;
  }, [create.cfg.negative, tr]);

  return (
    <FbotProvider>
    <div className="chaya-v2" data-mode={resolvedMode} data-theme={theme} data-glass={glassAttr} data-glass-i={glassIntensity} onDragOver={swallowDragOver} onDrop={onDrop}>
      {/* L0 底层壁纸：固定铺满、置于内容之后（Pure 三层结构的最底层透明玻璃面） */}
      <div id="v2-wall" aria-hidden />
      {toast && <div className="v2-global-toast" role="status">{toast}</div>}
      {/* ===== 全宽统一顶栏：红绿灯 + 图标导航 + 置顶 + tab + 折叠，全在这一行（跨整窗宽） ===== */}
      <div className="v2-titlebar">
        <div className="v2-dots" aria-hidden><i /><i /><i /></div>
        <nav className="v2-tnav">
          <button
            className={`v2-pin v2-pin-fn${activeNav === 'chat' ? ' active' : ''}`}
            title={tr('shell.nav.chat')} aria-label={tr('shell.nav.chat')}
            onClick={() => { if (!authed) { requireLogin(); return; } setActiveNav('chat'); setMode('chat'); }}
          ><IconChat /><span className="lb">chat</span></button>
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
            onClick={() => { if (!authed) { requireLogin(); return; } openKBTab(); }}
          ><IconKB /><span className="lb">wiki</span></button>
          <button
            className={`v2-pin v2-pin-fn${activeNav === 'gallery' ? ' active' : ''}`}
            title={tr('shell.nav.gallery')} aria-label={tr('shell.nav.gallery')}
            onClick={() => { if (!authed) { requireLogin(); return; } openGalleryTab(); }}
          ><IconGallery /><span className="lb">gallery</span></button>
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
            {/* 对话：基础动作（新对话）置顶 + 我的 Agent + 最近会话 */}
            {activeNav === 'chat' && (
              authed ? (
                <>
                  <button
                    className="v2-side-action"
                    onClick={() => {
                      // 新对话只进「草稿态」：不立刻 POST /api/conversations，否则会在后端
                      // 留下没产生过对话（无 llm 回答）的空会话。真正的创建延后到首条消息
                      // 发送时（onSend 的 !activeSessionId 分支 → createTopicAndOpen(text)）。
                      setActiveNav('chat'); setMode('chat'); setActiveSessionId(null);
                    }}
                  >
                    <IconPlus /><span>{tr('shell.newChat')}</span>
                  </button>
                  <div className="v2-sec">
                    <span>Agents</span>
                  </div>
                  <div className="v2-agents">
                    {loadingMeta && agents.length === 0 && <SkeletonRows n={2} />}
                    {agents.map((a) => (
                      <AgentRow key={a.session_id} a={a} active={activeSessionId === a.session_id} onOpen={openChatTab} onMore={onSidebarMore} />
                    ))}
                    {!loadingMeta && agents.length === 0 && (
                      <div className="v2-side-hint">{tr('shell.noAgents')}</div>
                    )}
                  </div>
                  <div className="v2-sec"><span>Chats</span></div>
                  <div className="v2-recents">
                    {loadingMeta && mergedRecents.length === 0 && <SkeletonRows n={6} />}
                    {mergedRecents.map((r) => (
                      <ChatRow key={r.session_id} r={r} active={activeSessionId === r.session_id} onOpen={openChatTab} onMore={onSidebarMore} />
                    ))}
                    {!loadingMeta && mergedRecents.length === 0 && (
                      <div className="v2-side-hint">{tr('shell.noChats')}</div>
                    )}
                  </div>
                </>
              ) : (
                <div className="v2-feat-empty">{tr('shell.signInToSeeAgents')}</div>
              )
            )}

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

            {/* 画廊：相册 */}
            {activeNav === 'gallery' && (
              <>
                <div className="v2-sec"><span>{tr('shell.gallery.albums')}</span></div>
                <div className="v2-wikis">
                  <button className="v2-wiki active" onClick={openGalleryTab}>
                    <span className="nm">{tr('shell.gallery.all')}</span>
                  </button>
                </div>
              </>
            )}

            {/* 飞书助手：分区导航 + 提交列表（与 chat/CLI 同骨架） */}
            {activeNav === 'fbot' && isFbotAvailable() && <FbotSidebar />}
          </div>

          {authed ? (
            <button className="v2-railme" onClick={() => setSettingsOpen(true)} title={`${userName()} · WS ${wsState} · ${tr('shell.settings')}`}>
              <span className={`v2-av${wsState === 'open' ? ' online' : ''}`}>{userInitials()}</span>
              <span className="v2-railme-meta">
                <span className="n">{userName()}</span>
                <span className="s">{tr('shell.acct.signedIn')}</span>
              </span>
              <span className="lb"><IconGear /></span>
            </button>
          ) : (
            <button className="v2-railme guest" onClick={requireLogin} title={tr('shell.guestLoginHint')}>
              <span className="v2-av">·</span>
              <span className="v2-railme-meta">
                <span className="n">{tr('shell.login')}</span>
                <span className="s">{tr('shell.acct.localOnly')}</span>
              </span>
            </button>
          )}
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
          {visitedNav.has('gallery') && (
            <div className="v2-view-slot" hidden={activeNav !== 'gallery'}><GalleryViewKA /></div>
          )}
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
                  {/* 分屏里的异类窗格由这里渲染：wiki → 知识库（自包含、无流式）；
                      chat:<sid> → 只读会话面板（不接 WS，性能安全）。 */}
                  <ChatPaneContext.Provider value={chatPaneCtx}>
                    <ForeignPaneContext.Provider value={renderForeignPane}>
                      <LocalAgentConversation la={la} />
                    </ForeignPaneContext.Provider>
                  </ChatPaneContext.Provider>
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

          {/* chat 也走 keep-alive：历史一长，重挂载（全部消息 markdown 重渲）让 code→chat
              切换明显卡一拍。首访挂载一次，之后 hidden 切显隐瞬时；切回时下方 effect 重新贴底。 */}
          {visitedNav.has('chat') && (
          <div className="v2-view-slot" hidden={activeNav !== 'chat'}>
          <div className="v2-feat">
            <div className="v2-feat-main">
          <section
            className="v2-stream"
            ref={streamRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              chatScrollMemRef.current = { top: el.scrollTop, nearBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 200 };
            }}
          >
            <div className="v2-msgs">
              {messages.length === 0 && activeBatches.length === 0 && !stream && !thinking && (
                <EmptyState title={activeTitle} />
              )}

              {messages.map((m) => (
                <MessageView
                  key={m.message_id}
                  m={m}
                  showTokens={!!settings.showTokenCost}
                  onPreviewImage={setPreviewSrc}
                  onRevert={onRevertMessage}
                  onEdit={onEditMessage}
                  onQuote={onQuoteMessage}
                  onRerunCreation={onRerunCreation}
                  onOpenSpec={onOpenSpecFromMessage}
                />
              ))}

              {activeBatches.map((b) => (
                <React.Fragment key={b.batchId}>
                  <CreateSpecCard b={b} onOpenDetail={() => setSpecDetail(b)} />
                  <BatchView b={b} onPreviewImage={setPreviewSrc} />
                </React.Fragment>
              ))}

              {thinking && !stream && <ThinkingDots />}
              {stream && <StreamView content={stream.content} reasoning={stream.reasoning} />}
            </div>
          </section>

          <div className="v2-composer-wrap" ref={composerWrapRef}>
            <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onFiles} />
            <div className="v2-composer" data-mode={mode}>
              {/* Chat / 创作 mode toggle — sits above the box (prototype layout). */}
              <div className="v2-modepills" ref={pillsRef}>
                <span className="v2-indicator" ref={indicatorRef} />
                <button ref={chatBtnRef}   className={mode === 'chat'   ? 'on' : ''} onClick={() => setMode('chat')}>{tr('shell.modeChat')}</button>
                <button ref={createBtnRef} className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>{tr('shell.modeCreate')}</button>
              </div>
              <div className="v2-box">
                {/* Create-mode config picker — floats above the box (like the
                    @域 mention popover) so the prompt + tools stay in one box. */}
                {mode === 'create' && openChip && (
                  <div className="v2-create-pop">
                    <ChipPanel
                      which={openChip}
                      cfg={create.cfg}
                      setStyle={create.setStyle}
                      setNegative={create.setNegative}
                      setAspect={create.setAspect}
                      setCount={create.setCount}
                      aspectOptions={create.caps.aspects}
                      countMax={create.caps.maxCount}
                      aspectHint={create.caps.hint}
                      close={() => setOpenChip(null)}
                    />
                  </div>
                )}
                {/* Create-mode reference images — sit inside the box, above the
                    prompt, like attachments do in chat. */}
                {mode === 'create' && create.refs.length > 0 && (
                  <div className="v2-refs">
                    {create.refs.map((r, i) => (
                      <RefPill
                        key={r.id}
                        idx={i + 1}
                        r={r}
                        onChange={(v) => create.setRefDirective(r.id, v)}
                        onRemove={() => create.removeRef(r.id)}
                        onPreview={() => setPreviewSrc(`data:${r.mimeType};base64,${r.data}`)}
                      />
                    ))}
                    <div className="v2-ref add" onClick={onPickFiles}>{tr('shell.create.addRef')}</div>
                  </div>
                )}
                {mode === 'chat' && quoted && (
                  <div className="v2-quote-bar">
                    <span className="v2-quote-tag">{quoted.role === 'assistant' ? tr('shell.quote.reply') : tr('shell.quote.you')}</span>
                    <span className="v2-quote-text">{truncate(quoted.content || tr('shell.emptyMessage'), 90)}</span>
                    <button className="v2-quote-x" title={tr('shell.quote.cancel')} onClick={clearQuote}>✕</button>
                  </div>
                )}
                {mode === 'chat' && pickedDomains.length > 0 && (
                  <div className="v2-dom-chips">
                    {pickedDomains.map((name) => {
                      const d = domains.find((x) => x.name === name);
                      return (
                        <span key={name} className="v2-dom-chip" title={tr('shell.domain.chipTip')}>
                          <span className="dot" style={{ background: domainColor(d) }} />@{name}
                          <button className="x" title={tr('shell.domain.remove')} onClick={() => removePickedDomain(name)}>✕</button>
                        </span>
                      );
                    })}
                  </div>
                )}
                {mention && (
                  <div className="v2-dom-pop">
                    <div className="v2-dom-pop-hd">{tr('shell.domain.popHead')}</div>
                    {mentionMatches.length > 0 ? (
                      mentionMatches.map((d, i) => (
                        <button
                          key={d.name}
                          className={`v2-dom-pop-item${i === mentionIdx ? ' on' : ''}`}
                          onMouseEnter={() => setMentionIdx(i)}
                          onClick={() => pickDomain(d.name)}
                        >
                          <span className="dot" style={{ background: domainColor(d) }} />
                          <span className="nm">{d.name}</span>
                          {d.description ? <span className="ds">{d.description}</span> : null}
                        </button>
                      ))
                    ) : (
                      <div className="v2-dom-pop-empty">
                        {domainsLoading
                          ? tr('shell.domain.loading')
                          : domains.length === 0
                            ? tr('shell.domain.empty')
                            : pickedDomains.length > 0 && domains.every((d) => pickedDomains.includes(d.name))
                              ? tr('shell.domain.allSelected')
                              : tr('shell.domain.noMatch')}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'chat' && attachments.length > 0 && (
                  <div className="v2-attaches">
                    {attachments.map((a) => (
                      <div key={a.id} className="v2-att">
                        <img src={`data:${a.mimeType};base64,${a.data}`} alt="" />
                        <span className="x" onClick={() => removeAttachment(a.id)}>✕</span>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={taRef}
                  placeholder={mode === 'create' ? tr('shell.composer.createPlaceholder') : tr('shell.composer.chatPlaceholder')}
                  value={draft}
                  onChange={onComposerChange}
                  onKeyDown={onKeyDown}
                  onBlur={() => setTimeout(() => setMention(null), 120)}
                />
                <div className="v2-row">
                  <div className="v2-l">
                    <button className="v2-ib" title={tr('shell.composer.attach')} onClick={onPickFiles}><IconAttach /></button>
                    <button
                      ref={contextBtnRef}
                      className={`v2-ib${contextPopOpen ? ' on' : ''}`}
                      title={
                        // In an agent chat, the triangle (app logo) opens the
                        // agent's own surface. Everywhere else it's the model /
                        // context picker.
                        mode === 'chat' && isAgentSession
                          ? tr('shell.agentSettings')
                          : mode === 'create' ? tr('shell.createModel') : tr('shell.chatModel')
                      }
                      onClick={() => {
                        if (mode === 'chat' && isAgentSession && activeRecord) {
                          setAgentSettingsFor(activeRecord);
                        } else {
                          setContextPopOpen((v) => !v);
                        }
                      }}
                    >
                      <IconModel />
                    </button>
                    {/* Create-mode config chips, arranged inline inside the box. */}
                    {mode === 'create' && (
                      <div className="v2-create-chips">
                        <button className={`v2-chip${openChip === 'style' ? ' active' : ''}`} onClick={() => toggleChip('style')}>
                          <span className="v2-k">{tr('shell.create.style')}</span><span>{styleLabel}</span>
                        </button>
                        <button className={`v2-chip${openChip === 'aspect' ? ' active' : ''}`} onClick={() => toggleChip('aspect')}>
                          <span className="v2-k">{tr('shell.create.aspect')}</span><span>{create.cfg.aspect}</span>
                        </button>
                        <button className={`v2-chip${openChip === 'count' ? ' active' : ''}`} onClick={() => toggleChip('count')}>
                          <span className="v2-k">{tr('shell.create.count')}</span><span>{create.cfg.count}</span>
                        </button>
                        <button className={`v2-chip${openChip === 'negative' ? ' active' : ''}`} onClick={() => toggleChip('negative')}>
                          <span className="v2-k">{tr('shell.create.negative')}</span><span>{negativeLabel}</span>
                        </button>
                        <span className="v2-create-note" title={tr('shell.create.noPersonaTip')}>{tr('shell.create.noPersona')}</span>
                      </div>
                    )}
                  </div>
                  <ModelBadge
                    mode={mode}
                    configs={llmConfigs}
                    activeRecord={activeRecord}
                    createConfig={create.cfg}
                    settingsDefault={settings.defaultLLMConfigId}
                    onClick={() => setContextPopOpen(true)}
                  />
                  <button
                    className="v2-send"
                    title={tr('shell.composer.send')}
                    onClick={onSend}
                    disabled={!draft.trim() || (mode === 'chat' ? sending : generating)}
                  >
                    <IconSend />
                  </button>
                </div>
              </div>
            </div>
          </div>
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

      {previewSrc && (
        <ImagePreview src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}

      {specDetail && (
        <CreateSpecDetailModal
          b={specDetail}
          onClose={() => setSpecDetail(null)}
          onPreviewImage={setPreviewSrc}
        />
      )}

      {confirmRewind && (() => {
        // For rerun: surface the model that will be used so the user isn't
        // surprised when a frozen historical Gemini spec re-fires the geo-block
        // they're trying to escape from. Also offers a one-click override to
        // the live picker.
        let historicalModel: string | undefined;
        if (confirmRewind.kind === 'rerun') {
          const e: any = typeof confirmRewind.m.ext === 'string'
            ? (() => { try { return JSON.parse(confirmRewind.m.ext as unknown as string); } catch { return {}; } })()
            : (confirmRewind.m.ext || {});
          historicalModel = e?.creation_spec?.model || undefined;
        }
        return (
          <ConfirmRewind
            kind={confirmRewind.kind}
            preview={truncate(confirmRewind.m.content || tr('shell.emptyMessage'), 60)}
            historicalModel={historicalModel}
            liveModel={create.cfg.model}
            onCancel={() => setConfirmRewind(null)}
            onConfirm={(opts) => {
              const c = confirmRewind;
              setConfirmRewind(null);
              void runRewind(c.kind, c.m, opts);
            }}
          />
        );
      })()}

      {rowMenu && (
        <RowMenu
          session={rowMenu.session}
          isAgent={agents.some((a) => a.session_id === rowMenu.session.session_id)}
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          onRename={async (newName) => {
            await renameSession(rowMenu.session.session_id, newName);
            setRowMenu(null);
          }}
          onDelete={async () => {
            await removeSession(rowMenu.session);
            setRowMenu(null);
          }}
          onSettings={() => { setAgentSettingsFor(rowMenu.session); setRowMenu(null); }}
        />
      )}

      {agentSettingsFor && (
        <AgentSettingsDrawer
          agent={agentSettingsFor}
          onClose={() => { setAgentSettingsFor(null); void refreshMeta(false); }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          updateSettings={updateSettings}
          onLogout={handleLogout}
          onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
          initialSection={settingsSection as any}
        />
      )}

      {/* 按需登录：可关闭的浮层（不挡本地功能）。登录成功 → authed 翻 true，
          useChatBackend 重新拉 meta + 连 WS，云端功能即可用。 */}
      {loginOpen && (
        <LoginPage
          onLogin={() => { setAuthed(true); setLoginOpen(false); }}
          onClose={() => setLoginOpen(false)}
        />
      )}

      {teahousePickerOpen && (
        <TeahousePicker
          configs={llmConfigs}
          onClose={() => setTeahousePickerOpen(false)}
          onPick={(cfg, modelOverride) => {
            setTeahousePickerOpen(false);
            // Draft only — nothing hits the DB until the user actually sends.
            startTeahouseDraft({
              llm_config_id: cfg.config_id,
              model: modelOverride || undefined,
            });
            setActiveNav('chat');
          }}
        />
      )}

      {contextPopOpen && (
        <ContextPopover
          mode={mode}
          isAgent={isAgentSession}
          activeRecord={activeRecord}
          createConfigId={create.cfg.configId}
          onClose={() => setContextPopOpen(false)}
          onPickModel={async (cfg) => {
            if (mode === 'create') {
              create.setModelConfig(cfg.config_id, cfg.model, (cfg as any).provider);
            } else if (activeSessionId && activeRecord) {
              try {
                // Agent-bound sessions store llm_config_id on the
                // *agent* record, not the conversation. Use the
                // agents/{id}/profile endpoint accordingly.
                if (isAgentSession) {
                  const apiId = (activeRecord as any).id || activeRecord.session_id;
                  await updateRoleProfile(apiId, { llm_config_id: cfg.config_id });
                  await refreshMeta(false);
                } else if (isTeahouseSessionFn(activeRecord)) {
                  // Teahouse rows live in /api/teahouse/conversations
                  // — the /sessions/{id}/llm-config alias doesn't reach them.
                  await setTeahouseModel(activeSessionId, cfg.config_id, cfg.model);
                } else {
                  await updateSessionLLMConfig(activeSessionId, cfg.config_id);
                  await refreshMeta(false);
                }
              } catch (e) {
                console.warn('[v2] update model failed', e);
              }
            } else if (!activeSessionId) {
              // 茶话 with no active session — new chats are answered
              // by the primary agent, so updating its model is what
              // the user actually means by "change the model".
              const primary = agents.find((a) => a.is_primary);
              if (primary) {
                try {
                  const apiId = (primary as any).id || primary.session_id;
                  await updateRoleProfile(apiId, { llm_config_id: cfg.config_id });
                  await refreshMeta(false);
                } catch (e) {
                  console.warn('[v2] update primary failed', e);
                }
              }
              // Also remember for non-primary-routed new topics.
              updateSettings({ defaultLLMConfigId: cfg.config_id });
            }
            setContextPopOpen(false);
          }}
        />
      )}
    </div>
    </FbotProvider>
  );
};

const TeahousePicker: React.FC<{
  configs: LLMConfigFromDB[];
  onClose: () => void;
  onPick: (cfg: LLMConfigFromDB, modelOverride: string) => void;
}> = ({ configs, onClose, onPick }) => {
  const { t: tr } = useI18n();
  // 「发起聊天」与对话模型选择保持一致：创作专用模型（media_visible）不出现。
  // 创作模型有自己专属的选择入口（创作模式的 ▲），混进来会让用户用 SDXL/Flux
  // 起一个聊天会话却聊不出东西。
  const enabled = (configs || []).filter((c) => c.enabled !== false && !c.media_visible);
  // 按 provider 分组一次（顺序稳定，跟着 PICK_PROVIDER_ORDER）。
  const grouped = useMemo(() => groupConfigsByProvider(enabled), [enabled]);
  const [activeProvider, setActiveProvider] = useState<string | null>(grouped[0]?.[0] ?? null);
  // 右侧当前能选的模型
  const activeConfigs = useMemo(
    () => grouped.find(([p]) => p === activeProvider)?.[1] ?? [],
    [grouped, activeProvider],
  );
  const [picked, setPicked] = useState<LLMConfigFromDB | null>(activeConfigs[0] ?? null);
  // 切 provider 时，picked 自动跟到该 provider 的第一个 config。
  useEffect(() => { setPicked(activeConfigs[0] ?? null); }, [activeProvider]); // eslint-disable-line react-hooks/exhaustive-deps
  const [modelOverride, setModelOverride] = useState('');
  useEffect(() => { setModelOverride(''); }, [picked?.config_id]);

  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="v2-modal v2-pickmodal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{tr('shell.teahouse.title')}</h3>
          <button className="x" onClick={onClose} aria-label={tr('common.close')}>✕</button>
        </div>
        {enabled.length === 0 ? (
          <div className="v2-pickmodal-empty">
            {tr('shell.teahouse.noModels')}
          </div>
        ) : (
          <div className="v2-pickmodal-split">
            {/* 左：provider 厂商列表 */}
            <aside className="v2-pickmodal-providers" role="listbox" aria-label={tr('shell.provider')}>
              {grouped.map(([provider, items]) => (
                <button
                  key={provider}
                  type="button"
                  role="option"
                  aria-selected={provider === activeProvider}
                  className={`v2-pickmodal-provider${provider === activeProvider ? ' on' : ''}`}
                  onClick={() => setActiveProvider(provider)}
                >
                  <span className="nm">{PICK_PROVIDER_LABELS[provider] || provider}</span>
                  <span className="cnt">{items.length}</span>
                </button>
              ))}
            </aside>
            {/* 右：该 provider 在「设置 · 模型」里录入的模型列表 */}
            <div className="v2-pickmodal-models">
              {activeConfigs.length === 0 ? (
                <div className="v2-pickmodal-empty">{tr('shell.noModelsForProvider')}</div>
              ) : (
                <div className="v2-pickmodal-modellist">
                  {activeConfigs.map((c) => (
                    <button
                      key={c.config_id}
                      type="button"
                      className={`v2-pick${picked?.config_id === c.config_id ? ' on' : ''}`}
                      onClick={() => setPicked(c)}
                    >
                      <div className="v2-pick-nm">{c.shortname || c.name}</div>
                      <div className="v2-pick-ds">{c.model || tr('shell.defaultModelName')}</div>
                    </button>
                  ))}
                </div>
              )}
              <div className="v2-pickmodal-override">
                <label>{tr('shell.teahouse.modelOverride')}</label>
                <input
                  type="text"
                  value={modelOverride}
                  onChange={(e) => setModelOverride(e.target.value)}
                  placeholder={picked?.model || ''}
                />
              </div>
            </div>
          </div>
        )}
        <div className="v2-modal-foot">
          <button type="button" onClick={onClose} className="v2-mbtn">{tr('common.cancel')}</button>
          <button
            type="button"
            className="v2-mbtn primary"
            disabled={!picked}
            onClick={() => picked && onPick(picked, modelOverride.trim())}
          >
            {tr('shell.teahouse.start')}
          </button>
        </div>
      </div>
    </div>
  );
};

const RowMenu: React.FC<{
  session: Session;
  isAgent: boolean;
  x: number; y: number;
  onClose: () => void;
  onRename: (n: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onSettings: () => void;
}> = ({ session, isAgent, x, y, onClose, onRename, onDelete, onSettings }) => {
  const { t: tr } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  // Electron disables window.prompt/confirm, so rename has to use an inline
  // input. Keep the editing UI inside the menu itself for minimal layout work.
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.name || session.title || '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onDoc), 0);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    }
  }, [editing]);

  const commit = () => {
    const v = name.trim();
    if (!v) return;
    void onRename(v);
  };
  const del = () => {
    if (session.is_primary) return;
    void onDelete();
  };

  return (
    <div ref={ref} className="v2-rowmenu" style={{ left: x - 160, top: y }}>
      {editing ? (
        <div className="v2-rowmenu-edit">
          <input
            ref={inputRef}
            className="v2-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            placeholder={tr('shell.rowMenu.namePlaceholder')}
          />
          <div className="v2-rowmenu-edit-foot">
            <button className="v2-btn ghost" onClick={() => setEditing(false)}>{tr('common.cancel')}</button>
            <button className="v2-btn primary" onClick={commit} disabled={!name.trim()}>{tr('common.confirm')}</button>
          </div>
        </div>
      ) : (
        <>
          {isAgent && <button onClick={onSettings}>{tr('shell.rowMenu.agentSettings')}</button>}
          <button onClick={() => setEditing(true)}>{tr('shell.rowMenu.rename')}</button>
          {!session.is_primary && <button className="danger" onClick={del}>{tr('common.delete')}</button>}
        </>
      )}
    </div>
  );
};

/* ============== subcomponents ============== */

/** Markdown surface for assistant prose — GFM (tables, strikethrough, task
 *  lists) + Shiki code highlighting (see codeBlock.tsx). Wrapped in `.v2-md` so the
 *  app's typography rules can scope all child elements without leaking.
 *  Streaming-safe: react-markdown re-parses on each render, but our batched
 *  chunk flushing (32 chars / 16ms) keeps the cost bounded. */
// Module-level constants — hoisted so react-markdown sees stable identity for
// `components` / plugin arrays across renders (otherwise the internal pipeline
// re-builds children even when text is unchanged).
const AnchorBlank: React.FC<any> = ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />;

/** Provider 显示名（与 SettingsModal 保持一致）。 */
const PICK_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini',
  deepseek: 'DeepSeek', qwen: 'Qwen', ollama: 'Ollama',
  local: 'Local', custom: 'Custom',
};
const PICK_PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'ollama', 'local', 'custom'];
/** 按 provider 分组 LLM 配置；命中 PICK_PROVIDER_ORDER 的厂商排在前面，其余 alphabetical。 */
function groupConfigsByProvider(configs: LLMConfigFromDB[]): [string, LLMConfigFromDB[]][] {
  const buckets = new Map<string, LLMConfigFromDB[]>();
  configs.forEach((c) => {
    const k = (c.provider || 'custom').toLowerCase();
    const arr = buckets.get(k);
    if (arr) arr.push(c); else buckets.set(k, [c]);
  });
  return Array.from(buckets.entries()).sort((a, b) => {
    const ai = PICK_PROVIDER_ORDER.indexOf(a[0]);
    const bi = PICK_PROVIDER_ORDER.indexOf(b[0]);
    const aRank = ai < 0 ? 99 : ai;
    const bRank = bi < 0 ? 99 : bi;
    if (aRank !== bRank) return aRank - bRank;
    return a[0].localeCompare(b[0]);
  });
}
// PlainCode strips the `inline` / `node` props that rehypeInlineCodeProperty
// attaches before they leak to the DOM <code> element (react warns about
// unknown boolean attrs). Used in MD_PLAIN (streaming, no Shiki).
const PlainCode: React.FC<any> = ({ node: _n, inline: _i, ...props }) => <code {...props} />;
const MD_REMARK = [remarkGfm];
// hast Element type identity is wobbly across pnpm-deduped @types/hast versions —
// react-markdown's `Components` map insists on its own `Element`, and our
// CodeBlock declares `node?: Element` from `react-shiki/web`'s re-export. The
// runtime contract is identical; cast through `any` once at the boundary.
type MdComponents = React.ComponentProps<typeof ReactMarkdown>['components'];
// Rich = Shiki-highlighted code (settled messages).
const MD_RICH = { a: AnchorBlank, code: CodeBlock as any, pre: PreBlock as any } as MdComponents;
// Plain = react-markdown's default <pre><code> — used during streaming so a
// growing fenced code block doesn't trigger Shiki on every chunk. PlainCode
// is custom only to swallow the `inline` prop.
const MD_PLAIN = { a: AnchorBlank, code: PlainCode } as MdComponents;

const MD: React.FC<{ text: string; live?: boolean }> = React.memo(({ text, live }) => (
  <div className="v2-md">
    <ReactMarkdown
      remarkPlugins={MD_REMARK}
      rehypePlugins={mdRehypePlugins}
      components={live ? MD_PLAIN : MD_RICH}
    >{text}</ReactMarkdown>
  </div>
));
MD.displayName = 'MD';

interface MessageViewProps {
  m: Message;
  showTokens?: boolean;
  onPreviewImage?: (src: string) => void;
  onRevert?: (m: Message) => void;
  onEdit?: (m: Message) => void;
  onQuote?: (m: Message) => void;
  onRerunCreation?: (m: Message) => void;
  /** Open the spec-detail modal for a persisted user creation message. */
  onOpenSpec?: (m: Message) => void;
}
const MessageViewImpl: React.FC<MessageViewProps> = ({ m, showTokens, onPreviewImage, onRevert, onEdit, onQuote, onRerunCreation, onOpenSpec }) => {
  const { t: tr } = useI18n();
  const role = m.role === 'user' ? 'user' : 'assistant';
  // Defensive: some backends (or older persisted rows) hand ext back as a
  // JSON-stringified blob rather than an object. Normalise once so the
  // downstream reads always hit a plain object.
  const ext: any = typeof m.ext === 'string'
    ? (() => { try { return JSON.parse(m.ext as unknown as string); } catch { return {}; } })()
    : (m.ext || {});
  const media = Array.isArray(ext.media) ? ext.media : [];
  // A quote this message carried when sent — surfaced as a chip so the
  // referenced context is visible on reload.
  const quote = ext.quote && typeof ext.quote === 'object' ? ext.quote : null;
  const reasoning = m.role === 'assistant' ? (ext.reasoning || m.thinking || '') : '';
  const spec = ext.creation_spec as Batch['spec'] | undefined;
  const imgSrc = (img: any) => img.data?.startsWith('data:') ? img.data : `data:${img.mimeType};base64,${img.data}`;
  // Caption for assistant creation batches. New rows store it in `content`;
  // older rows (saved before this existed) have empty content — synthesize a
  // fallback so historical images still get a "生成完成 · N 张" header. Older
  // rows lack elapsed_ms, so they just show the count.
  const bubbleText = m.content?.trim()
    ? m.content
    : (m.role === 'assistant' && ext.creation_batch && media.length > 0
        ? creationDoneCaption(media.length, ext.elapsed_ms)
        : '');

  // Quote chip + hover action toolbar, shared across render branches.
  // user → 回退 · 编辑 · 引用; assistant → 引用. Spec cards skip 编辑 (editing an
  // image spec as plain text would be lossy).
  const quoteChip = quote ? (
    <div className="v2-quote-cite" title={quote.content || ''}>
      <IconQuote />
      <span className="v2-quote-cite-tag">{quote.role === 'assistant' ? tr('shell.quote.citeReply') : tr('shell.quote.cite')}</span>
      <span className="v2-quote-cite-text">{truncate(quote.content || '', 60)}</span>
    </div>
  ) : null;
  // @-referenced knowledge domains this message rode — shown as a chip so the
  // citation is visible on send and on reload.
  const refDomains: string[] = Array.isArray(ext.knowledge_domains)
    ? ext.knowledge_domains.filter((x: unknown): x is string => typeof x === 'string' && !!x)
    : [];
  const domainCite = refDomains.length > 0 ? (
    <div className="v2-domain-cite" title={tr('shell.domain.citeTip', { domains: refDomains.join('、') })}>
      <span className="v2-domain-cite-tag">{tr('shell.domain.cited')}</span>
      {refDomains.map((name) => (
        <span key={name} className="v2-domain-cite-pill">
          <span className="dot" />
          {name}
        </span>
      ))}
    </div>
  ) : null;
  // Marker for create-mode user messages that can be re-fired with the same
  // spec. Newer messages carry the explicit flag; older ones still match by
  // having a creation_spec attached.
  const canRerun = m.role === 'user' && (ext.creation_retriggerable === true || !!spec);
  const actions = (
    <div className="v2-msg-actions">
      {m.role === 'user' && onRevert && (
        <button className="v2-msg-act" title={tr('shell.msg.revert')} onClick={() => onRevert(m)}><IconRevert /></button>
      )}
      {m.role === 'user' && !spec && onEdit && (
        <button className="v2-msg-act" title={tr('shell.msg.edit')} onClick={() => onEdit(m)}><IconEdit /></button>
      )}
      {canRerun && onRerunCreation && (
        <button
          className="v2-msg-act"
          title={tr('shell.msg.rerun')}
          onClick={() => onRerunCreation(m)}
        >
          {/* Inline so we don't have to wire a new icon export. */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      )}
      {onQuote && (
        <button className="v2-msg-act" title={tr('shell.msg.quote')} onClick={() => onQuote(m)}><IconQuote /></button>
      )}
    </div>
  );

  // User-side create spec: render chips + ref thumbs inside the bubble.
  if (m.role === 'user' && spec) {
    const { label: modelLabel, muted: modelMuted } = specModelLabel(spec);
    const openDetail = () => onOpenSpec?.(m);
    return (
      <div className="v2-msg user">
        <div className="v2-body" style={{ maxWidth: '90%' }}>
          {quoteChip}
          {domainCite}
          <div
            className={`v2-bubble v2-spec${onOpenSpec ? ' v2-spec-clickable' : ''}`}
            role={onOpenSpec ? 'button' : undefined}
            tabIndex={onOpenSpec ? 0 : undefined}
            aria-label={onOpenSpec ? tr('shell.spec.viewDetailAria') : undefined}
            title={onOpenSpec ? tr('shell.spec.viewTitle') : undefined}
            onClick={onOpenSpec ? openDetail : undefined}
            onKeyDown={onOpenSpec ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); } } : undefined}
          >
            <div className="v2-spec-chips">
              <span className="v2-spec-chip"><IconAspect />{spec.aspect}</span>
              <span className="v2-spec-chip">× {spec.count}</span>
              {spec.style?.trim() && <span className="v2-spec-chip" title={spec.style}>{tr('shell.create.styleChip')} · {truncate(spec.style, 20)}</span>}
              {spec.negative?.trim() && <span className="v2-spec-chip" title={spec.negative}>{tr('shell.create.negativeChip')} · {truncate(spec.negative, 16)}</span>}
            </div>
            {m.content?.trim() && <p style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{m.content}</p>}
            {media.length > 0 && (
              <div className="v2-spec-refs">
                {media.filter((x: any) => x.type === 'image').map((img: any, i: number) => (
                  // 阻止冒泡到气泡 onClick，避免点缩略图同时打开详情弹框。
                  <div key={i} className="v2-spec-ref" onClick={(e) => { e.stopPropagation(); onPreviewImage?.(imgSrc(img)); }}>
                    <img src={imgSrc(img)} alt={`#${i + 1}`} />
                  </div>
                ))}
              </div>
            )}
            <span className={`v2-spec-stamp${modelMuted ? ' muted' : ''}`} aria-hidden>
              <i className="dot" />{modelLabel}
            </span>
          </div>
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className={`v2-msg ${role}`}>
      <div className="v2-body">
        {quoteChip}
        {domainCite}
        {reasoning && <ThinkBlock reasoning={reasoning} streaming={false} hasContent={!!bubbleText} />}
        {bubbleText && (
          <div className="v2-bubble">
            {/* User input stays as plain pre-wrap (no markdown surprises);
                assistant gets full markdown rendering. */}
            {role === 'user'
              ? <p style={{ whiteSpace: 'pre-wrap' }}>{bubbleText}</p>
              : <MD text={bubbleText} />}
          </div>
        )}
        {media.length > 0 && (
          <div className="v2-imgs" data-mid={m.message_id} data-mcount={media.length}>
            {/* Don't pre-filter by `type` — older / older-format persisted rows
             *  occasionally have type omitted or set to something we don't
             *  recognise, which previously made AI-generated assistant images
             *  invisible after reload. We just trust anything with a `data`
             *  payload and render it as <img>. */}
            {media.filter((x: any) => !!x?.data || !!x?.url).map((img: any, i: number) => {
              const src = imgSrc(img);
              return (
                <div
                  key={i}
                  className="v2-ph clickable"
                  onClick={() => onPreviewImage?.(src)}
                >
                  <img src={src} alt="" />
                </div>
              );
            })}
          </div>
        )}
        {showTokens && m.role === 'assistant' && m.token_count != null && (
          <div className="v2-tokens">{m.token_count} tokens</div>
        )}
        {actions}
      </div>
    </div>
  );
};
/* React.memo with default shallow compare. Stream chunks update `stream`
 * upstream but `messages[]` stays referentially stable; with this memo every
 * past MessageView short-circuits on each chunk render. The callbacks below
 * are also stabilised at the call-site via useCallback so this isn't defeated. */
const MessageView = React.memo(MessageViewImpl);

/** Confirm dialog for the two destructive rewind actions (回退 / 回退并编辑).
 *  Both delete the target message and everything after it, so we gate them
 *  behind an explicit confirm. Esc / backdrop cancels; Enter confirms. */
const ConfirmRewind: React.FC<{
  kind: 'revert' | 'edit' | 'rerun';
  preview: string;
  /** rerun only: model recorded in the historical message's creation_spec. */
  historicalModel?: string;
  /** rerun only: model currently selected in the create-mode picker. */
  liveModel?: string;
  onConfirm: (opts?: { useLiveModel?: boolean }) => void;
  onCancel: () => void;
}> = ({ kind, preview, historicalModel, liveModel, onConfirm, onCancel }) => {
  const { t: tr } = useI18n();
  // Default to the frozen historical model — "记住当时" is the documented
  // semantic. The user can flip to the live picker per-rerun when they need
  // to escape a snapshot whose model is broken (e.g. Gemini geo-blocked).
  const [useLive, setUseLive] = useState(false);
  const canOverride = kind === 'rerun'
    && !!historicalModel && !!liveModel && historicalModel !== liveModel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm(kind === 'rerun' ? { useLiveModel: useLive } : undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel, kind, useLive]);
  const title = kind === 'rerun' ? tr('shell.rewind.titleRerun')
    : kind === 'edit' ? tr('shell.rewind.titleEdit')
    : tr('shell.rewind.titleRevert');
  const cta = kind === 'rerun' ? tr('shell.rewind.ctaRerun') : kind === 'edit' ? tr('shell.rewind.ctaEdit') : tr('shell.rewind.ctaRevert');
  return (
    <div className="v2-confirm-backdrop" onClick={onCancel}>
      <div className="v2-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="v2-confirm-title">{title}</div>
        <div className="v2-confirm-quote">“{preview}”</div>
        <div className="v2-confirm-body">
          {kind === 'rerun' ? (
            <>{tr('shell.rewind.bodyRerunA')}<strong>{tr('shell.rewind.bodyRerunStrong')}</strong>{tr('shell.rewind.bodyRerunB')}</>
          ) : (
            <>{tr('shell.rewind.bodyA')}<strong>{tr('shell.rewind.bodyStrong')}</strong>{tr('shell.rewind.bodyB')}</>
          )}
          {kind === 'edit' && tr('shell.rewind.editExtra')}
        </div>
        {kind === 'rerun' && historicalModel && (
          <div className="v2-confirm-body" style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'var(--c-paper-2, rgba(0,0,0,0.04))' }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{tr('shell.rewind.willUseModel')}</div>
            <div style={{ marginTop: 4, fontWeight: 600 }}>
              {useLive ? (liveModel || tr('shell.rewind.currentChoice')) : historicalModel}
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, opacity: 0.6 }}>
                {useLive ? tr('shell.rewind.fromPicker') : tr('shell.rewind.fromOriginal')}
              </span>
            </div>
            {canOverride && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={useLive}
                  onChange={(e) => setUseLive(e.target.checked)}
                />
                <span>{tr('shell.rewind.useCurrentModel')} <code style={{ padding: '0 4px', borderRadius: 4, background: 'rgba(0,0,0,0.08)' }}>{liveModel}</code></span>
              </label>
            )}
          </div>
        )}
        <div className="v2-confirm-actions">
          <button className="v2-btn ghost" onClick={onCancel}>{tr('common.cancel')}</button>
          <button
            className="v2-btn danger"
            onClick={() => onConfirm(kind === 'rerun' ? { useLiveModel: useLive } : undefined)}
          >{cta}</button>
        </div>
      </div>
    </div>
  );
};

/** Collapsible reasoning ("Thinking") block. Auto-expanded during streaming
 *  while the answer hasn't started; collapses on its own once content begins
 *  to flow so the answer becomes the primary surface. */
const ThinkBlock: React.FC<{ reasoning: string; streaming: boolean; hasContent: boolean }> = ({
  reasoning, streaming, hasContent,
}) => {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(streaming && !hasContent);
  useEffect(() => {
    if (streaming && hasContent) setOpen(false);
  }, [streaming, hasContent]);
  return (
    <details className="v2-think" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="v2-think-ic">💭</span>
        <span>{streaming && !hasContent ? tr('shell.think.thinking') : tr('shell.think.process')}</span>
        <span className="v2-think-len">{tr('shell.think.chars', { n: reasoning.length.toLocaleString() })}</span>
      </summary>
      <div className="v2-think-body">{reasoning}</div>
    </details>
  );
};

/** Fullscreen image preview with a download action. Esc / backdrop close. */
const ImagePreview: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  const { t: tr } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const download = () => {
    const a = document.createElement('a');
    a.href = src;
    // Try to give the file a sane extension from the data URI's mime type.
    const m = /^data:image\/([a-zA-Z0-9.+-]+);/.exec(src);
    const ext = (m && m[1]) ? m[1].replace('jpeg', 'jpg') : 'png';
    a.download = `chaya-${Date.now()}.${ext}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };
  return (
    <div className="v2-imgpreview" onClick={onClose}>
      {/* Controls grouped in one top-right toolbar — both easy to find and hit,
          clear of the centered image so a click on the backdrop still closes. */}
      <div className="v2-imgpreview-bar" onClick={(e) => e.stopPropagation()}>
        <button
          className="v2-imgpreview-dl"
          title={tr('shell.preview.download')}
          onClick={(e) => { e.stopPropagation(); download(); }}
        >
          <IconDownload /><span>{tr('shell.preview.download')}</span>
        </button>
        <button className="v2-imgpreview-close" title={tr('shell.preview.close')} onClick={onClose}>✕</button>
      </div>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  );
};

/** A user-side "spec card" rendered above each creation batch — chips for
 *  aspect / count / style / negative, the prompt, and small ref thumbs.
 *  Acts as the user's outgoing message in the chat stream so the dialogue
 *  remains chronological. */
/** 把 spec 的 provider/model 翻译成「市场名」—— 优先用人话（GPT-Image / Flux），
 *  没有匹配则降级到 model 本体；都没有就标"未知模型"。 */
function specModelLabel(spec: Batch['spec']): { label: string; muted: boolean } {
  const m = (spec.model || '').trim();
  const p = (spec.provider || '').toLowerCase();
  // 常见图像模型 → 友好名
  const friendly: Array<[RegExp, string]> = [
    [/^gpt-image/i, 'GPT-Image'],
    [/^dall[-_]?e[-_]?3/i, 'DALL·E 3'],
    [/^dall[-_]?e/i, 'DALL·E'],
    [/^flux[-_].*pro/i, 'Flux Pro'],
    [/^flux/i, 'Flux'],
    [/^imagen/i, 'Imagen'],
    [/midjourney|^mj/i, 'Midjourney'],
    [/^sd[-_]?xl/i, 'SDXL'],
    [/stable[-_]?diffusion/i, 'Stable Diffusion'],
    [/^gemini.*image/i, 'Gemini Image'],
  ];
  for (const [re, name] of friendly) if (re.test(m)) return { label: name, muted: false };
  if (m) return { label: m, muted: false };
  if (p && PICK_PROVIDER_LABELS[p]) return { label: PICK_PROVIDER_LABELS[p], muted: false };
  return { label: t('shell.unknownModel'), muted: true };
}

const CreateSpecCard: React.FC<{ b: Batch; onOpenDetail: () => void }> = ({ b, onOpenDetail }) => {
  const { t: tr } = useI18n();
  const { aspect, count, style, negative, refs } = b.spec;
  const { label: modelLabel, muted: modelMuted } = specModelLabel(b.spec);
  return (
    <div className="v2-msg user">
      <div className="v2-body" style={{ maxWidth: '90%' }}>
        <div
          className="v2-bubble v2-spec v2-spec-clickable"
          role="button"
          tabIndex={0}
          aria-label={tr('shell.spec.viewDetailAria')}
          title={tr('shell.spec.viewTitle')}
          onClick={onOpenDetail}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(); } }}
        >
          <div className="v2-spec-chips">
            <span className="v2-spec-chip"><IconAspect />{aspect}</span>
            <span className="v2-spec-chip">× {count}</span>
            {style.trim() && <span className="v2-spec-chip" title={style}>{tr('shell.create.styleChip')} · {truncate(style, 20)}</span>}
            {negative.trim() && <span className="v2-spec-chip" title={negative}>{tr('shell.create.negativeChip')} · {truncate(negative, 16)}</span>}
          </div>
          {b.promptDisplay.trim() && (
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{b.promptDisplay}</p>
          )}
          {refs.length > 0 && (
            <div className="v2-spec-refs">
              {refs.map((r, i) => (
                <div key={r.id} className="v2-spec-ref" title={r.directive || `#${i + 1}`}>
                  <img src={`data:${r.mimeType};base64,${r.data}`} alt={`#${i + 1}`} />
                </div>
              ))}
            </div>
          )}
          {/* 右下角小角章：谁画的。整气泡都可点，标签不单独 stopPropagation。 */}
          <span className={`v2-spec-stamp${modelMuted ? ' muted' : ''}`} aria-hidden>
            <i className="dot" />{modelLabel}
          </span>
        </div>
      </div>
    </div>
  );
};

/** 创作配方详情：只读，配套外部已有的"重新生成"入口（这里不放主操作）。 */
const CreateSpecDetailModal: React.FC<{
  b: Batch;
  onClose: () => void;
  onPreviewImage: (src: string) => void;
}> = ({ b, onClose, onPreviewImage }) => {
  const { t: tr } = useI18n();
  const { aspect, count, style, negative, refs, model, provider } = b.spec;
  const { label: modelLabel } = specModelLabel(b.spec);
  const prompt = b.promptDisplay.trim();
  const [copied, setCopied] = useState(false);
  const onCopyPrompt = async () => {
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); } catch { /* ignore */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Modal
      title={tr('shell.spec.recipe')}
      subtitle={modelLabel}
      wide
      onClose={onClose}
    >
      <div className="v2-modal-sec">
        <div className="lab">{tr('shell.spec.config')}</div>
        <div className="v2-spec-chips">
          <span className="v2-spec-chip"><IconAspect />{aspect}</span>
          <span className="v2-spec-chip">× {tr('shell.spec.countN', { n: count })}</span>
          {style.trim() && <span className="v2-spec-chip" title={style}>{tr('shell.create.styleChip')} · {truncate(style, 28)}</span>}
          {negative.trim() && <span className="v2-spec-chip" title={negative}>{tr('shell.create.negativeChip')} · {truncate(negative, 22)}</span>}
          {(model || provider) && (
            <span className="v2-spec-chip" title={`${provider || ''}${model ? ` · ${model}` : ''}`}>
              {tr('shell.spec.modelChip')} · {model || PICK_PROVIDER_LABELS[(provider || '').toLowerCase()] || provider}
            </span>
          )}
        </div>
      </div>

      <div className="v2-modal-sec">
        <div className="lab" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{tr('shell.spec.prompt')}</span>
          {prompt && (
            <button
              type="button"
              className="v2-mini-copy"
              onClick={onCopyPrompt}
              title={copied ? tr('shell.spec.copied') : tr('shell.spec.copyPrompt')}
              aria-label={tr('shell.spec.copyPrompt')}
            >
              {copied ? <IconCheck /> : <IconCopy />}
              <span>{copied ? tr('shell.spec.copied') : tr('shell.spec.copy')}</span>
            </button>
          )}
        </div>
        {prompt ? (
          <pre className="v2-spec-prompt">{prompt}</pre>
        ) : (
          <div className="v2-modal-note">{tr('shell.spec.refsOnly')}</div>
        )}
      </div>

      {negative.trim() && (
        <div className="v2-modal-sec">
          <div className="lab">{tr('shell.spec.negativePrompt')}</div>
          <pre className="v2-spec-prompt v2-spec-prompt-neg">{negative.trim()}</pre>
        </div>
      )}

      {refs.length > 0 && (
        <div className="v2-modal-sec">
          <div className="lab">{tr('shell.spec.refImages')} · {refs.length}</div>
          <div className="v2-spec-refs v2-spec-refs-lg">
            {refs.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className="v2-spec-ref"
                title={r.directive || `#${i + 1}`}
                onClick={() => onPreviewImage(`data:${r.mimeType};base64,${r.data}`)}
              >
                <img src={`data:${r.mimeType};base64,${r.data}`} alt={r.directive || tr('shell.spec.refN', { n: i + 1 })} />
                {r.directive && <span className="v2-spec-ref-directive">{truncate(r.directive, 22)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
};

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

/** Retrieve the picked knowledge domains' top chunks for `query` (union across
 *  domains, deduped, score-ranked) and shape them as ext.knowledge entries the
 *  backend folds into the prompt. Per-domain topK is small so a few domains
 *  don't blow the context budget. */
async function fetchDomainKnowledge(
  query: string,
  domainNames: string[],
): Promise<Array<{ kind: string; content: string; pinned: boolean; domain?: string }>> {
  const perDomainTopK = domainNames.length > 2 ? 4 : 6;
  const settled = await Promise.allSettled(
    domainNames.map((name) =>
      smartnoteRetrieve({ query, tags: [name], topk: perDomainTopK }).then((r) => ({ name, results: r.results || [] })),
    ),
  );
  const seen = new Set<string>();
  const rows: Array<{ kind: string; content: string; pinned: boolean; domain: string; score: number }> = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value.results) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push({ kind: r.kind || 'memory', content: r.content, pinned: !!r.pinned, domain: s.value.name, score: r.score });
    }
  }
  // Pinned first, then by score; cap total so context stays bounded.
  rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.score - a.score));
  return rows.slice(0, 12).map(({ kind, content, pinned, domain }) => ({ kind, content, pinned, domain }));
}

/** Persist a creation turn's user spec card into the conversation so the
 *  full dialogue survives a reload. Uses the saveMessage endpoint with an
 *  `ext.creation_spec` blob alongside `ext.media` (the ref images). */
async function persistCreationUserSpec(
  sid: string,
  prompt: string,
  spec: Batch['spec'],
): Promise<void> {
  const media = spec.refs.map((r) => ({ type: 'image', mimeType: r.mimeType, data: r.data }));
  const ext: any = {
    creation_spec: {
      aspect: spec.aspect, count: spec.count, style: spec.style,
      negative: spec.negative,
      refs: spec.refs.map((r) => ({ directive: r.directive, mimeType: r.mimeType })),
      configId: spec.configId, model: spec.model, provider: spec.provider,
    },
    // Marks the message as eligible for the 重新生成 quick action — the UI keys
    // off this flag rather than sniffing `creation_spec` so future non-rerunnable
    // creation messages can opt out cleanly.
    creation_retriggerable: true,
  };
  if (media.length > 0) ext.media = media;
  await api.post(`/api/sessions/${sid}/messages`, {
    role: 'user', content: prompt, source: 'create', ext,
  });
}

/** Persist the assistant-side images for a settled batch. Stores all
 *  generated image data-URIs as `ext.media`. */
async function persistCreationAssistantImages(sid: string, b: Batch): Promise<void> {
  const media = b.slots
    .map((s, i) => ({ s, err: b.errors[i] }))
    .filter((x) => !!x.s)
    .map(({ s }) => {
      // s is a data: URI; split out mime + base64
      const m = /^data:([^;]+);base64,(.+)$/.exec(s!);
      if (!m) return { type: 'image', mimeType: 'image/png', data: s! };
      return { type: 'image', mimeType: m[1], data: m[2] };
    });
  if (media.length === 0) return; // nothing produced; skip persisting
  // Caption: "生成完成 · N 张 · 耗时 X.Xs" lives in `content` so it renders above
  // the images on reload exactly like the live batch — no special-casing needed.
  await api.post(`/api/sessions/${sid}/messages`, {
    role: 'assistant', content: creationDoneCaption(media.length, b.elapsedMs),
    source: 'create', ext: { media, creation_batch: true, elapsed_ms: b.elapsedMs },
  });
}

/** Persist a failed creation batch as an assistant message so the error shows
 *  up as the AI's reply (and survives reload), instead of vanishing with the
 *  live batch. Used when a batch produced no images — every slot errored
 *  (e.g. Gemini's "User location is not supported for the API use" geo-block). */
async function persistCreationError(sid: string, errors: string[]): Promise<void> {
  const uniq = Array.from(new Set(errors.map((e) => (e || '').trim()).filter(Boolean)));
  const detail = uniq.length ? uniq.join('\n\n') : t('shell.create.unknownError');
  await api.post(`/api/sessions/${sid}/messages`, {
    role: 'assistant',
    content: `${t('shell.create.genFailed')}\n\n${detail}`,
    source: 'create',
    ext: { creation_error: true },
  });
}

/** Human caption for a finished creation batch, e.g. "生成完成 · 4 张 · 耗时 12.3s". */
function creationDoneCaption(n: number, elapsedMs?: number): string {
  let s = t('shell.create.doneCaption', { n });
  if (elapsedMs && elapsedMs > 0) s += t('shell.create.doneElapsed', { sec: (elapsedMs / 1000).toFixed(1) });
  return s;
}

const BatchView: React.FC<{ b: Batch; onPreviewImage?: (src: string) => void }> = React.memo(({ b, onPreviewImage }) => {
  const { t: tr } = useI18n();
  // Live elapsed counter for pending batches. gpt-image-2 takes 30-60s end to
  // end; without a visible timer the shimmer-only state feels broken. We tick
  // every 500ms (cheap enough; only one batch is pending at a time) and stop
  // as soon as the batch settles. Settled batches show the final elapsedMs.
  const [elapsedSec, setElapsedSec] = useState<number>(
    b.pending && b.startedAt ? Math.floor((Date.now() - b.startedAt) / 1000) : 0,
  );
  useEffect(() => {
    if (!b.pending || !b.startedAt) return;
    const tick = () => setElapsedSec(Math.floor((Date.now() - (b.startedAt || 0)) / 1000));
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [b.pending, b.startedAt]);
  return (
    <div className="v2-msg assistant">
      <div className="v2-body">
        <p style={{ color: 'var(--c-ink-3)', fontSize: 13 }}>
          {b.pending
            ? tr('shell.batch.drawing', { n: b.slots.length, sec: elapsedSec })
            : creationDoneCaption(b.slots.filter(Boolean).length, b.elapsedMs)}
        </p>
        <div className="v2-imgs">
          {b.slots.map((s, i) => (
            <div key={i} className={`v2-ph${s ? ' clickable' : ''}`} onClick={s ? () => onPreviewImage?.(s) : undefined}>
              {s ? <img src={s} alt={`#${i + 1}`} /> :
                b.errors[i] ? <span style={{ fontSize: 11, color: 'var(--c-ink-4)' }} title={b.errors[i] || ''}>{tr('shell.batch.failed')}</span> :
                <span className="v2-shimmer-tile" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});
BatchView.displayName = 'BatchView';

const RefPill: React.FC<{ idx: number; r: RefImage; onChange: (v: string) => void; onRemove: () => void; onPreview?: () => void }> = ({ idx, r, onChange, onRemove, onPreview }) => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-ref">
    <div className="v2-th">
      <img src={`data:${r.mimeType};base64,${r.data}`} alt={`#${idx}`} onClick={onPreview} />
      <span className="v2-th-idx">#{idx}</span>
    </div>
    <button className="v2-rm" onClick={onRemove} title={tr('common.delete')} aria-label={tr('common.delete')}>✕</button>
    <input
      className="v2-dir"
      placeholder={tr('shell.refPill.placeholder', { idx })}
      value={r.directive}
      onChange={(e) => onChange(e.target.value)}
    />
  </div>
  );
};

const GalleryView: React.FC = () => {
  const { t: tr } = useI18n();
  const [items, setItems] = useState<MediaOutputItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<MediaOutputItem | null>(null);
  // Select mode keys off `selectMode` rather than `selected.size > 0` so the
  // user can enter selection without picking anything first (and so an empty
  // selection still shows the "退出选择" affordance instead of silently exiting).
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    mediaApi.listOutputs(120, 0)
      .then((res) => { if (!cancelled) setItems(res.items || []); })
      .catch((e) => { console.warn('[v2] listOutputs failed', e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => reload(), [reload]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (preview) setPreview(null);
        else if (confirmDel) setConfirmDel(false);
        else if (selectMode) { setSelectMode(false); setSelected(new Set()); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, confirmDel, selectMode]);

  // Group items by their YYYY-MM-DD created_at, descending. Stable order
  // within a group (server returns desc by created_at).
  const groups = useMemo(() => {
    const byDay = new Map<string, MediaOutputItem[]>();
    for (const it of items) {
      const key = (it.created_at || '').slice(0, 10) || tr('shell.gallery.unknownDate');
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(it);
    }
    return Array.from(byDay.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [items, tr]);

  // Stable callbacks so the memoized GalleryGroup / GalleryTile don't re-mount
  // every selection toggle. Without useCallback the prop identity flips on
  // each render and React.memo's shallow compare always fails.
  const toggleOne = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleGroup = useCallback((ids: string[]) => {
    setSelected((s) => {
      const next = new Set(s);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allOn) next.delete(id); else next.add(id);
      }
      return next;
    });
  }, []);
  const selectAll = useCallback(
    () => setSelected(new Set(items.map((it) => it.output_id))),
    [items],
  );
  const clearSel = useCallback(() => setSelected(new Set()), []);
  const exitSelect = useCallback(() => { setSelectMode(false); setSelected(new Set()); }, []);

  const runBatchDelete = async () => {
    if (selected.size === 0) { setConfirmDel(false); return; }
    setDeleting(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => mediaApi.deleteOutput(id)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setDeleting(false);
    setConfirmDel(false);
    // Optimistically drop the deleted ones from the local list so the UI doesn't
    // flash the just-deleted tiles before the reload finishes. Anything that
    // server-side failed will come back on the reload.
    setItems((cur) => cur.filter((it) => !selected.has(it.output_id)));
    setSelected(new Set());
    setSelectMode(false);
    reload();
    if (failed > 0) {
      console.warn(`[v2] gallery delete: ${failed}/${ids.length} failed`);
    }
  };

  if (loading && items.length === 0) {
    return <div className="v2-view"><div className="v2-view-head"><h2>{tr('shell.nav.gallery')}</h2></div></div>;
  }
  if (items.length === 0) {
    return (
      <div className="v2-view">
        <div className="v2-view-head"><h2>{tr('shell.nav.gallery')}</h2></div>
        <div className="v2-gallery-empty">
          <div className="h">{tr('shell.gallery.empty')}</div>
        </div>
      </div>
    );
  }

  const headerActions = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
      {!selectMode && (
        <button className="v2-btn ghost" onClick={() => setSelectMode(true)}>{tr('shell.gallery.select')}</button>
      )}
      {selectMode && (
        <>
          <span style={{ fontSize: 12, opacity: 0.7 }}>{tr('shell.gallery.selectedCount', { n: selected.size, total: items.length })}</span>
          <button className="v2-btn ghost" onClick={selected.size === items.length ? clearSel : selectAll}>
            {selected.size === items.length ? tr('shell.gallery.clear') : tr('shell.gallery.selectAll')}
          </button>
          <button
            className="v2-btn danger"
            disabled={selected.size === 0 || deleting}
            onClick={() => setConfirmDel(true)}
          >{tr('shell.gallery.deleteSelected')}</button>
          <button className="v2-btn ghost" onClick={exitSelect}>{tr('shell.gallery.exitSelect')}</button>
        </>
      )}
    </div>
  );

  return (
    <div className="v2-view">
      <div className="v2-view-head">
        <h2>{tr('shell.nav.gallery')}</h2>
        <span className="v2-view-count">{items.length}</span>
        {headerActions}
      </div>
      {groups.map(([day, list]) => (
        <GalleryGroup
          key={day}
          day={day}
          list={list}
          selected={selected}
          selectMode={selectMode}
          onToggleGroup={toggleGroup}
          onToggleOne={toggleOne}
          onPreview={setPreview}
        />
      ))}
      {preview && (
        <div className="v2-lightbox" onClick={() => setPreview(null)}>
          <div className="v2-lb-close">✕</div>
          {preview.media_type === 'video'
            ? <video src={mediaApi.getOutputFileUrl(preview.output_id)} controls autoPlay />
            : <img src={mediaApi.getOutputFileUrl(preview.output_id)} alt="" />}
        </div>
      )}
      {confirmDel && (
        <div className="v2-confirm-backdrop" onClick={() => !deleting && setConfirmDel(false)}>
          <div className="v2-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="v2-confirm-title">{tr('shell.gallery.deleteConfirmTitle', { n: selected.size })}</div>
            <div className="v2-confirm-body">
              {tr('shell.gallery.deleteConfirmBodyA')}<strong>{tr('shell.gallery.deleteConfirmStrong')}</strong>{tr('shell.gallery.deleteConfirmBodyB')}
            </div>
            <div className="v2-confirm-actions">
              <button className="v2-btn ghost" disabled={deleting} onClick={() => setConfirmDel(false)}>{tr('common.cancel')}</button>
              <button className="v2-btn danger" disabled={deleting} onClick={() => void runBatchDelete()}>
                {deleting ? tr('shell.gallery.deleting') : tr('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* Hoisted Gallery style constants — previously these were 4 fresh objects
   per tile per render (with 120 items that's 480 allocations on every
   selection toggle). Static literals now share references across renders. */
const GALLERY_GROUP_STYLE = { marginBottom: 24 } as const;
const GALLERY_DAY_HEAD_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 4px',
  borderBottom: '1px solid var(--c-rule, rgba(0,0,0,0.08))', marginBottom: 10,
};
const GALLERY_DAY_TITLE_STYLE: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const GALLERY_DAY_COUNT_STYLE: React.CSSProperties = { fontSize: 12, opacity: 0.6 };
const GALLERY_DAY_TOGGLE_STYLE: React.CSSProperties = { marginLeft: 'auto', fontSize: 12, padding: '2px 8px' };
const GALLERY_TILE_SEL_STYLE: React.CSSProperties = { outline: '3px solid var(--c-accent, #2b6cb0)', outlineOffset: -3 };
const GALLERY_CHECK_BASE_STYLE: React.CSSProperties = {
  position: 'absolute', top: 6, left: 6, width: 22, height: 22,
  borderRadius: '50%',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 13, fontWeight: 700, border: '1px solid rgba(0,0,0,0.15)',
  boxShadow: '0 1px 3px rgba(0,0,0,0.2)', zIndex: 2,
  pointerEvents: 'none',
};
const GALLERY_CHECK_ON_STYLE: React.CSSProperties = {
  ...GALLERY_CHECK_BASE_STYLE,
  background: 'var(--c-accent, #2b6cb0)', color: 'white',
};
const GALLERY_CHECK_OFF_STYLE: React.CSSProperties = {
  ...GALLERY_CHECK_BASE_STYLE,
  background: 'rgba(255,255,255,0.85)', color: 'var(--c-ink-3)',
};

interface GalleryTileProps {
  it: MediaOutputItem;
  isSel: boolean;
  selectMode: boolean;
  onToggleOne: (id: string) => void;
  onPreview: (it: MediaOutputItem) => void;
}
const GalleryTile = React.memo<GalleryTileProps>(({ it, isSel, selectMode, onToggleOne, onPreview }) => {
  const { t: tr } = useI18n();
  const url = mediaApi.getOutputFileUrl(it.output_id);
  const title = (it.prompt || '').split(/[.。\n]/)[0].slice(0, 40);
  return (
    <div
      className={`v2-gtile${isSel ? ' selected' : ''}`}
      style={isSel ? GALLERY_TILE_SEL_STYLE : undefined}
      onClick={() => selectMode ? onToggleOne(it.output_id) : onPreview(it)}
    >
      {selectMode && (
        <div style={isSel ? GALLERY_CHECK_ON_STYLE : GALLERY_CHECK_OFF_STYLE}>
          {isSel ? '✓' : ''}
        </div>
      )}
      {it.media_type === 'video' && <span className="v2-vidbadge">VIDEO</span>}
      {it.media_type === 'video'
        ? <video src={url} muted />
        : <img src={url} alt={title} loading="lazy" />}
      <div className="v2-meta">{title || tr('shell.gallery.untitled')}</div>
    </div>
  );
});
GalleryTile.displayName = 'GalleryTile';

interface GalleryGroupProps {
  day: string;
  list: MediaOutputItem[];
  selected: Set<string>;
  selectMode: boolean;
  onToggleGroup: (ids: string[]) => void;
  onToggleOne: (id: string) => void;
  onPreview: (it: MediaOutputItem) => void;
}
const GalleryGroup = React.memo<GalleryGroupProps>(({
  day, list, selected, selectMode, onToggleGroup, onToggleOne, onPreview,
}) => {
  const { t: tr } = useI18n();
  // ids + count computed in a single pass instead of map() + filter() over
  // the same list — keeps the hot path tight when selection toggles.
  const ids = useMemo(() => list.map((x) => x.output_id), [list]);
  const allInDay = useMemo(() => {
    if (ids.length === 0) return false;
    for (const id of ids) if (!selected.has(id)) return false;
    return true;
  }, [ids, selected]);
  return (
    <div style={GALLERY_GROUP_STYLE}>
      <div style={GALLERY_DAY_HEAD_STYLE}>
        <div style={GALLERY_DAY_TITLE_STYLE}>{dayLabel(day)}</div>
        <div style={GALLERY_DAY_COUNT_STYLE}>{tr('shell.gallery.itemsCount', { n: list.length })}</div>
        {selectMode && (
          <button
            className="v2-btn ghost"
            style={GALLERY_DAY_TOGGLE_STYLE}
            onClick={() => onToggleGroup(ids)}
          >
            {allInDay ? tr('shell.gallery.unselectDay') : tr('shell.gallery.selectDay', { n: list.length })}
          </button>
        )}
      </div>
      <div className="v2-gallery">
        {list.map((it) => (
          <GalleryTile
            key={it.output_id}
            it={it}
            isSel={selected.has(it.output_id)}
            selectMode={selectMode}
            onToggleOne={onToggleOne}
            onPreview={onPreview}
          />
        ))}
      </div>
    </div>
  );
});
GalleryGroup.displayName = 'GalleryGroup';

/** Friendly date heading for a YYYY-MM-DD key — "今天 / 昨天 / 周X · 2026-05-28". */
function dayLabel(ymdKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymdKey)) return ymdKey;
  const today = new Date();
  const todayKey = isoYMD(today);
  if (ymdKey === todayKey) return `${t('shell.gallery.today')} · ${ymdKey}`;
  const yd = new Date(today); yd.setDate(yd.getDate() - 1);
  if (ymdKey === isoYMD(yd)) return `${t('shell.gallery.yesterday')} · ${ymdKey}`;
  const d = new Date(ymdKey + 'T00:00:00');
  const wd = [
    t('shell.weekday.sun'), t('shell.weekday.mon'), t('shell.weekday.tue'),
    t('shell.weekday.wed'), t('shell.weekday.thu'), t('shell.weekday.fri'), t('shell.weekday.sat'),
  ][d.getDay()] || '';
  return `${wd} · ${ymdKey}`;
}
function isoYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const ModelBadge: React.FC<{
  mode: Mode;
  configs: LLMConfigFromDB[];
  activeRecord: Session | undefined;
  createConfig: { configId?: string; model?: string };
  settingsDefault?: string;
  onClick: () => void;
}> = ({ mode, configs, activeRecord, createConfig, settingsDefault, onClick }) => {
  const { t: tr } = useI18n();
  let label: string; let sub: string;
  if (mode === 'create') {
    const id = createConfig.configId;
    const cfg = id ? configs.find((c) => c.config_id === id) : undefined;
    label = cfg ? (cfg.shortname || cfg.name) : tr('shell.defaultCreate');
    sub = cfg?.model || createConfig.model || 'gemini-2.5-flash-image';
  } else {
    const id = activeRecord?.llm_config_id || settingsDefault;
    const cfg = id ? configs.find((c) => c.config_id === id) : undefined;
    label = cfg ? (cfg.shortname || cfg.name) : tr('shell.defaultModel');
    sub = cfg?.model || cfg?.provider || '';
  }
  return (
    <button className="v2-modelbadge" onClick={onClick} title={tr('shell.switchModel')}>
      <span className="nm">{label}</span>
      {sub && <span className="sub">{sub}</span>}
    </button>
  );
};

const ContextPopover: React.FC<{
  mode: Mode;
  isAgent: boolean;
  activeRecord: Session | undefined;
  createConfigId?: string;
  onClose: () => void;
  onPickModel: (cfg: LLMConfigFromDB) => void;
}> = ({ mode, activeRecord, createConfigId, onClose, onPickModel }) => {
  const { t: tr } = useI18n();
  // ▲ in composer always picks a model now (chat or media depending on mode).
  // Agent-level config moved to the sidebar agent row's ⋯ menu.
  return (
    <Modal
      title={mode === 'create' ? tr('shell.createModel') : tr('shell.chatModel')}
      onClose={onClose}
      modalClass="v2-pickmodal"
      bodyless
    >
      <ModelPicker
        wantMedia={mode === 'create'}
        currentConfigId={mode === 'create' ? createConfigId : activeRecord?.llm_config_id}
        onPick={onPickModel}
      />
    </Modal>
  );
};

const Modal: React.FC<{
  title: string;
  subtitle?: string;
  wide?: boolean;
  modalClass?: string;
  /** 跳过 v2-modal-body 包裹，children 直接挂在 v2-modal flex 列下（用于 split 等需要全幅布局的内容）。 */
  bodyless?: boolean;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, subtitle, wide, modalClass, bodyless, onClose, footer, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="v2-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`v2-modal${wide ? ' wide' : ''}${modalClass ? ' ' + modalClass : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="v2-modal-hd">
          <h3>{title}</h3>
          {subtitle && <span className="v2-modal-sub">{subtitle}</span>}
          <button className="x" onClick={onClose}>✕</button>
        </div>
        {bodyless ? children : <div className="v2-modal-body">{children}</div>}
        {footer && <div className="v2-modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

const ModelPicker: React.FC<{
  wantMedia: boolean;
  currentConfigId?: string;
  onPick: (cfg: LLMConfigFromDB) => void;
}> = ({ wantMedia, currentConfigId, onPick }) => {
  const { t: tr } = useI18n();
  const [configs, setConfigs] = useState<LLMConfigFromDB[] | null>(null);
  useEffect(() => {
    getLLMConfigs()
      .then((list) => setConfigs(Array.isArray(list) ? list : []))
      .catch(() => setConfigs([]));
  }, []);
  const list = useMemo(() => {
    if (!configs) return null;
    const enabled = configs.filter((c) => c.enabled !== false);
    // 严格互斥：媒体可见的模型只在「创作」里出现；对话模式只看非媒体模型。
    return wantMedia ? enabled.filter((c) => c.media_visible) : enabled.filter((c) => !c.media_visible);
  }, [configs, wantMedia]);

  const grouped = useMemo(() => list ? groupConfigsByProvider(list) : [], [list]);
  // 默认锚定到当前已选模型所在的厂商；否则取第一组。
  const initialProvider = useMemo(() => {
    if (!list || !currentConfigId) return grouped[0]?.[0] ?? null;
    const cur = list.find((c) => c.config_id === currentConfigId);
    return (cur?.provider || '').toLowerCase() || grouped[0]?.[0] || null;
  }, [list, currentConfigId, grouped]);
  const [activeProvider, setActiveProvider] = useState<string | null>(initialProvider);
  useEffect(() => { if (activeProvider == null && initialProvider) setActiveProvider(initialProvider); }, [initialProvider, activeProvider]);
  const activeConfigs = useMemo(
    () => grouped.find(([p]) => p === activeProvider)?.[1] ?? [],
    [grouped, activeProvider],
  );

  if (!list) return <div className="v2-pickmodal-empty">{tr('common.loading')}</div>;
  if (list.length === 0) {
    return (
      <div className="v2-pickmodal-empty">
        {wantMedia ? tr('shell.picker.noCreateModels') : tr('shell.picker.noChatModels')}
      </div>
    );
  }
  return (
    <div className="v2-pickmodal-split">
      <aside className="v2-pickmodal-providers" role="listbox" aria-label={tr('shell.provider')}>
        {grouped.map(([provider, items]) => {
          const hasCurrent = !!currentConfigId && items.some((c) => c.config_id === currentConfigId);
          return (
            <button
              key={provider}
              type="button"
              role="option"
              aria-selected={provider === activeProvider}
              className={`v2-pickmodal-provider${provider === activeProvider ? ' on' : ''}${hasCurrent ? ' has-current' : ''}`}
              onClick={() => setActiveProvider(provider)}
            >
              <span className="nm">{PICK_PROVIDER_LABELS[provider] || provider}</span>
              <span className="cnt">{items.length}</span>
            </button>
          );
        })}
      </aside>
      <div className="v2-pickmodal-models">
        {activeConfigs.length === 0 ? (
          <div className="v2-pickmodal-empty">{tr('shell.noModelsForProvider')}</div>
        ) : (
          <div className="v2-pickmodal-modellist">
            {activeConfigs.map((c) => {
              const isCurrent = c.config_id === currentConfigId;
              return (
                <button
                  key={c.config_id}
                  type="button"
                  className={`v2-pick${isCurrent ? ' on' : ''}`}
                  onClick={() => onPick(c)}
                  aria-current={isCurrent || undefined}
                >
                  <div className="v2-pick-main">
                    <div className="v2-pick-nm">{c.shortname || c.name}</div>
                    <div className="v2-pick-ds">{c.model || tr('shell.defaultModelName')}</div>
                  </div>
                  {isCurrent && <span className="v2-pick-check" aria-label={tr('shell.current')}>✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const AgentSettingsDrawer: React.FC<{ agent: Session; onClose: () => void }> = ({ agent, onClose }) => {
  const { t: tr } = useI18n();
  const agentApiId = (agent as any).id || agent.session_id;
  const [name, setName] = useState(agent.name || agent.title || '');
  const [prompt, setPrompt] = useState(agent.system_prompt || '');
  const [llmId, setLlmId] = useState<string | undefined>(agent.llm_config_id);
  const [avatar, setAvatar] = useState<string | undefined>(agent.avatar);
  const [busy, setBusy] = useState(false);

  const [llms, setLlms] = useState<LLMConfigFromDB[] | null>(null);
  const [allMcps, setAllMcps] = useState<MCPServer[] | null>(null);
  const [boundMcps, setBoundMcps] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    getLLMConfigs().then((l) => setLlms(Array.isArray(l) ? l.filter((x) => x.enabled !== false) : [])).catch(() => setLlms([]));
    mcpApi.list().then((l) => setAllMcps(Array.isArray(l) ? l : [])).catch(() => setAllMcps([]));
    mcpApi.listForAgent(agentApiId).then((l) => setBoundMcps(new Set((l || []).map((x) => x.id)))).catch(() => {});
  }, [agentApiId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onAvatarPick = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => { setAvatar(String(r.result || '')); };
    r.readAsDataURL(file);
  };

  const toggleMcp = async (m: MCPServer) => {
    const has = boundMcps.has(m.id);
    try {
      if (has) await mcpApi.unbindFromAgent(agentApiId, m.id);
      else await mcpApi.bindToAgent(agentApiId, m.id);
      setBoundMcps((s) => {
        const next = new Set(s);
        if (has) next.delete(m.id); else next.add(m.id);
        return next;
      });
    } catch (e) {
      console.warn('[v2] toggleMcp failed', e);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      // Agent-level updates go through /api/agents/{id}/profile so the agent
      // record itself is updated (name / persona / llm / avatar all live on
      // the agent, not the conversation).
      const updates: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== (agent.name || agent.title)) updates.name = name.trim();
      if ((prompt || '') !== (agent.system_prompt || '')) updates.system_prompt = prompt;
      if (llmId !== agent.llm_config_id) updates.llm_config_id = llmId || null;
      if (avatar && avatar !== agent.avatar) updates.avatar = avatar;
      if (Object.keys(updates).length > 0) {
        await updateRoleProfile(agentApiId, updates);
      }
      onClose();
    } catch (e) {
      console.warn('[v2] agent save failed', e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={tr('shell.agentSettings')}
      subtitle={agent.name || agent.title}
      wide
      onClose={onClose}
      footer={<>
        <button className="v2-mbtn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
        <button className="v2-mbtn primary" onClick={save} disabled={busy}>{busy ? tr('shell.saving') : tr('common.save')}</button>
      </>}
    >
      <div className="v2-modal-sec">
        <div className="v2-avatar-row">
          <div className="v2-avatar-lg" onClick={() => fileRef.current?.click()} title={tr('shell.agent.changeAvatar')}>
            {avatar
              ? <img src={avatar.startsWith('data:') ? avatar : `data:image/png;base64,${avatar}`} alt="" />
              : <span>{(agent.name || agent.title || '?').charAt(0)}</span>}
          </div>
          <div style={{ flex: 1 }}>
            <div className="lab">{tr('shell.agent.name')}</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('shell.agent.namePlaceholder')} />
          </div>
          <input
            ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onAvatarPick(f); e.target.value = ''; }}
          />
        </div>
      </div>

      <div className="v2-modal-sec">
        <div className="lab">{tr('shell.agent.persona')}</div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={tr('shell.agent.personaPlaceholder')} rows={6} />
        <div className="v2-modal-note">{tr('shell.agent.personaNote')}</div>
      </div>

      <div className="v2-modal-sec">
        <div className="lab">{tr('shell.agent.model')}</div>
        {!llms && <div className="v2-modal-note">{tr('common.loading')}</div>}
        {llms && (
          <div className="v2-ctxpop-list">
            <div className={`v2-ctxpop-item${!llmId ? ' active' : ''}`} onClick={() => setLlmId(undefined)}>
              <div className="nm">{tr('shell.agent.followDefault')}<small>{tr('shell.agent.unspecified')}</small></div>
            </div>
            {llms.map((c) => (
              <div
                key={c.config_id}
                className={`v2-ctxpop-item${llmId === c.config_id ? ' active' : ''}`}
                onClick={() => setLlmId(c.config_id)}
              >
                <div className="nm">{c.shortname || c.name}<small>{c.model || c.provider}</small></div>
                <div className="tag">{c.provider}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="v2-modal-sec">
        <div className="lab">{tr('shell.agent.mcpTools')}</div>
        {!allMcps && <div className="v2-modal-note">{tr('common.loading')}</div>}
        {allMcps && allMcps.length === 0 && (
          <div className="v2-modal-note">{tr('shell.agent.noMcp')}</div>
        )}
        {allMcps && allMcps.length > 0 && (
          <div className="v2-ctxpop-list">
            {allMcps.map((m) => {
              const bound = boundMcps.has(m.id);
              return (
                <div
                  key={m.id}
                  className={`v2-ctxpop-item${bound ? ' active' : ''}`}
                  onClick={() => void toggleMcp(m)}
                >
                  <div className="nm">{m.name}<small>{m.type}</small></div>
                  <div className="tag">{bound ? tr('shell.agent.bound') : tr('shell.agent.bind')}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
};

const ChipPanel: React.FC<{
  which: 'style' | 'aspect' | 'count' | 'negative';
  cfg: { style: string; aspect: string; count: number; negative: string };
  setStyle: (v: string) => void;
  setAspect: (v: string) => void;
  setCount: (v: number) => void;
  setNegative: (v: string) => void;
  close: () => void;
  aspectOptions?: string[];
  countMax?: number;
  aspectHint?: string;
}> = ({ which, cfg, setStyle, setAspect, setCount, setNegative, close, aspectOptions, countMax, aspectHint }) => {
  const { t: tr } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  if (which === 'style') {
    return <StylePanel cfg={cfg} setStyle={setStyle} close={close} />;
  }
  if (which === 'aspect') {
    const aspects = aspectOptions && aspectOptions.length > 0 ? aspectOptions : ASPECT_OPTIONS;
    return (
      <div className="v2-panel">
        <div className="v2-panel-hd">
          {tr('shell.create.aspect')}
          {aspectHint ? <span className="v2-panel-hint" style={{ marginLeft: 8, opacity: 0.6, fontSize: 12 }}>{aspectHint}</span> : null}
        </div>
        <div className="v2-options">
          {aspects.map((a) => (
            <div key={a} className={`v2-opt${cfg.aspect === a ? ' active' : ''}`} onClick={() => { setAspect(a); }}>
              <span>{a}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (which === 'count') {
    const max = countMax ?? 8;
    const opts = COUNT_OPTIONS.filter((n) => n <= max);
    return (
      <div className="v2-panel">
        <div className="v2-panel-hd">{tr('shell.create.countHead')}</div>
        <div className="v2-options">
          {opts.map((n) => (
            <div key={n} className={`v2-opt${cfg.count === n ? ' active' : ''}`} onClick={() => { setCount(n); }}>
              <span>{tr('shell.spec.countN', { n })}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  // negative
  return (
    <div className="v2-panel">
      <div className="v2-panel-hd">{tr('shell.create.negativeHead')}</div>
      <FreeTextRow
        placeholder={tr('shell.create.negativePlaceholder')}
        initial={cfg.negative}
        onApply={(v) => { setNegative(v); close(); }}
        multiline
      />
    </div>
  );
};

const StylePanel: React.FC<{
  cfg: { style: string };
  setStyle: (v: string) => void;
  close: () => void;
}> = ({ cfg, setStyle, close }) => {
  const { t: tr } = useI18n();
  const [custom, setCustom] = useState<StylePreset[]>(() => loadCustomStyles());
  // Hidden built-in style IDs (user-deleted). Persisted on the primary
  // agent's ext.style_presets_hidden so the choice carries across sessions.
  const [hiddenBuiltins, setHiddenBuiltins] = useState<Set<string>>(new Set());

  useEffect(() => {
    // One-shot pull on mount; pushes/deletes auto-sync below.
    void (async () => {
      const { list } = await syncCustomStylesFromBackend();
      setCustom(list);
      setHiddenBuiltins(new Set(getHiddenBuiltinIds()));
    })();
  }, []);

  const visibleBuiltins = useMemo(
    () => BUILTIN_STYLES.filter((s) => !hiddenBuiltins.has(s.id)),
    [hiddenBuiltins],
  );
  const all: StylePreset[] = useMemo(() => [...visibleBuiltins, ...custom], [visibleBuiltins, custom]);
  const activeId = findPresetBySuffix(cfg.style)?.id;
  const trimmed = cfg.style.trim();

  const onDelete = async (id: string, isCustom: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCustom) {
      const s = custom.find((x) => x.id === id);
      if (!s) return;
      const rep = await deleteCustomStyle(id);
      if (!rep.ok) { console.warn('[v2] delete custom style failed', rep.error); return; }
      const after = loadCustomStyles();
      setCustom(after);
      if (cfg.style.trim() === s.suffix.trim()) setStyle('');
    } else {
      // Hide a builtin — record in agent ext so other sessions see it too.
      const s = BUILTIN_STYLES.find((x) => x.id === id);
      if (!s) return;
      const next = new Set([...hiddenBuiltins, id]);
      setHiddenBuiltins(next);
      void setHiddenBuiltinIds([...next]);
      if (cfg.style.trim() === s.suffix.trim()) setStyle('');
    }
  };

  // Save: persist as a preset chip (no auto-apply, so the user can browse).
  // Apply: set the suffix as the current style for this turn; if it's not
  // already a known preset, also save it so it becomes a clickable chip.
  const saveAsPreset = async (name: string, suffix: string) => {
    const v = suffix.trim();
    if (!v) return;
    if (findPresetBySuffix(v)) return;
    const aliased = (name.trim() || v.slice(0, 12)).slice(0, 24);
    const { report } = await addCustomStyle(aliased, v);
    setCustom(loadCustomStyles());
    if (!report.ok) console.warn('[v2] style backend save failed:', report.error);
  };

  const applyNow = async (name: string, suffix: string) => {
    const v = suffix.trim();
    if (!v) { setStyle(''); close(); return; }
    const existing = findPresetBySuffix(v);
    if (existing) { setStyle(existing.suffix); close(); return; }
    const aliased = (name.trim() || v.slice(0, 12)).slice(0, 24);
    const { preset, report } = await addCustomStyle(aliased, v);
    setCustom(loadCustomStyles());
    setStyle(preset.suffix);
    if (!report.ok) console.warn('[v2] style backend save failed:', report.error);
    close();
  };

  return (
    <div className="v2-panel">
      <div className="v2-panel-hd">
        <span>{tr('shell.style.head')}</span>
        {custom.length > 0 && <span style={{ color: 'var(--c-ink-4)' }}>{tr('shell.style.savedCount', { n: custom.length })}</span>}
      </div>
      <div className="v2-style-grid">
        <div
          className={`v2-style-card${!activeId && !trimmed ? ' active' : ''}`}
          onClick={() => setStyle('')}
        >
          <div className="v2-style-card-body">
            <span className="v2-style-card-name">{tr('shell.create.none')}</span>
          </div>
          <div className="v2-style-card-foot">
            <span className="v2-style-card-tag">NONE</span>
          </div>
        </div>
        {all.map((s) => {
          const label = s.custom ? s.zh : tr('misc.style.' + s.id);
          const tag = s.custom ? tr('shell.style.customTag') : (s.en || '');
          return (
            <div
              key={s.id}
              className={`v2-style-card${activeId === s.id ? ' active' : ''}${s.custom ? ' is-custom' : ''}`}
              onClick={() => setStyle(s.suffix)}
              title={s.suffix}
            >
              <div className="v2-style-card-body">
                <span className="v2-style-card-name">{label}</span>
              </div>
              <div className="v2-style-card-foot">
                {tag && <span className={`v2-style-card-tag${s.custom ? ' custom' : ''}`}>{tag}</span>}
                <div className="v2-style-card-acts">
                  <StyleCopyBtn text={s.suffix} />
                  <button
                    type="button"
                    className="v2-style-card-act v2-style-card-del"
                    title={tr('common.delete')}
                    aria-label={tr('common.delete')}
                    onClick={(e) => onDelete(s.id, !!s.custom, e)}
                  ><IconTrash /></button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <CustomStyleEditor
        initialSuffix={activeId ? '' : cfg.style}
        onSave={saveAsPreset}
        onApply={applyNow}
      />
    </div>
  );
};

// Tiny icon-only button living inside a style option row — copies the actual
// suffix content (the part that's hidden behind a name/tag for custom styles).
// Stops propagation so it doesn't also trigger the row's "select this style".
const StyleCopyBtn: React.FC<{ text: string }> = ({ text }) => {
  const { t: tr } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!text.trim()) return null;
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      className={`v2-style-card-act v2-style-card-copy${copied ? ' done' : ''}`}
      onClick={onCopy}
      title={copied ? tr('shell.spec.copied') : tr('shell.style.copyTip')}
      aria-label={tr('shell.style.copyTip')}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
};

const CustomStyleEditor: React.FC<{
  initialSuffix: string;
  onSave: (name: string, suffix: string) => void | Promise<void>;
  onApply: (name: string, suffix: string) => void | Promise<void>;
}> = ({ initialSuffix, onSave, onApply }) => {
  const { t: tr } = useI18n();
  const [name, setName] = useState('');
  const [suffix, setSuffix] = useState(initialSuffix);
  // Re-seed once when the parent's "current style" changes (e.g. user clicks
  // another preset). Don't echo on every keystroke.
  useEffect(() => { setSuffix(initialSuffix); }, [initialSuffix]);
  const disabled = !suffix.trim();
  return (
    <div className="v2-row-input" style={{ flexWrap: 'wrap', gap: 8 }}>
      <input
        placeholder={tr('shell.style.namePlaceholder')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ flex: '0 0 220px' }}
      />
      <textarea
        placeholder={tr('shell.style.suffixPlaceholder')}
        value={suffix}
        onChange={(e) => setSuffix(e.target.value)}
        style={{ flex: '1 1 240px', minHeight: 60 }}
      />
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button
          className="ghost"
          type="button"
          disabled={disabled}
          onClick={() => onSave(name, suffix)}
          title={tr('shell.style.saveTip')}
        >{tr('shell.style.saveAsPreset')}</button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApply(name, suffix)}
          title={tr('shell.style.applyTip')}
        >{tr('shell.style.applyNow')}</button>
      </div>
    </div>
  );
};

const FreeTextRow: React.FC<{
  placeholder: string;
  initial: string;
  onApply: (v: string) => void;
  multiline?: boolean;
  extra?: React.ReactNode;
}> = ({ placeholder, initial, onApply, multiline, extra }) => {
  const { t: tr } = useI18n();
  const [v, setV] = useState(initial);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onApply(v.trim()); }
  };
  return (
    <div className="v2-row-input">
      {multiline
        ? <textarea autoFocus placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={onKeyDown} />
        : <input autoFocus placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={onKeyDown} />
      }
      {extra}
      {initial && <button className="ghost" onClick={() => { setV(''); onApply(''); }}>{tr('shell.clear')}</button>}
      <button onClick={() => onApply(v.trim())}>{tr('shell.apply')}</button>
    </div>
  );
};

const StreamView: React.FC<{ content: string; reasoning: string }> = ({ content, reasoning }) => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-msg assistant streaming">
    <div className="v2-body">
      {reasoning && <ThinkBlock reasoning={reasoning} streaming={true} hasContent={!!content} />}
      {content ? (
        <div className="v2-stream-md">
          {/* live=true 切到无 Shiki 的纯 markdown：流式时如果出现 fenced code，
             逐 chunk 重 highlight 是顶级性能杀手；settled 后 MessageView 会用
             MD_RICH 重新挂载并完成高亮。 */}
          <MD text={content} live />
          <span className="v2-caret">▍</span>
        </div>
      ) : !reasoning && <p className="v2-pending">{tr('shell.waitingFirstToken')}</p>}
    </div>
  </div>
  );
};

const ThinkingDots: React.FC = () => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-msg assistant">
    <div className="v2-body">
      <p style={{ color: 'var(--c-ink-3)', fontStyle: 'italic' }}>{tr('shell.thinkingDots')}</p>
    </div>
  </div>
  );
};

const EmptyState: React.FC<{ title: string }> = React.memo(({ title }) => {
  const { t: tr } = useI18n();
  return (
  <div className="v2-empty">
    <div className="v2-empty-title">{title || tr('shell.newSession')}</div>
    <div className="v2-empty-sub">{tr('shell.emptyHint')}</div>
  </div>
  );
});
EmptyState.displayName = 'EmptyState';

const SkeletonRows: React.FC<{ n: number }> = ({ n }) => (
  <>
    {Array.from({ length: n }).map((_, i) => (
      <div key={i} className="v2-skel-row" />
    ))}
  </>
);

/* ============== utils ============== */

function userName(): string {
  try {
    const u = api.getUser();
    return (u?.name || u?.email || t('shell.notSignedIn')).toString();
  } catch { return ''; }
}
function userInitials(): string {
  const n = userName();
  if (!n) return '?';
  if (/[a-zA-Z]/.test(n[0])) {
    const parts = n.split(/[^a-zA-Z]/).filter(Boolean);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || n[0].toUpperCase();
  }
  return n.slice(0, 1).toUpperCase();
}

const AgentIcon: React.FC<{ a: Session }> = React.memo(({ a }) => {
  if (a.is_primary) return <IconAgentPrimary />;
  const key = (a.name || a.title || '').toLowerCase();
  if (/绘|画|paint|draw|art/.test(key)) return <IconAgentPainter />;
  if (/史|doc|记|note|写/.test(key)) return <IconAgentDoc />;
  if (/码|code|dev/.test(key)) return <IconAgentCode />;
  return <IconAgentDoc />;
});
AgentIcon.displayName = 'AgentIcon';

/** Sidebar Agent 行：React.memo + 稳定 props，长会话流式期间不再随父重渲。 */
const AgentRow = React.memo<{
  a: Session; active: boolean;
  onOpen: (s: Session) => void;
  onMore: (s: Session, e: React.MouseEvent) => void;
}>(({ a, active, onOpen, onMore }) => {
  const { t: tr } = useI18n();
  return (
  <div
    className={`v2-a${active ? ' active' : ''}`}
    onClick={() => onOpen(a)}
    title={a.name || a.title}
  >
    <div className="v2-side-av">
      {a.avatar
        ? <img src={a.avatar.startsWith('data:') ? a.avatar : `data:image/png;base64,${a.avatar}`} alt="" />
        : <AgentIcon a={a} />}
    </div>
    <div className="v2-nm">
      {a.name || a.title || tr('shell.unnamed')}
      {a.is_primary && <span className="v2-pri">primary</span>}
    </div>
    <div className="v2-more" onClick={(e) => onMore(a, e)}>⋯</div>
  </div>
  );
});
AgentRow.displayName = 'AgentRow';

/** Sidebar Chat 行：同 AgentRow，单独走是因为 markup 不同（无头像、teahouse 标记）。 */
const ChatRow = React.memo<{
  r: Session; active: boolean;
  onOpen: (s: Session) => void;
  onMore: (s: Session, e: React.MouseEvent) => void;
}>(({ r, active, onOpen, onMore }) => {
  const { t: tr } = useI18n();
  const tea = (r as any).ext?.teahouse === true;
  return (
    <div
      className={`v2-r${active ? ' active' : ''}${tea ? ' teahouse' : ''}`}
      onClick={() => onOpen(r)}
      title={r.name || r.title}
    >
      <span className="v2-ic" aria-hidden>{tea ? <IconTeahouse /> : <IconChat />}</span>
      <span className="v2-t">{r.name || r.title || r.preview_text || (tea ? tr('shell.newTeahouse') : tr('shell.emptySession'))}</span>
      <span className="v2-more" onClick={(e) => onMore(r, e)}>⋯</span>
    </div>
  );
});
ChatRow.displayName = 'ChatRow';

// keep-alive 包装：无 props 的视图 memo 化，常驻挂载后不随 ClientShell 每次重渲（如
// 聊天流式）而重渲；只在自身内部状态变化时重渲。避免「常驻」引入隐藏视图空转的回归。
const KnowledgeViewKA = React.memo(KnowledgeView);
const GalleryViewKA = React.memo(GalleryView);
const FbotViewKA = React.memo(FbotView);
// 分屏 wiki 窗格：standalone（自带左树、不抢主侧栏 portal 槽位），memo 避免随父重渲。
const KnowledgeViewPane = React.memo(() => <KnowledgeView standalone />);
KnowledgeViewPane.displayName = 'KnowledgeViewPane';

/** 分屏聊天窗格用的最小后端通道（由 ClientShell 注入唯一的 useChatBackend）。
 *  单 WS：被「聚焦/接管」的那个会话才实时（= 主后端的 activeSessionId），其余静态历史。 */
type ChatPaneCtx = {
  activeSessionId: string | null;
  messages: Message[];
  stream: { id: string; content: string; reasoning: string } | null;
  sendMessage: (text: string, opts?: { agentId?: string; ext?: Record<string, unknown> }) => Promise<boolean> | void;
  setActiveSessionId: (sid: string) => void;
};
const ChatPaneContext = React.createContext<ChatPaneCtx | null>(null);

/** 分屏里的云端会话窗格：聚焦/点击 → 接管唯一 WS（成为 activeSessionId）= 实时 + 可输入；
 *  未聚焦 → 拉一页历史只读展示（不占第二路流）。即「性能安全版」交互聊天。 */
const ChatSessionPane: React.FC<{ sessionId: string }> = React.memo(({ sessionId }) => {
  const ctx = useContext(ChatPaneContext);
  const isActive = !!ctx && ctx.activeSessionId === sessionId;
  const [loaded, setLoaded] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (isActive) return;                 // 接管后用主后端 messages，不必自拉
    let alive = true; setLoaded(null);
    getSessionMessages(sessionId, 1, 50)
      .then((r) => { if (alive) setLoaded(r.messages); })
      .catch(() => { if (alive) setLoaded([]); });
    return () => { alive = false; };
  }, [sessionId, isActive]);
  const msgs = isActive ? ctx!.messages : loaded;
  const noop = () => {};
  const activate = () => { if (ctx && !isActive) ctx.setActiveSessionId(sessionId); };
  const onSend = () => {
    const t = draft.trim(); if (!t || !ctx) return;
    if (!isActive) ctx.setActiveSessionId(sessionId);
    void ctx.sendMessage(t);
    setDraft('');
  };
  return (
    <div className="v2-foreign-chat" onMouseDown={activate}>
      <section className="v2-stream v2-foreign-stream">
        <div className="v2-msgs">
          {!msgs && <div className="v2-feat-empty">{'加载会话…'}</div>}
          {msgs && msgs.length === 0 && <div className="v2-feat-empty">{'空会话'}</div>}
          {msgs && msgs.map((m) => (
            <MessageView key={m.message_id} m={m} showTokens={false}
              onPreviewImage={setPreview} onRevert={noop} onEdit={noop} onQuote={noop}
              onRerunCreation={noop} onOpenSpec={noop} />
          ))}
          {isActive && ctx!.stream && ctx!.stream.content && (
            <div className="v2-msg assistant"><div className="v2-body"><div className="v2-md"><p style={{ whiteSpace: 'pre-wrap' }}>{ctx!.stream.content}</p></div></div></div>
          )}
        </div>
      </section>
      <div className="v2-foreign-composer">
        <textarea
          value={draft}
          onFocus={activate}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder={isActive ? 'Ask anything…' : '点此接管会话并发消息…'}
          rows={1}
        />
        <button className="v2-foreign-send" onClick={onSend} disabled={!draft.trim()} title="发送 (Enter)">↑</button>
      </div>
      {preview && <div className="v2-imgpreview" onClick={() => setPreview(null)}><img src={preview} alt="" /></div>}
    </div>
  );
});
ChatSessionPane.displayName = 'ChatSessionPane';

export default ClientShell;
