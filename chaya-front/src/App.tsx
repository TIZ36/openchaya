import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './utils/apiClient';
import LoginPage from './components/LoginPage';
import {
  Settings,
  Bot,
  Plus,
  FolderOpen,
  Film,
  Sun,
  Moon,
  MessageSquare,
  Brain,
  Package,
  Plug,
  Palette,
  Sparkles,
  Zap,
  Target,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  BookOpen,
  Rocket,
  Trash2,
} from 'lucide-react';
import { Button } from './components/ui/Button';
import { Input } from './components/ui/Input';
import { ScrollArea } from './components/ui/ScrollArea';
import { DataListItem } from './components/ui/DataListItem';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './components/ui/Dialog';
import SettingsPanel from './components/SettingsPanel';
import LLMConfigPanel from './components/LLMConfig';
import McpWorkspacePanel from './components/McpWorkspacePanel';
import Workflow from './components/Workflow';
import AgentsPage from './components/AgentsPage';
import MediaCreatorPage from './components/MediaCreatorPage';
import SkillPackEntryPage from './components/SkillPackEntryPage';
import KnowledgeBasePage from './components/KnowledgeBasePage';
import AgentNameplateDialog from './components/AgentNameplateDialog';
import { getAgents, getSessions, createAgent, deleteSession, deleteAgent, type Session } from './services/chat';
import { toast } from './components/ui/use-toast';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { CapsuleToggle } from './components/ui/CapsuleToggle';
import { SESSIONS_CHANGED_EVENT, emitSessionsChanged } from './utils/sessionEvents';
import { readPreciseMode, writePreciseMode } from './utils/preciseMode';
import { getMe } from './services/adminApi';
import {
  buildStoredUser,
  getAllowedSkins,
  getThemeFamilyForPlan,
  getTenantPlan,
  normalizeThemeMode,
  type CurrentUser,
  type SkinId as ThemeSkinId,
  type TenantPlan,
  type ThemeMode,
} from './utils/themeAccess';

export type SkinId = ThemeSkinId;
export type FontId = 'default' | 'pixel' | 'terminal' | 'rounded' | 'dotgothic' | 'silkscreen';

interface Settings {
  font: FontId;
  autoRefresh: boolean;
  refreshInterval: number;
  videoColumns: number;
  enableToolCalling: boolean;
}

type MainModule = 'chat' | 'media' | 'settings' | 'harness';
type ChatSubTab = 'chaya' | 'persona';
/** 聊天内嵌「人格」区：全局人设库或当前 Agent 基本设置 */
type ChatAgentsPageSection = 'persona-presets' | 'chaya-config' | 'voice-presets';
type HarnessSubTab = 'mcp' | 'skill' | 'kb';
type MediaSubTab = 'image' | 'video';
type SettingsSubTab = 'general' | 'llm' | 'agent-status' | 'membership';

const LS_MAIN = 'chatee_main_module';
const LS_CHAT_SUB = 'chatee_chat_sub_tab';
const LS_HARNESS_SUB = 'chatee_harness_sub_tab';
const LS_MEDIA_SUB = 'chatee_media_sub_tab';
const LS_SETTINGS_SUB = 'chatee_settings_sub_tab';
const LS_OPEN_AGENT_TABS = 'chatee_open_agent_tabs';
const LS_SIDEBAR_COLLAPSED = 'chatee_sidebar_collapsed';
const THEME_MODE_STORAGE_KEY = 'chatee_theme_mode';

function readLs<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw && allowed.includes(raw as T)) return raw as T;
  } catch { /* */ }
  return fallback;
}

/** 左侧 Persona = 人设管理 + 音色管理；旧版可能把子 Tab 存在 LS_SETTINGS_SUB */
function readMainModule(): MainModule {
  try {
    const raw = localStorage.getItem(LS_MAIN);
    const st = localStorage.getItem(LS_SETTINGS_SUB);
    if (st === 'persona_presets' || st === 'voice_presets') return 'chat';
    if (raw && ['chat', 'media', 'settings', 'harness'].includes(raw)) return raw as MainModule;
  } catch { /* */ }
  return 'chat';
}

function readSettingsSubTabInitial(): SettingsSubTab {
  try {
    const raw = localStorage.getItem(LS_SETTINGS_SUB);
    if (raw === 'persona_presets' || raw === 'voice_presets') return 'general';
    const allowed: readonly SettingsSubTab[] = ['general', 'llm', 'agent-status', 'membership'];
    if (raw && allowed.includes(raw as SettingsSubTab)) return raw as SettingsSubTab;
  } catch { /* */ }
  return 'general';
}

const PLAN_LABELS: Record<TenantPlan, string> = {
  free: 'Free',
  pro: 'Pro',
  ultra: 'Ultra',
};

