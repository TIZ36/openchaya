import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './utils/apiClient';
import LoginPage from './components/LoginPage';
import PaperAppShell from './components/paper/AppShell';

// Login stays eager (always first paint after auth check). Every other page
// is its own chunk — without this a fresh load pulls Chat(84K) + Create(72K)
// + Persona(48K) + ... up front even before login.
const ChatPage = lazy(() => import('./components/ChatPage'));
const AgentsGalleryPage = lazy(() => import('./components/AgentsGalleryPage'));
const ModelsPage = lazy(() => import('./components/ModelsPage'));
const KnowledgePage = lazy(() => import('./components/KnowledgePage'));
const PersonaPage = lazy(() => import('./components/PersonaPage'));
const CreatePage = lazy(() => import('./components/CreatePage'));
const GalleryPage = lazy(() => import('./components/GalleryPage'));
const IntegrationsPage = lazy(() => import('./components/IntegrationsPage'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
import {
  getAgents, getSessions, createAgent, deleteSession, deleteAgent, updateSessionLLMConfig, type Session,
} from './services/chat';
import { toast } from './components/ui/use-toast';
import { SESSIONS_CHANGED_EVENT, emitSessionsChanged } from './utils/sessionEvents';
import { getMe } from './services/adminApi';
import type { CurrentUser } from './utils/themeAccess';

/* ============================================================
   Chaya App — Paper & Press only.
   All legacy sidebar/module/subtab machinery has been deleted.
   ============================================================ */

type Chapter =
  | 'chat' | 'agents' | 'persona' | 'models'
  | 'knowledge' | 'create' | 'gallery' | 'integrations' | 'settings';

interface ClientSettings {
  font: 'default' | 'pixel' | 'terminal' | 'rounded' | 'dotgothic' | 'silkscreen';
  enableToolCalling: boolean;
  density?: 'relaxed' | 'normal' | 'compact';
  handRule?: boolean;
  cmdEnterToSend?: boolean;
  showTokenCost?: boolean;
  autoTTS?: boolean;
  /** 发送前先到 Smartnote 查相关 memory，拼进消息顶部（RAG）。 */
  ragEnabled?: boolean;
  /** 检索 topk，默认 5。 */
  ragTopK?: number;
  /**
   * RAG 检索范围：
   *  - 'auto'     同时查 agent 和 workspace、并起来按检索分排——让 AI 自己决定。默认。
   *  - 'agent'    硬隔离，只看当前 agent 记下的（scope=agent:<id>）
   *  - 'workspace' 整个 workspace（不加 scope 过滤）—— 组织共享大脑全量
   */
  ragScope?: 'auto' | 'agent' | 'workspace';
  /** Selected in 设置 · 默认模型; used to initialise new agents' LLM config. */
  defaultLLMConfigId?: string;
}

const DEFAULT_SETTINGS: ClientSettings = {
  font: 'default',
  enableToolCalling: true,
  handRule: true,
  cmdEnterToSend: true,
  showTokenCost: false,
  autoTTS: false,
  ragEnabled: false,
  ragTopK: 5,
  ragScope: 'auto',
};

const LS_SETTINGS = 'settings';
const LS_SESSION = 'chatee_last_open_chat';

const chapterFromPath = (p: string): Chapter => {
  if (p.startsWith('/agents')) return 'agents';
  if (p.startsWith('/persona')) return 'persona';
  if (p.startsWith('/models')) return 'models';
  if (p.startsWith('/knowledge')) return 'knowledge';
  if (p.startsWith('/create')) return 'create';
  if (p.startsWith('/gallery')) return 'gallery';
  if (p.startsWith('/integrations')) return 'integrations';
  if (p.startsWith('/settings')) return 'settings';
  return 'chat';
};

const App: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  // ── Auth ──
  const [authed, setAuthed] = useState(api.isLoggedIn());
  const [user, setUser] = useState<CurrentUser | null>(() => api.getUser());

  // ── Primary agent & selected session ──
  const [primaryAgentId, setPrimaryAgentId] = useState(() => {
    const u = api.getUser();
    return u?.primary_agent_id || 'agent_chaya';
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
    const saved = localStorage.getItem(LS_SESSION);
    if (!saved || saved === 'temporary-session') return null;
    return saved;
  });

  // ── Sidebar data (agents + recent topic chats) ──
  const [switcherAgents, setSwitcherAgents] = useState<Session[]>([]);
  const [switcherTopics, setSwitcherTopics] = useState<Session[]>([]);

  // ── Settings ──
  const [settings, setSettings] = useState<ClientSettings>(() => {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {/* */}
    return DEFAULT_SETTINGS;
  });
  useEffect(() => {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch {/* */}
    document.documentElement.setAttribute('data-font', settings.font);
  }, [settings]);
  const updateSettings = useCallback((patch: Partial<ClientSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  // ── Enrich user (founder flag etc.) after auth ──
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    void getMe().then((me) => {
      if (cancelled) return;
      api.setUser({ ...me.user, is_founder: me.is_founder }, me.tenant);
      setUser(api.getUser());
    }).catch(() => {/* best-effort */});
    return () => { cancelled = true; };
  }, [authed]);

  // ── Load agents + recent topic chats ──
  const loadSwitcherData = useCallback(async () => {
    try {
      const [agents, sessions] = await Promise.all([getAgents(), getSessions()]);
      const list = agents || [];
      const primary = list.find((a) => a.is_primary);
      if (primary?.session_id && primary.session_id !== primaryAgentId) {
        setPrimaryAgentId(primary.session_id);
        const u = api.getUser();
        if (u) {
          const next = { ...u, primary_agent_id: primary.session_id };
          api.setUser(next, u.tenant);
          setUser(next);
        }
      }
      setSwitcherAgents(list);
      setSwitcherTopics((sessions || []).filter((s) => s.session_type === 'topic_general'));
      // Default session: primary if nothing selected
      if (!selectedSessionId && primary?.session_id) {
        setSelectedSessionId(primary.session_id);
      }
    } catch {
      setSwitcherAgents([]); setSwitcherTopics([]);
    }
  }, [primaryAgentId, selectedSessionId]);

  useEffect(() => { if (authed) void loadSwitcherData(); }, [authed, loadSwitcherData]);
  useEffect(() => {
    const onChanged = () => { void loadSwitcherData(); };
    window.addEventListener(SESSIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, onChanged);
  }, [loadSwitcherData]);

  // ── Session selection ──
  const handleSelectSession = useCallback((sid: string) => {
    setSelectedSessionId(sid);
    try { localStorage.setItem(LS_SESSION, sid); } catch {/* */}
  }, []);
  const handleSelectAgentSession = handleSelectSession;

  // ── Agent create ──
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const handleCreateAgent = useCallback(async () => {
    try {
      setIsCreatingAgent(true);
      const created = await createAgent();
      // If the user picked a default model in Settings · 默认模型, apply it
      // to the fresh agent right away. Best-effort — don't block or surface
      // the wiring error; the agent is already usable with the backend default.
      if (settings.defaultLLMConfigId) {
        try {
          await updateSessionLLMConfig(created.session_id, settings.defaultLLMConfigId);
        } catch (e) {
          console.warn('[App] apply default LLM failed:', e);
        }
      }
      handleSelectAgentSession(created.session_id);
      await loadSwitcherData();
      emitSessionsChanged();
      toast({ title: '已新养一只', description: '去给它写点人设。', variant: 'success' });
    } catch (error) {
      toast({
        title: '养不出来',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsCreatingAgent(false);
    }
  }, [handleSelectAgentSession, loadSwitcherData, settings.defaultLLMConfigId]);

  // ── Agent delete ──
  const handleDeleteAgent = async (s: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    const { session_id, name, title, id, is_primary } = s;
    if (!window.confirm(`确定要删除「${name || title || '这只 agent'}」吗？它的所有记忆也会一起消失。`)) return;
    try {
      const isAgentEntity = !!(id && session_id && id !== session_id);
      if (isAgentEntity && !is_primary) await deleteAgent(id!);
      else await deleteSession(session_id);
      toast({ title: '删了', description: `「${name || title || '会话'}」` });
      if (selectedSessionId === session_id) handleSelectSession(primaryAgentId);
      await loadSwitcherData();
      emitSessionsChanged();
    } catch (error) {
      toast({
        title: '删不掉',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  };

  // ── Chapter / URL routing ──
  const activeChapter: Chapter = chapterFromPath(location.pathname);
  const handleChapterChange = useCallback((ch: Chapter) => {
    const path = ch === 'chat' ? '/' : `/${ch}`;
    if (location.pathname !== path) navigate(path);
  }, [location.pathname, navigate]);

  // ── Auth gate ──
  if (!authed) {
    return <LoginPage onLogin={() => { setUser(api.getUser()); setAuthed(true); }} />;
  }

  const handleLogout = () => {
    api.clearToken();
    setUser(null);
    window.location.reload();
  };

  const activeAgentSessionId = selectedSessionId || primaryAgentId;

  const renderChapter = (): React.ReactNode => {
    switch (activeChapter) {
      case 'chat': {
        const agentRec = switcherAgents.find((a) => a.session_id === activeAgentSessionId);
        const agentUuid = (agentRec as any)?.id || activeAgentSessionId;
        return (
          <ChatPage
            key={`c-${activeAgentSessionId}`}
            sessionId={activeAgentSessionId}
            agentId={agentUuid}
            enableToolCalling={settings.enableToolCalling}
            cmdEnterToSend={settings.cmdEnterToSend}
            ragEnabled={settings.ragEnabled}
            ragTopK={settings.ragTopK}
            ragScope={settings.ragScope}
          />
        );
      }

      case 'agents':
        return (
          <AgentsGalleryPage
            onOpenAgent={(s) => { handleSelectAgentSession(s.session_id); navigate('/persona'); }}
            onCreateAgent={() => { void handleCreateAgent(); navigate('/persona'); }}
          />
        );

      case 'persona':
        return <PersonaPage sessionId={activeAgentSessionId} onOpenChat={() => navigate('/')} />;

      case 'models':
        return <ModelsPage />;

      case 'knowledge':
        return <KnowledgePage />;

      case 'create':
        return <CreatePage />;

      case 'gallery':
        return <GalleryPage />;

      case 'integrations':
        return <IntegrationsPage />;

      case 'settings':
        return (
          <SettingsPage
            user={user}
            settings={settings}
            onUpdateSettings={updateSettings}
            onLogout={handleLogout}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="app-shell">
      <PaperAppShell
        activeChapter={activeChapter}
        onChapterChange={handleChapterChange}
        agents={switcherAgents}
        topics={switcherTopics}
        selectedSessionId={selectedSessionId}
        onSelectAgent={(sid) => { handleSelectAgentSession(sid); if (location.pathname !== '/') navigate('/'); }}
        onSelectTopic={(sid) => { handleSelectSession(sid); if (location.pathname !== '/') navigate('/'); }}
        onCreateAgent={handleCreateAgent}
        creatingAgent={isCreatingAgent}
        onDeleteAgent={handleDeleteAgent}
        userLabel={user?.email || user?.name || '未登入'}
        onLogout={handleLogout}
      >
        <Suspense fallback={<ChapterFallback />}>
          {renderChapter()}
        </Suspense>
      </PaperAppShell>
    </div>
  );
};

const ChapterFallback: React.FC = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      fontFamily: "'Young Serif', serif",
      fontStyle: 'italic',
      color: 'var(--pencil)',
      fontSize: 14,
    }}
  >
    正在翻页…
  </div>
);

export default App;