const App: React.FC = () => {
  // ── Auth ──
  const [authed, setAuthed] = useState(api.isLoggedIn());
  const [showUserProfile, setShowUserProfile] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(() => api.getUser());

  const isElectron =
    import.meta.env.VITE_ELECTRON === 'true' ||
    (typeof window !== 'undefined' && !!window.chateeElectron?.isElectron);

  const isDarwin =
    typeof window !== 'undefined' &&
    (window.chateeElectron?.platform === 'darwin' || /Mac|iPhone|iPad/.test(navigator.platform ?? ''));

  const location = useLocation();
  const navigate = useNavigate();
  const [primaryAgentId, setPrimaryAgentId] = useState(() => {
    // Try to get from cached user data
    const user = api.getUser();
    return user?.primary_agent_id || 'agent_chaya';
  });
  const DEFAULT_AGENT_ID = primaryAgentId;
  const normalizeOpenAgentTabs = useCallback((ids: string[]) => {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    if (!unique.includes(DEFAULT_AGENT_ID)) unique.unshift(DEFAULT_AGENT_ID);
    return unique;
  }, [DEFAULT_AGENT_ID]);

  // ── 主模块 / 子 Tab 状态 ──
  const [mainModule, setMainModule] = useState<MainModule>(() => readMainModule());
  const [chatSubTab, setChatSubTab] = useState<ChatSubTab>(() => {
    try {
      const legacy = localStorage.getItem(LS_CHAT_SUB);
      if (legacy === 'mcp' || legacy === 'skill' || legacy === 'kb') return 'chaya';
    } catch { /* */ }
    return readLs(LS_CHAT_SUB, ['chaya', 'persona'] as const, 'chaya');
  });
  const [harnessSubTab, setHarnessSubTab] = useState<HarnessSubTab>(() =>
    readLs(LS_HARNESS_SUB, ['mcp', 'skill', 'kb'] as const, 'mcp'),
  );
  const [chatAgentsPageSection, setChatAgentsPageSection] = useState<ChatAgentsPageSection>('persona-presets');
  const [mediaSubTab, setMediaSubTab] = useState<MediaSubTab>(() =>
    readLs(LS_MEDIA_SUB, ['image', 'video'] as const, 'image'),
  );
  const [settingsSubTab, setSettingsSubTab] = useState<SettingsSubTab>(() => readSettingsSubTabInitial());
  const [showMobileSettingsDialog, setShowMobileSettingsDialog] = useState(false);
  const [showMobileModeDialog, setShowMobileModeDialog] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(LS_MAIN, mainModule);
      localStorage.setItem(LS_CHAT_SUB, chatSubTab);
      localStorage.setItem(LS_HARNESS_SUB, harnessSubTab);
      localStorage.setItem(LS_MEDIA_SUB, mediaSubTab);
      localStorage.setItem(LS_SETTINGS_SUB, settingsSubTab);
    } catch { /* */ }
  }, [mainModule, chatSubTab, harnessSubTab, mediaSubTab, settingsSubTab]);

  const [preciseMode, setPreciseMode] = useState(() => readPreciseMode());

  const onPreciseModeChange = useCallback((next: boolean) => {
    writePreciseMode(next);
    setPreciseMode(next);
  }, []);

  useEffect(() => {
    if (location.pathname === '/mcp-support') {
      navigate('/', { replace: true });
    }
  }, [location.pathname, navigate]);

  // ── 会话 ──
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const saved = localStorage.getItem('chatee_last_open_chat');
    const legacy = localStorage.getItem('selected_session_id');
    const lastSession = saved || legacy;
    if (!lastSession || lastSession === 'temporary-session') return DEFAULT_AGENT_ID;
    return lastSession;
  });
  const [openAgentTabIds, setOpenAgentTabIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_OPEN_AGENT_TABS);
      if (!raw) return [DEFAULT_AGENT_ID];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [DEFAULT_AGENT_ID];
      const ids = parsed.filter((id) => typeof id === 'string') as string[];
      return ids.length > 0 ? Array.from(new Set(ids)) : [DEFAULT_AGENT_ID];
    } catch {
      return [DEFAULT_AGENT_ID];
    }
  });
  const [isCreatingAgentTab, setIsCreatingAgentTab] = useState(false);

  const [settings, setSettings] = useState<Settings>(() => {
    const saved = localStorage.getItem('settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const { theme, skin, ...rest } = parsed;
        return { font: 'default', autoRefresh: false, refreshInterval: 60, videoColumns: 4, enableToolCalling: true, ...rest };
      } catch { return { font: 'default', autoRefresh: false, refreshInterval: 60, videoColumns: 4, enableToolCalling: true }; }
    }
    return { font: 'default', autoRefresh: false, refreshInterval: 60, videoColumns: 4, enableToolCalling: true };
  });

  useEffect(() => { localStorage.setItem('settings', JSON.stringify(settings)); }, [settings]);

  useEffect(() => {
    if (selectedSessionId) {
      localStorage.setItem('chatee_last_open_chat', selectedSessionId);
      if (localStorage.getItem('selected_session_id')) localStorage.removeItem('selected_session_id');
    }
  }, [selectedSessionId]);

  // ── 皮肤 ──
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      return normalizeThemeMode(localStorage.getItem(THEME_MODE_STORAGE_KEY));
    } catch {
      return 'light';
    }
  });
  const tenantPlan = useMemo<TenantPlan>(() => getTenantPlan(user), [user]);
  const allowedSkins = useMemo(() => getAllowedSkins(tenantPlan), [tenantPlan]);
  const SKIN_STORAGE_KEY = 'chatee_skin';
  const [skin, setSkinRaw] = useState<SkinId>(() => {
    try {
      const saved = localStorage.getItem(SKIN_STORAGE_KEY) as SkinId | null;
      if (saved && (['quiet', 'niho', 'ultra'] as SkinId[]).includes(saved)) return saved;
    } catch { /* */ }
    return getThemeFamilyForPlan(getTenantPlan(api.getUser()));
  });
  // Clamp skin to allowed range when plan changes
  useEffect(() => {
    if (!allowedSkins.includes(skin)) setSkinRaw(allowedSkins[allowedSkins.length - 1]);
  }, [allowedSkins, skin]);
  useEffect(() => { try { localStorage.setItem(SKIN_STORAGE_KEY, skin); } catch { /* */ } }, [skin]);
  const setSkin = useCallback((s: SkinId) => { if (allowedSkins.includes(s)) setSkinRaw(s); }, [allowedSkins]);
  const effectiveThemeLabel = useMemo(() => {
    if (skin === 'ultra') return themeMode === 'dark' ? 'Ultra Dark' : 'Ultra Light';
    if (skin === 'niho') return themeMode === 'dark' ? 'Niho Dark' : 'Niho Light';
    return themeMode === 'dark' ? 'Quiet Dark' : 'Quiet Light';
  }, [skin, themeMode]);
  useEffect(() => {
    const nextUser = api.getUser();
    setUser((prev) => {
      const next = nextUser ? buildStoredUser(nextUser) : null;
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      return next;
    });
  }, [authed, primaryAgentId]);

  useEffect(() => {
    if (!authed) return;
    let active = true;
    void getMe().then((me) => {
      if (!active) return;
      api.setUser({ ...me.user, is_founder: me.is_founder }, me.tenant);
      setUser(api.getUser());
    }).catch(() => {
      // best-effort hydration for founder flag / latest tenant plan
    });
    return () => { active = false; };
  }, [authed]);

  useEffect(() => {
    if (!isElectron) return;
    const root = document.documentElement;
    root.setAttribute('data-electron', 'true');
    const p = window.chateeElectron?.platform;
    if (p) root.setAttribute('data-electron-platform', p);
    return () => { root.removeAttribute('data-electron'); root.removeAttribute('data-electron-platform'); };
  }, [isElectron]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.setAttribute('data-dashboard', 'true');
    root.setAttribute('data-skin', skin);
    root.setAttribute('data-theme-mode', themeMode);
    if (themeMode === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [skin, themeMode]);

  useEffect(() => { try { localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode); } catch { /* */ } }, [themeMode]);

  const handleThemeModeToggle = useCallback(() => {
    setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    const onModelChange = (event: Event) => {
      const detail = (event as CustomEvent<{ label?: string }>).detail;
      const nextLabel = (detail?.label || '').trim();
      setSelectedModelLabel(nextLabel || '选择模型');
    };
    window.addEventListener('chaya:selected-model-change', onModelChange as EventListener);
    return () => window.removeEventListener('chaya:selected-model-change', onModelChange as EventListener);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => document.documentElement.setAttribute('data-mobile', mq.matches ? 'true' : 'false');
    sync(); mq.addEventListener('change', sync); return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => { document.documentElement.setAttribute('data-font', settings.font); }, [settings.font]);

  const updateSettings = (ns: Partial<Settings>) => setSettings((p) => ({ ...p, ...ns }));

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setMainModule('chat');
    setChatSubTab('chaya');
    if (location.pathname !== '/') navigate('/');
  }, [location.pathname, navigate]);

  const handleSelectAgentSession = useCallback((sessionId: string) => {
    setOpenAgentTabIds((prev) => normalizeOpenAgentTabs([...prev, sessionId]));
    setSelectedSessionId(sessionId);
    setMainModule('chat');
    if (location.pathname !== '/') navigate('/');
  }, [location.pathname, navigate, normalizeOpenAgentTabs]);

  useEffect(() => {
    const p = location.pathname;
    if (p === '/llm-config')      { setMainModule('settings'); setSettingsSubTab('llm');     navigate('/', { replace: true }); return; }
    if (p === '/mcp-config') {
      writePreciseMode(true);
      setPreciseMode(true);
      setMainModule('harness');
      setHarnessSubTab('mcp');
      navigate('/', { replace: true });
      return;
    }
    if (p === '/settings')        { setMainModule('settings'); setSettingsSubTab('general'); navigate('/', { replace: true }); return; }
    if (p === '/agents') {
      setMainModule('chat');
      setChatSubTab('persona');
      setChatAgentsPageSection('persona-presets');
      navigate('/', { replace: true });
      return;
    }
    if (p === '/voice-presets') {
      setMainModule('chat');
      setChatSubTab('persona');
      setChatAgentsPageSection('voice-presets');
      navigate('/', { replace: true });
      return;
    }
    if (p === '/media-creator' || p === '/media-creator-image') { setMainModule('media'); setMediaSubTab('image'); navigate('/', { replace: true }); return; }
    if (p === '/media-creator-video') { setMainModule('media'); setMediaSubTab('video'); navigate('/', { replace: true }); }
  }, [location.pathname, navigate]);

  // ── 对话切换弹窗 ──
  const [showConversationSwitcher, setShowConversationSwitcher] = useState(false);
  const [switcherSearch, setSwitcherSearch] = useState('');
  const [isLoadingSwitcher, setIsLoadingSwitcher] = useState(false);
  const [switcherAgents, setSwitcherAgents] = useState<Session[]>([]);
  const [switcherTopics, setSwitcherTopics] = useState<Session[]>([]);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<Session | null>(null);
  const [showAgentNameplateDialog, setShowAgentNameplateDialog] = useState(false);
  const loadSwitcherData = useCallback(async (validateSelection = false) => {
    try {
      setIsLoadingSwitcher(true);
      const [agents, sessions] = await Promise.all([getAgents(), getSessions()]);
      const nextAgents = agents || [];

      // Detect primary agent and update DEFAULT_AGENT_ID
      const primary = nextAgents.find((a: any) => a.is_primary);
        if (primary && primary.session_id && primary.session_id !== primaryAgentId) {
          setPrimaryAgentId(primary.session_id);
          // Cache for next load
          const nextUser = api.getUser();
          if (nextUser) {
            const updatedUser = { ...nextUser, primary_agent_id: primary.session_id };
            api.setUser(updatedUser, nextUser.tenant);
            setUser(updatedUser);
          }
        }

      setSwitcherAgents(nextAgents);
      setSwitcherTopics((sessions || []).filter((s) => s.session_type === 'topic_general'));
      const validAgentIds = new Set(nextAgents.map((a) => a.session_id));
      validAgentIds.add(primaryAgentId);
      setOpenAgentTabIds((prev) => normalizeOpenAgentTabs(prev.filter((id) => validAgentIds.has(id))));
      if (validateSelection) {
        const cur = selectedSessionId;
        if (cur) {
          const all = [...nextAgents, ...(sessions || [])];
          if (!all.some((s) => s.session_id === cur) && cur !== primaryAgentId) handleSelectSession(primaryAgentId);
        } else handleSelectSession(primaryAgentId);
      }
    } catch {
      setSwitcherAgents([]); setSwitcherTopics([]);
      if (validateSelection && !selectedSessionId) handleSelectSession(primaryAgentId);
    } finally { setIsLoadingSwitcher(false); }
  }, [primaryAgentId, selectedSessionId, handleSelectSession, normalizeOpenAgentTabs]);

  useEffect(() => { if (showConversationSwitcher) void loadSwitcherData(false); }, [showConversationSwitcher, loadSwitcherData]);
  useEffect(() => { void loadSwitcherData(true); }, [loadSwitcherData]);

  useEffect(() => {
    const handleSessionsChanged = () => {
      void loadSwitcherData(false);
    };
    window.addEventListener(SESSIONS_CHANGED_EVENT, handleSessionsChanged);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, handleSessionsChanged);
  }, [loadSwitcherData]);
  useEffect(() => {
    setOpenAgentTabIds((prev) => normalizeOpenAgentTabs(prev));
  }, [normalizeOpenAgentTabs]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_OPEN_AGENT_TABS, JSON.stringify(openAgentTabIds));
    } catch { /* ignore */ }
  }, [openAgentTabIds]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_SIDEBAR_COLLAPSED, isSidebarCollapsed ? '1' : '0');
    } catch {
      // ignore
    }
  }, [isSidebarCollapsed]);
  useEffect(() => {
    if (!selectedSessionId) return;
    const isAgent = selectedSessionId === DEFAULT_AGENT_ID || switcherAgents.some((a) => a.session_id === selectedSessionId);
    if (!isAgent) return;
    setOpenAgentTabIds((prev) => normalizeOpenAgentTabs([...prev, selectedSessionId]));
  }, [DEFAULT_AGENT_ID, normalizeOpenAgentTabs, selectedSessionId, switcherAgents]);

  const handleCreateAgentTab = useCallback(async () => {
    try {
      setIsCreatingAgentTab(true);
      const created = await createAgent();
      handleSelectAgentSession(created.session_id);
      await loadSwitcherData(false);
      emitSessionsChanged();
      toast({ title: '已新建 Agent', description: '新会话无历史对话，记忆从当前窗口重新累计', variant: 'success' });
    } catch (error) {
      toast({
        title: '创建 Agent 失败',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsCreatingAgentTab(false);
    }
  }, [handleSelectAgentSession, loadSwitcherData]);

  const handleDeleteSessionConfirm = (session: Session, e: React.MouseEvent) => { e.stopPropagation(); setDeleteSessionTarget(session); };

  const performDeleteSession = async () => {
    if (!deleteSessionTarget) return;
    const { session_id, name, title, id, is_primary } = deleteSessionTarget;
    try {
      const convid = session_id;
      const agid = id;
      const isAgentEntity = !!(agid && convid && agid !== convid);
      if (isAgentEntity && !is_primary) {
        await deleteAgent(agid);
      } else {
        await deleteSession(session_id);
      }
      toast({ title: '已删除', description: `「${name || title || '会话'}」已成功删除`, variant: 'success' });
      if (selectedSessionId === session_id) handleSelectSession(DEFAULT_AGENT_ID);
      await loadSwitcherData();
      emitSessionsChanged();
    } catch (error) {
      toast({ title: '删除失败', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally { setDeleteSessionTarget(null); }
  };


  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const fn = () => setIsMobile(mq.matches);
    mq.addEventListener('change', fn); return () => mq.removeEventListener('change', fn);
  }, []);

  // ── 气泡 Tab ──
  const mediaTabs: { id: MediaSubTab; label: string }[] = [
    { id: 'image', label: '生图' },
    { id: 'video', label: '生视频' },
  ];
  const settingsTabs = useMemo<{ id: SettingsSubTab; label: string }[]>(() => {
    const tabs: { id: SettingsSubTab; label: string }[] = [
      { id: 'general', label: '通用设置' },
      { id: 'llm', label: '模型录入' },
      { id: 'agent-status', label: 'Agent 状态' },
    ];
    if (user?.is_founder) tabs.push({ id: 'membership', label: '会员管理' });
    return tabs;
  }, [user?.is_founder]);
  const harnessTabs: { id: HarnessSubTab; label: string }[] = [
    { id: 'mcp', label: 'MCP' },
    { id: 'skill', label: 'Skill' },
    { id: 'kb', label: '知识库' },
  ];
  const personaTabs: { id: Exclude<ChatAgentsPageSection, 'chaya-config'>; label: string }[] = [
    { id: 'persona-presets', label: '人设管理' },
    { id: 'voice-presets', label: '音色管理' },
  ];

  useEffect(() => {
    if (settingsSubTab === 'membership' && !user?.is_founder) {
      setSettingsSubTab('general');
    }
  }, [settingsSubTab, user?.is_founder]);

  /** switcher 尚未拉到列表时仍沿用 selectedSessionId，避免 Persona/基本设置 等子页短暂收到 DEFAULT 而显示错 Agent */
  const activeAgentSessionId = useMemo(() => {
    if (!selectedSessionId) return DEFAULT_AGENT_ID;
    if (selectedSessionId === DEFAULT_AGENT_ID) return selectedSessionId;
    if (switcherAgents.length === 0) return selectedSessionId;
    return switcherAgents.some((a) => a.session_id === selectedSessionId) ? selectedSessionId : DEFAULT_AGENT_ID;
  }, [selectedSessionId, DEFAULT_AGENT_ID, switcherAgents]);
  const activeAgentMeta = useMemo(() => {
    const row = switcherAgents.find((a) => a.session_id === activeAgentSessionId);
    if (!row) return null;
    const name = (row.name || row.title || 'Agent').trim() || 'Agent';
    const avatar = row.avatar?.trim() ? row.avatar : null;
    return { name, avatar };
  }, [switcherAgents, activeAgentSessionId]);
  const activeSessionTitle = useMemo(() => {
    const row = switcherAgents.find((a) => a.session_id === activeAgentSessionId);
    if (!row) return activeAgentMeta?.name || 'Chaya';
    return row.name || row.title || activeAgentMeta?.name || 'Chaya';
  }, [switcherAgents, activeAgentSessionId, activeAgentMeta?.name]);
  const activeAgentSessionRow = useMemo(
    () => switcherAgents.find((a) => a.session_id === activeAgentSessionId) || null,
    [switcherAgents, activeAgentSessionId],
  );
  const [selectedModelLabel, setSelectedModelLabel] = useState('选择模型');
  const mobilePrecisePortalTabs = useMemo(
    () => [
      {
        id: 'mcp' as const,
        title: 'MCP 工作区',
        desc: '工具链、外部服务与能力接入。移动端只做查看与入口展示。',
        icon: <Plug className="w-5 h-5" />,
      },
      {
        id: 'skill' as const,
        title: 'Skill 技能包',
        desc: '工作流技能和预设能力集合。移动端只展示已启用能力，不支持编辑。',
        icon: <Package className="w-5 h-5" />,
      },
      {
        id: 'kb' as const,
        title: '知识库',
        desc: '文档与检索增强能力。移动端作为知识门户使用，增强配置在 Web 端完成。',
        icon: <BookOpen className="w-5 h-5" />,
      },
    ],
    [],
  );

  // ── 内容渲染 ──
  const renderPanel = () => {
    if (mainModule === 'chat') {
      if (isMobile && preciseMode) {
        return (
          <div className="mobile-harness-info flex-1 min-h-0 overflow-y-auto">
            <section className="mobile-harness-card mobile-harness-card--poster">
              <div className="mobile-harness-card__icon">
                <Sparkles className="w-5 h-5" />
              </div>
              <div className="mobile-harness-card__body">
                <h2 className="mobile-harness-card__title">Harness 模式能力门户</h2>
                <p className="mobile-harness-card__desc">
                  手机端在 Harness 模式下只展示当前启用能力。MCP、Skill、知识库都以海报形式查看和跳转，不支持编辑。
                </p>
              </div>
            </section>

            <section className="mobile-capability-poster-grid">
              {mobilePrecisePortalTabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mobile-capability-poster ${item.id === 'kb' ? 'mobile-capability-poster--active' : ''}`}
                  onClick={() => {
                    setMainModule('harness');
                    setHarnessSubTab(item.id);
                  }}
                >
                  <span className="mobile-capability-poster__glow" aria-hidden />
                  <span className="mobile-capability-poster__icon">{item.icon}</span>
                  <span className="mobile-capability-poster__title">{item.title}</span>
                  <span className="mobile-capability-poster__desc">{item.desc}</span>
                  <span className="mobile-capability-poster__tag mobile-capability-poster__tag--auto">自动激活</span>
                </button>
              ))}
            </section>
          </div>
        );
      }

      if (chatSubTab === 'chaya') return <div key={`c-${activeAgentSessionId}`} className="h-full min-h-0"><Workflow sessionId={activeAgentSessionId} onSelectSession={handleSelectSession} enableToolCalling={settings.enableToolCalling} onToggleToolCalling={(v) => updateSettings({ enableToolCalling: v })} preciseMode={preciseMode} /></div>;
      if (chatSubTab === 'persona') {
        return (
          <div className="h-full min-h-0 overflow-hidden">
            <AgentsPage sessionId={activeAgentSessionId} section={chatAgentsPageSection} />
          </div>
        );
      }
      return <div key={`c-${activeAgentSessionId}`} className="h-full min-h-0"><Workflow sessionId={activeAgentSessionId} onSelectSession={handleSelectSession} enableToolCalling={settings.enableToolCalling} onToggleToolCalling={(v) => updateSettings({ enableToolCalling: v })} preciseMode={preciseMode} /></div>;
    }
    if (mainModule === 'harness') {
      if (isMobile) {
        const isMcpTab = harnessSubTab === 'mcp';
        const isKbTab = harnessSubTab === 'kb';
        return (
          <div className="mobile-harness-info flex-1 min-h-0 overflow-y-auto">
            <section className="mobile-harness-card">
              <div className="mobile-harness-card__icon">
                {isMcpTab ? <Plug className="w-5 h-5" /> : isKbTab ? <BookOpen className="w-5 h-5" /> : <Package className="w-5 h-5" />}
              </div>
              <div className="mobile-harness-card__body">
                <h2 className="mobile-harness-card__title">{isMcpTab ? 'MCP 工作区' : isKbTab ? '知识库' : 'Skill 技能包'}</h2>
                <p className="mobile-harness-card__desc">
                  {isMcpTab
                    ? '手机端只保留能力说明与接入状态，MCP 的新增、授权和详细配置请在桌面端完成。'
                    : isKbTab
                      ? '手机端可查看知识库内容，复杂的文档维护与批量管理建议在桌面端完成。'
                      : '手机端只展示当前技能能力概览，技能包的创建、编辑和绑定管理请在桌面端完成。'}
                </p>
              </div>
            </section>

            {preciseMode && (
              <section className="mobile-capability-poster-grid">
                <button
                  type="button"
                  className={`mobile-capability-poster ${isMcpTab ? 'mobile-capability-poster--active' : ''}`}
                  onClick={() => setHarnessSubTab('mcp')}
                >
                  <span className="mobile-capability-poster__glow" aria-hidden />
                  <span className="mobile-capability-poster__icon"><Plug className="w-5 h-5" /></span>
                  <span className="mobile-capability-poster__title">MCP 工作区</span>
                  <span className="mobile-capability-poster__desc">外部工具与能力接入。移动端只查看启用状态与用途，不做配置。</span>
                  <span className="mobile-capability-poster__tag mobile-capability-poster__tag--auto">自动激活</span>
                </button>
                <button
                  type="button"
                  className={`mobile-capability-poster ${!isMcpTab && !isKbTab ? 'mobile-capability-poster--active' : ''}`}
                  onClick={() => setHarnessSubTab('skill')}
                >
                  <span className="mobile-capability-poster__glow" aria-hidden />
                  <span className="mobile-capability-poster__icon"><Package className="w-5 h-5" /></span>
                  <span className="mobile-capability-poster__title">Skill 技能包</span>
                  <span className="mobile-capability-poster__desc">预设技能与任务能力。移动端只做展示与入口，不支持编辑。</span>
                  <span className="mobile-capability-poster__tag mobile-capability-poster__tag--auto">自动激活</span>
                </button>
                <button
                  type="button"
                  className={`mobile-capability-poster ${isKbTab ? 'mobile-capability-poster--active' : ''}`}
                  onClick={() => setHarnessSubTab('kb')}
                >
                  <span className="mobile-capability-poster__glow" aria-hidden />
                  <span className="mobile-capability-poster__icon"><BookOpen className="w-5 h-5" /></span>
                  <span className="mobile-capability-poster__title">知识库</span>
                  <span className="mobile-capability-poster__desc">知识增强与文档检索。移动端作为门户，不支持改动知识库。</span>
                  <span className="mobile-capability-poster__tag mobile-capability-poster__tag--auto">自动激活</span>
                </button>
              </section>
            )}

            <section className="mobile-harness-grid">
              <article className="mobile-harness-panel">
                <div className="mobile-harness-panel__label">当前页面</div>
                <div className="mobile-harness-panel__value">{isKbTab ? '可查看内容' : '只读概览'}</div>
                <p className="mobile-harness-panel__text">
                  {isMcpTab
                    ? '查看 MCP 工作区定位、用途和桌面端入口说明。'
                    : isKbTab
                      ? '查看知识库文档与检索入口，维护结构建议在桌面端完成。'
                      : '查看 Skill 的用途、调用方式和桌面端维护入口说明。'}
                </p>
              </article>
              <article className="mobile-harness-panel">
                <div className="mobile-harness-panel__label">建议操作</div>
                <div className="mobile-harness-panel__value">桌面端继续</div>
                <p className="mobile-harness-panel__text">
                  桌面端保留完整的配置、调试、授权和卡片管理能力，手机端避免复杂表单和弹层打断。
                </p>
              </article>
            </section>

            <section className="mobile-harness-list">
              <div className="mobile-harness-list__title">移动端保留</div>
              <div className="mobile-harness-list__item">
                <span className="mobile-harness-list__item-icon"><BookOpen className="w-4 h-4" /></span>
                <div>
                  <div className="mobile-harness-list__item-label">能力说明</div>
                  <div className="mobile-harness-list__item-text">快速了解 MCP / Skill 在当前工作流中的作用。</div>
                </div>
              </div>
              <div className="mobile-harness-list__item">
                <span className="mobile-harness-list__item-icon"><Sparkles className="w-4 h-4" /></span>
                <div>
                  <div className="mobile-harness-list__item-label">轻量查看</div>
                  <div className="mobile-harness-list__item-text">减少复杂配置表单，避免在手机上进行授权和管理操作。</div>
                </div>
              </div>
            </section>
          </div>
        );
      }

      return (
        <div className="h-full min-h-0 overflow-hidden">
          {harnessSubTab === 'mcp' && (
            <div className="h-full min-h-0 overflow-hidden">
              <McpWorkspacePanel sessionId={activeAgentSessionId} />
            </div>
          )}
          {harnessSubTab === 'skill' && <SkillPackEntryPage sessionId={activeAgentSessionId} />}
          {harnessSubTab === 'kb' && (
            <div className="h-full min-h-0 overflow-hidden">
              <KnowledgeBasePage sessionId={activeAgentSessionId} />
            </div>
          )}
        </div>
      );

    }
    if (mainModule === 'media') return <div className="h-full min-h-0"><MediaCreatorPage embedded mode={mediaSubTab === 'video' ? 'video' : 'image'} /></div>;
    if (mainModule === 'settings') {
      if (settingsSubTab === 'general') return <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="general" />;
      if (settingsSubTab === 'llm') {
        return (
          <div className="h-full min-h-0 overflow-hidden llm-config-page">
            <LLMConfigPanel />
          </div>
        );
      }
      if (settingsSubTab === 'agent-status') {
        return <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="agent-status" />;
      }
      if (settingsSubTab === 'membership') {
        return <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="membership" />;
      }
    }
    return (
      <div className="h-full min-h-0 flex items-center justify-center text-sm text-[var(--text-secondary)]">
        未知模块
      </div>
    );
  };

  const renderModuleTabs = () => (
    <>
      {mainModule === 'chat' && chatSubTab === 'persona' && chatAgentsPageSection !== 'chaya-config' && personaTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setChatAgentsPageSection(t.id)}
          className={`app-bubble-tab app-no-drag ${chatAgentsPageSection === t.id ? 'app-bubble-tab--active' : ''}`}
        >
          <span className="app-bubble-tab-label">{t.label}</span>
        </button>
      ))}
      {mainModule === 'media' && mediaTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setMediaSubTab(t.id)}
          className={`app-bubble-tab app-no-drag ${mediaSubTab === t.id ? 'app-bubble-tab--active' : ''}`}
        >
          <span className="app-bubble-tab-label">{t.label}</span>
        </button>
      ))}
      {mainModule === 'settings' && settingsTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setSettingsSubTab(t.id)}
          className={`app-bubble-tab app-no-drag ${settingsSubTab === t.id ? 'app-bubble-tab--active' : ''}`}
        >
          <span className="app-bubble-tab-label">{t.label}</span>
        </button>
      ))}
      {mainModule === 'harness' && harnessTabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setHarnessSubTab(t.id)}
          className={`app-bubble-tab app-no-drag ${harnessSubTab === t.id ? 'app-bubble-tab--active' : ''}`}
        >
          <span className="app-bubble-tab-label">{t.label}</span>
        </button>
      ))}
    </>
  );

  // ── Auth Guard (must be after all hooks) ──
  if (!authed) {
    return <LoginPage onLogin={() => { setUser(api.getUser()); setAuthed(true); }} />;
  }

  const isGlobalPersonaLibraryPage = mainModule === 'chat' && chatSubTab === 'persona' && chatAgentsPageSection !== 'chaya-config';
  const isAgentScopedChatPage = mainModule === 'chat' && (chatSubTab === 'chaya' || (chatSubTab === 'persona' && chatAgentsPageSection === 'chaya-config'));
  const showChatAgentHeader = isAgentScopedChatPage;
  const showBubbleHeader = (mainModule !== 'chat' && mainModule !== 'media') || isGlobalPersonaLibraryPage;

  return (
    <div className={`app-shell ${isElectron && isDarwin ? 'app-shell--darwin' : ''}`}>
      {/* macOS 红绿灯占位条 — 在 app-frame 外面，背景跟外壳一致 */}
      <div className="app-darwin-titlebar">
        <span className="app-darwin-titlebar-text">Chaya</span>
      </div>

      <div className="app-frame">
        {!isMobile && (
          <aside className={`app-sidebar app-no-drag ${isSidebarCollapsed ? 'app-sidebar--collapsed' : ''}`}>
            <div className="app-sidebar__header">
              <div className="app-sidebar__header-top">
                {!isSidebarCollapsed && (
                  <span className="app-sidebar__brand-wrap">
                    <span className="app-sidebar__brand-dot" aria-hidden />
                    <span className="app-sidebar__brand">Chaya</span>
                  </span>
                )}
                <button
                  type="button"
                  className="app-sidebar__collapse-btn"
                  onClick={() => setIsSidebarCollapsed((prev) => !prev)}
                  title={isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                  aria-label={isSidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
                >
                  {isSidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
                </button>
              </div>
              <div className="app-sidebar__mode-switch">
                <button
                  type="button"
                  className={`app-sidebar__mode-btn ${mainModule !== 'media' && mainModule !== 'settings' ? 'is-active' : ''}`}
                  onClick={() => {
                    setMainModule('chat');
                    setChatSubTab('chaya');
                  }}
                  title="对话"
                >
                  <Bot className="w-[17px] h-[17px]" strokeWidth={2} />
                  {!isSidebarCollapsed && <span>对话</span>}
                </button>
                <button
                  type="button"
                  className={`app-sidebar__mode-btn ${mainModule === 'media' ? 'is-active' : ''}`}
                  onClick={() => {
                    setMainModule('media');
                    if (!mediaSubTab) setMediaSubTab('image');
                  }}
                  title="创作"
                >
                  <Film className="w-[17px] h-[17px]" strokeWidth={2} />
                  {!isSidebarCollapsed && <span>创作</span>}
                </button>
              </div>
            </div>

            <div className="app-sidebar__section">
              {!isSidebarCollapsed && mainModule !== 'media' && (
                <>
                  <button type="button" className="app-sidebar__action" onClick={handleCreateAgentTab} disabled={isCreatingAgentTab}>
                    <Plus className="w-3.5 h-3.5" />
                    <span>{isCreatingAgentTab ? '创建 Agent...' : '新建 Agent'}</span>
                  </button>
                </>
              )}
            </div>

            {!isSidebarCollapsed && (
              <div className="app-sidebar__section app-sidebar__section--scroll">
                {mainModule === 'media' ? (
                  <>
                    <div className="app-sidebar__label">Media Tools</div>
                    <div className="app-sidebar__list">
                      {mediaTabs.map((tab) => (
                        <button
                          key={`media-${tab.id}`}
                          type="button"
                          className={`app-sidebar__item ${mediaSubTab === tab.id ? 'is-active' : ''}`}
                          onClick={() => {
                            setMainModule('media');
                            setMediaSubTab(tab.id);
                          }}
                          title={tab.label}
                        >
                          <Film className="w-3.5 h-3.5" />
                          <span className="truncate">{tab.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="app-sidebar__label">Conversations</div>
                    <div className="app-sidebar__list">
                      {switcherAgents.map((agent) => {
                        const sid = agent.session_id;
                        const isActive = sid === selectedSessionId;
                        const label = agent.name || agent.title || `Agent ${sid.slice(0, 6)}`;
                        const allowDelete = !agent.is_primary;
                        const avatar = agent.avatar?.trim() || '';
                        return (
                          <button
                            key={`agent-${sid}`}
                            type="button"
                            className={`app-sidebar__item ${isActive ? 'is-active' : ''}`}
                            onClick={() => {
                              setMainModule('chat');
                              setChatSubTab('chaya');
                              handleSelectAgentSession(sid);
                            }}
                            title={label}
                          >
                            <span className="app-sidebar__agent-avatar" aria-hidden>
                              {avatar ? <img src={avatar} alt="" /> : <span>{label.slice(0, 1).toUpperCase()}</span>}
                            </span>
                            <span className="truncate flex-1 min-w-0">{label}</span>
                            {allowDelete ? (
                              <button
                                type="button"
                                className="app-sidebar__item-delete"
                                title={`删除 ${label}`}
                                onClick={(e) => handleDeleteSessionConfirm(agent, e)}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            ) : null}
                          </button>
                        );
                      })}
                      {switcherTopics.map((topic) => {
                        const sid = topic.session_id;
                        const isActive = sid === selectedSessionId;
                        const label = topic.name || topic.title || topic.preview_text || `会话 ${sid.slice(0, 6)}`;
                        return (
                          <button
                            key={`topic-${sid}`}
                            type="button"
                            className={`app-sidebar__item ${isActive ? 'is-active' : ''}`}
                            onClick={() => {
                              setMainModule('chat');
                              setChatSubTab('chaya');
                              handleSelectSession(sid);
                            }}
                            title={label}
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span className="truncate">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="app-sidebar__subtools">
                      <div className="app-sidebar__label">对话功能</div>
                      <div className="app-sidebar__list">
                        <button
                          type="button"
                          className={`app-sidebar__item ${(mainModule === 'harness' && harnessSubTab === 'mcp') ? 'is-active' : ''}`}
                          onClick={() => {
                            setMainModule('harness');
                            setHarnessSubTab('mcp');
                          }}
                          title="MCP"
                        >
                          <Plug className="w-3.5 h-3.5" />
                          <span className="truncate">MCP</span>
                        </button>
                        <button
                          type="button"
                          className={`app-sidebar__item ${(mainModule === 'harness' && harnessSubTab === 'skill') ? 'is-active' : ''}`}
                          onClick={() => {
                            setMainModule('harness');
                            setHarnessSubTab('skill');
                          }}
                          title="Skill"
                        >
                          <Package className="w-3.5 h-3.5" />
                          <span className="truncate">Skill</span>
                        </button>
                        <button
                          type="button"
                          className={`app-sidebar__item ${(mainModule === 'chat' && chatSubTab === 'persona' && chatAgentsPageSection === 'persona-presets') ? 'is-active' : ''}`}
                          onClick={() => {
                            setMainModule('chat');
                            setChatSubTab('persona');
                            setChatAgentsPageSection('persona-presets');
                          }}
                          title="人设管理"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span className="truncate">人设管理</span>
                        </button>
                        <button
                          type="button"
                          className={`app-sidebar__item ${(mainModule === 'chat' && chatSubTab === 'persona' && chatAgentsPageSection === 'voice-presets') ? 'is-active' : ''}`}
                          onClick={() => {
                            setMainModule('chat');
                            setChatSubTab('persona');
                            setChatAgentsPageSection('voice-presets');
                          }}
                          title="音色管理"
                        >
                          <Palette className="w-3.5 h-3.5" />
                          <span className="truncate">音色管理</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="app-sidebar__footer">
              <div className="app-sidebar__footer-tools">
                <button
                  type="button"
                  onClick={() => {
                    setMainModule('settings');
                    setSettingsSubTab('general');
                  }}
                  className={`app-sidebar__icon-btn ${mainModule === 'settings' ? 'is-active' : ''}`}
                  title="设置"
                >
                  <Settings className="w-[17px] h-[17px]" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowUserProfile(true)}
                  className={`app-rail-profile-btn app-rail-profile-btn--${tenantPlan} ${user?.is_founder ? 'app-rail-profile-btn--founder' : ''}`}
                  title={`查看账号信息 · ${user?.is_founder ? 'Founder' : PLAN_LABELS[tenantPlan]} Pass`}
                  aria-label={`查看账号信息，当前等级 ${user?.is_founder ? 'Founder' : PLAN_LABELS[tenantPlan]} Pass`}
                >
                  {(user?.name || user?.email || 'U')[0].toUpperCase()}
                  {user?.is_founder ? <span className="app-rail-profile-badge">♛</span> : null}
                </button>
                <button
                  type="button"
                  onClick={handleThemeModeToggle}
                  className="app-sidebar__icon-btn app-sidebar__footer-theme-btn"
                  title={`当前主题：${effectiveThemeLabel}`}
                >
                  {themeMode === 'dark'
                    ? <Moon className="w-[17px] h-[17px]" strokeWidth={2} />
                    : <Sun className="w-[17px] h-[17px]" strokeWidth={2} />}
                </button>
              </div>
            </div>
          </aside>
        )}

        {/* ─── 主区域 ─── */}
        <div className={`app-main relative ${isMobile ? 'app-main--mobile-dock' : ''}`}>
          {showChatAgentHeader && (
          <header className={`app-chat-header ${isElectron ? 'electron-titlebar-drag' : ''}`}>
            <div className="app-chat-header__left">
              {isMobile ? (
                <button
                  type="button"
                  className="app-chat-header__icon-btn app-no-drag"
                  onClick={() => setShowMobileModeDialog(true)}
                  title="切换功能"
                >
                  <Bot className="w-4 h-4" />
                </button>
              ) : null}
              <button type="button" className="app-chat-header__session app-no-drag" onClick={() => setShowAgentNameplateDialog(true)}>
                <span className="app-chat-header__session-avatar" aria-hidden>
                  {activeAgentMeta?.avatar ? (
                    <img src={activeAgentMeta.avatar} alt="" />
                  ) : (
                    <Bot className="w-3.5 h-3.5" />
                  )}
                </span>
                <span className="app-chat-header__session-title">{activeSessionTitle}</span>
              </button>
              {!isMobile ? (
                <nav className="app-bubble-tabs app-chat-header__tabs app-no-drag">
                  <span
                    className="app-chat-header__mode-inline"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CapsuleToggle
                      checked={preciseMode}
                      onCheckedChange={onPreciseModeChange}
                      aria-label={
                        preciseMode
                          ? '当前为 Harness 模式，点击切换到极速模式'
                          : '当前为极速模式，点击切换到 Harness 模式'
                      }
                      leftIcon={<Zap />}
                      rightIcon={<Target />}
                    />
                  </span>
                  <button
                    type="button"
                    className="app-bubble-tab"
                    onClick={() => {
                      if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('chaya:open-model-select'));
                      }
                    }}
                    title={selectedModelLabel}
                  >
                    <span className="app-bubble-tab-icon"><Brain className="w-3.5 h-3.5" /></span>
                    <span className="app-bubble-tab-label">{selectedModelLabel}</span>
                  </button>
                </nav>
              ) : null}
            </div>
            <div className="app-chat-header__right">
              {isMobile ? (
                <span
                  className="app-chat-header__mode app-no-drag"
                  title={
                    preciseMode
                      ? 'Harness模式：更严格意图判定与委派'
                      : '极速模式：优先直答，低延迟'
                  }
                >
                  <CapsuleToggle
                    checked={preciseMode}
                    onCheckedChange={onPreciseModeChange}
                    aria-label={
                      preciseMode
                        ? '当前为 Harness 模式，点击切换到极速模式'
                        : '当前为极速模式，点击切换到 Harness 模式'
                    }
                    leftIcon={<Zap />}
                    rightIcon={<Target />}
                  />
                </span>
              ) : null}
              {isMobile ? (
                <button
                  type="button"
                  onClick={() => setShowUserProfile(true)}
                  className={`app-rail-profile-btn app-rail-profile-btn--mobile app-rail-profile-btn--${tenantPlan} ${user?.is_founder ? 'app-rail-profile-btn--founder' : ''}`}
                  title={user?.name || user?.email || 'User'}
                >
                  {(user?.name || user?.email || 'U')[0].toUpperCase()}
                  {user?.is_founder ? <span className="app-rail-profile-badge">♛</span> : null}
                </button>
              ) : null}
            </div>
          </header>
          )}
          {showBubbleHeader && (
            <header className={`app-bubble-bar ${isElectron ? 'electron-titlebar-drag' : ''}`}>
              <nav className="app-bubble-tabs">
                {renderModuleTabs()}
              </nav>
            </header>
          )}

          <main className="app-content">
            <div className={`app-content-inner ${(mainModule !== 'chat' || isGlobalPersonaLibraryPage) ? 'app-content-inner--full' : ''}`}>
            <AgentNameplateDialog
              open={showAgentNameplateDialog}
              onOpenChange={setShowAgentNameplateDialog}
              sessionId={activeAgentSessionId}
              agentAgid={activeAgentSessionRow?.id}
              listRow={activeAgentSessionRow}
              onUpdated={() => { void loadSwitcherData(false); }}
            />
            {/* 对话切换弹窗 */}
            <Dialog open={showConversationSwitcher} onOpenChange={(o) => { setShowConversationSwitcher(o); if (!o) setSwitcherSearch(''); }}>
              <DialogContent className="max-w-3xl">
                <DialogHeader>
                  <div className="flex items-center justify-between pr-8">
                    <div>
                      <DialogTitle>选择对话</DialogTitle>
                      <DialogDescription>选择智能体或会话开始对话</DialogDescription>
                    </div>
                  </div>
                </DialogHeader>
                <Input value={switcherSearch} onChange={(e) => setSwitcherSearch(e.target.value)} placeholder="搜索智能体或会话..." className="h-9" />
                <ScrollArea className="h-[60vh] pr-2 w-full">
                  <div className="space-y-4 py-2 w-full min-w-0">
                    <div className="w-full">
                      <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold text-[var(--text-secondary)]">
                        <span className="flex items-center gap-1.5"><Bot className="w-3.5 h-3.5" />智能体</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => {
                            setShowConversationSwitcher(false);
                            setMainModule('chat');
                            setChatAgentsPageSection('chaya-config');
                            setChatSubTab('persona');
                          }}
                        >
                          <Palette className="w-3 h-3 mr-1" />基本设置
                        </Button>
                      </div>
                      <div className="space-y-1 w-full">
                        {isLoadingSwitcher ? (
                          <div className="px-1 py-2 text-xs text-[var(--text-muted)]">加载中...</div>
                        ) : switcherAgents.length === 0 ? (
                          <div className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">暂无智能体，可在上方 Tab 栏点击 + 新建</div>
                        ) : (
                          switcherAgents.filter((a) => { const q = switcherSearch.trim().toLowerCase(); if (!q) return true; return (a.name || a.title || a.session_id).toLowerCase().includes(q) || (a.system_prompt || '').toLowerCase().includes(q); }).map((a) => (
                            <DataListItem key={a.session_id} id={a.session_id} title={a.name || a.title || `Agent ${a.session_id.slice(0, 8)}`} description={a.system_prompt ? a.system_prompt.split('\n')[0]?.slice(0, 80) + (a.system_prompt.length > 80 ? '...' : '') : `${a.message_count || 0} 条消息`} avatar={a.avatar || undefined} isSelected={selectedSessionId === a.session_id} onClick={() => { setShowConversationSwitcher(false); handleSelectAgentSession(a.session_id); }} onDelete={a.is_primary ? undefined : (e) => handleDeleteSessionConfirm(a, e)} />
                          ))
                        )}
                      </div>
                    </div>
                    <div className="w-full">
                      <div className="mb-1 flex items-center gap-1.5 px-1 text-xs font-semibold text-[var(--text-secondary)]"><FolderOpen className="w-3.5 h-3.5" />会话</div>
                      <div className="space-y-1 w-full">
                        {isLoadingSwitcher ? (
                          <div className="px-1 py-2 text-xs text-[var(--text-muted)]">加载中...</div>
                        ) : switcherTopics.length === 0 ? (
                          <div className="px-1 py-3 text-center text-xs text-[var(--text-muted)]">暂无会话</div>
                        ) : (
                          switcherTopics.filter((t) => { const q = switcherSearch.trim().toLowerCase(); if (!q) return true; return (t.name || t.title || t.preview_text || t.session_id).toLowerCase().includes(q); }).map((t) => (
                            <DataListItem key={t.session_id} id={t.session_id} title={t.name || t.title || t.preview_text || `会话 ${t.session_id.slice(0, 8)}`} description={`${t.message_count || 0} 条消息`} icon={FolderOpen} isSelected={selectedSessionId === t.session_id} onClick={() => { setShowConversationSwitcher(false); handleSelectSession(t.session_id); }} onDelete={(e) => handleDeleteSessionConfirm(t, e)} />
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </ScrollArea>
                <DialogFooter><Button variant="secondary" onClick={() => setShowConversationSwitcher(false)}>关闭</Button></DialogFooter>
              </DialogContent>
            </Dialog>

            {isAgentScopedChatPage ? (
              <div className={`chat-workspace-shell flex-1 min-h-0 overflow-hidden flex relative ${isMobile ? 'gap-0 p-0' : 'gap-0 p-0'}`}>
                <div className={`flex-1 min-h-0 overflow-hidden flex flex-col bg-[var(--surface-primary)] ${isMobile ? 'rounded-[18px] border border-[var(--border-default)] m-2 mb-0' : ''}`}>
                  <div className="flex-1 min-h-0 overflow-hidden">{renderPanel()}</div>
                </div>
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-hidden">{renderPanel()}</div>
            )}
            </div>
          </main>
        </div>

      </div>

      <Dialog open={showMobileSettingsDialog} onOpenChange={setShowMobileSettingsDialog}>
        <DialogContent className="max-w-[min(100vw-20px,720px)] h-[min(88vh,820px)] p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-3 border-b border-[var(--border-default)]">
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>移动端将设置收纳为对话框，避免离开当前门户页面。</DialogDescription>
          </DialogHeader>
          <div className="mobile-sheet-tabs">
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSettingsSubTab(tab.id)}
                className={`mobile-sheet-tab ${settingsSubTab === tab.id ? 'mobile-sheet-tab--active' : ''}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="mobile-sheet-body">
            {settingsSubTab === 'general' && <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="general" />}
            {settingsSubTab === 'llm' && <LLMConfigPanel />}
            {settingsSubTab === 'agent-status' && <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="agent-status" />}
            {settingsSubTab === 'membership' && <SettingsPanel settings={settings as any} onUpdateSettings={updateSettings as any} section="membership" />}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showMobileModeDialog} onOpenChange={setShowMobileModeDialog}>
        <DialogContent className="max-w-[min(100vw-28px,420px)] p-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-3 border-b border-[var(--border-default)]">
            <DialogTitle>切换功能</DialogTitle>
            <DialogDescription>移动端主入口只保留对话和作图。</DialogDescription>
          </DialogHeader>
          <div className="mobile-sheet-body mobile-sheet-body--padded">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className={`mobile-capability-poster ${mainModule === 'chat' ? 'mobile-capability-poster--active' : ''}`}
                onClick={() => {
                  setShowMobileModeDialog(false);
                  setMainModule('chat');
                  setChatSubTab('chaya');
                }}
              >
                <span className="mobile-capability-poster__glow" aria-hidden />
                <span className="mobile-capability-poster__icon"><MessageSquare className="w-5 h-5" /></span>
                <span className="mobile-capability-poster__title">对话</span>
                <span className="mobile-capability-poster__desc">进入聊天与使用主界面</span>
              </button>
              <button
                type="button"
                className={`mobile-capability-poster ${mainModule === 'media' ? 'mobile-capability-poster--active' : ''}`}
                onClick={() => {
                  setShowMobileModeDialog(false);
                  setMainModule('media');
                  setMediaSubTab('image');
                }}
              >
                <span className="mobile-capability-poster__glow" aria-hidden />
                <span className="mobile-capability-poster__icon"><Film className="w-5 h-5" /></span>
                <span className="mobile-capability-poster__title">作图</span>
                <span className="mobile-capability-poster__desc">进入媒体创作与结果浏览</span>
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteSessionTarget !== null}
        onOpenChange={(o) => { if (!o) setDeleteSessionTarget(null); }}
        title="删除确认"
        description={`您确定要删除「${deleteSessionTarget?.name || deleteSessionTarget?.title || '该会话'}」吗？此操作不可撤销。`}
        variant="destructive"
        onConfirm={performDeleteSession}
      />

      {/* ── User Profile / Membership Dialog ── */}
      {showUserProfile && (() => {
        const isFounder = user?.is_founder === true;
        const planLabel = isFounder ? 'Founder' : PLAN_LABELS[tenantPlan];
        const allSkins: { id: SkinId; label: string; unlockPlan: string }[] = [
          { id: 'quiet', label: 'Quiet', unlockPlan: 'Free' },
          { id: 'niho', label: 'Niho', unlockPlan: 'Pro' },
          { id: 'ultra', label: 'Ultra', unlockPlan: 'Ultra' },
        ];
        const capIcon = (I: React.FC<{size?: number; strokeWidth?: number}>) => <I size={14} strokeWidth={1.8} />;
        const capabilities: { icon: React.ReactNode; label: string; value: string; desc: string }[] = isFounder
          ? [
            { icon: capIcon(Zap), label: 'Intelligence', value: '无限', desc: '全部推理模型无限调用，含最新旗舰模型' },
            { icon: capIcon(Plug), label: 'MCP 服务', value: '无限', desc: '不限数量的 MCP 工具服务接入' },
            { icon: capIcon(Sparkles), label: 'Skills', value: '无限', desc: '不限数量的自定义技能包' },
            { icon: capIcon(BookOpen), label: '知识库', value: '无限', desc: '不限文档数量与存储容量' },
            { icon: capIcon(Rocket), label: 'Early Access', value: '已开启', desc: '优先体验所有新功能与实验性特性' },
          ]
          : tenantPlan === 'ultra'
          ? [
            { icon: capIcon(Zap), label: 'Intelligence', value: '无限', desc: '全部推理模型无限调用，含最新旗舰模型' },
            { icon: capIcon(Plug), label: 'MCP 服务', value: '无限', desc: '不限数量的 MCP 工具服务接入' },
            { icon: capIcon(Sparkles), label: 'Skills', value: '无限', desc: '不限数量的自定义技能包' },
            { icon: capIcon(BookOpen), label: '知识库', value: '无限', desc: '不限文档数量与存储容量' },
          ]
          : tenantPlan === 'pro'
          ? [
            { icon: capIcon(Zap), label: 'Intelligence', value: '扩展', desc: '解锁高级推理模型与更长上下文窗口' },
            { icon: capIcon(Plug), label: 'MCP 服务', value: '20 个', desc: '最多接入 20 个 MCP 工具服务' },
            { icon: capIcon(Sparkles), label: 'Skills', value: '10 个', desc: '最多创建 10 个自定义技能包' },
            { icon: capIcon(BookOpen), label: '知识库', value: '500 篇', desc: '知识库最多 500 篇文档' },
          ]
          : [
            { icon: capIcon(Zap), label: 'Intelligence', value: '基础', desc: '基础推理模型，标准上下文窗口' },
            { icon: capIcon(Plug), label: 'MCP 服务', value: '3 个', desc: '最多接入 3 个 MCP 工具服务' },
            { icon: capIcon(Sparkles), label: 'Skills', value: '2 个', desc: '最多创建 2 个自定义技能包' },
            { icon: capIcon(BookOpen), label: '知识库', value: '50 篇', desc: '知识库最多 50 篇文档' },
          ];
        return (
          <div
            className="membership-overlay"
            onClick={() => setShowUserProfile(false)}
          >
            <div className={`membership-dialog membership-dialog--${tenantPlan}`} onClick={(e) => e.stopPropagation()}>
              {/* Header: avatar + plan + logout */}
              <div className="membership-dialog__header" style={{ position: 'relative' }}>
                <button
                  onClick={() => { api.clearToken(); setUser(null); window.location.reload(); }}
                  title="退出登录"
                  className="membership-logout-btn"
                >
                  <LogOut size={13} />
                </button>
                <div className="membership-dialog__profile">
                  <div className={`membership-dialog__avatar membership-dialog__avatar--${tenantPlan}`}>
                    {(user?.name || user?.email || 'U')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="membership-dialog__name-row">
                      <div className="membership-dialog__name">{user?.name || 'User'}</div>
                      {isFounder
                        ? <span className="membership-dialog__founder-chip">♛ Founder Pass</span>
                        : <span className="membership-card__status">{planLabel} Pass</span>
                      }
                    </div>
                    <div className="membership-dialog__email">{user?.email}</div>
                    {user?.id && (
                      <button
                        className="membership-dialog__uid"
                        title="点击复制完整 ID"
                        onClick={() => {
                          navigator.clipboard.writeText(user.id ?? '').catch(() => {});
                          const el = document.querySelector('.membership-dialog__uid') as HTMLElement;
                          if (el) { el.dataset.copied = 'true'; setTimeout(() => { el.dataset.copied = ''; }, 1200); }
                        }}
                      >
                        ID: {user.id.slice(0, 8)}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="membership-dialog__body">
                {/* Capabilities list */}
                <div className="membership-cap-list">
                  {capabilities.map(({ icon, label, value, desc }) => (
                    <button
                      key={label}
                      className="membership-cap-row"
                      onClick={(e) => {
                        const tip = e.currentTarget.querySelector('.membership-cap-row__tip') as HTMLElement;
                        if (tip) tip.style.display = tip.style.display === 'block' ? 'none' : 'block';
                      }}
                    >
                      <span className="membership-cap-row__icon">{icon}</span>
                      <span className="membership-cap-row__label">{label}</span>
                      <span className="membership-cap-row__value">{value}</span>
                      <div className="membership-cap-row__tip">{desc}</div>
                    </button>
                  ))}
                </div>

                {/* Theme swatches */}
                <div className="membership-theme-list" style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
                  {allSkins.map((s) => {
                    const unlocked = allowedSkins.includes(s.id);
                    const active = skin === s.id;
                    return (
                      <button
                        key={s.id}
                        className={`membership-theme-item ${active ? 'is-active' : ''} ${!unlocked ? 'is-locked' : ''}`}
                        style={{ flex: 1, cursor: unlocked ? 'pointer' : 'not-allowed', flexDirection: 'column', gap: 6, padding: '12px 8px', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => { if (unlocked) setSkin(s.id); }}
                        disabled={!unlocked}
                      >
                        <div className={`theme-preview theme-preview--${s.id}`} />
                        <div className="membership-theme-item__name" style={{ textAlign: 'center' }}>
                          {s.label}
                        </div>
                        <div className="membership-theme-item__unlock">
                          {unlocked ? (active ? '当前' : '') : `${s.unlockPlan} 解锁`}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Light / Dark mode toggle */}
                <div className="membership-mode-toggle" style={{ marginTop: 12 }}>
                  <button
                    className={`membership-mode-btn ${themeMode === 'light' ? 'is-active' : ''}`}
                    onClick={() => setThemeMode('light')}
                  >
                    <Sun size={13} strokeWidth={2} />
                    <span>浅色</span>
                  </button>
                  <button
                    className={`membership-mode-btn ${themeMode === 'dark' ? 'is-active' : ''}`}
                    onClick={() => setThemeMode('dark')}
                  >
                    <Moon size={13} strokeWidth={2} />
                    <span>深色</span>
                  </button>
                </div>

                {isMobile && (
                  <div className="membership-mobile-portal-actions">
                    <button
                      type="button"
                      className="membership-mobile-portal-action"
                      onClick={() => {
                        setShowUserProfile(false);
                        setShowMobileSettingsDialog(true);
                      }}
                    >
                      <span className="membership-mobile-portal-action__icon"><Settings size={14} strokeWidth={1.9} /></span>
                      <span className="membership-mobile-portal-action__copy">
                        <span className="membership-mobile-portal-action__title">设置</span>
                        <span className="membership-mobile-portal-action__desc">通用设置、模型录入与 Agent 状态统一从这里进入</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="membership-mobile-portal-action"
                      onClick={() => {
                        setShowUserProfile(false);
                        setMainModule('chat');
                        setChatSubTab('persona');
                        setChatAgentsPageSection('persona-presets');
                      }}
                    >
                      <span className="membership-mobile-portal-action__icon"><Sparkles size={14} strokeWidth={1.9} /></span>
                      <span className="membership-mobile-portal-action__copy">
                        <span className="membership-mobile-portal-action__title">人格管理</span>
                        <span className="membership-mobile-portal-action__desc">进入聊天内嵌的人设/音色维护页</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

export default App;
