import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './utils/apiClient';
import LoginPage from './components/LoginPage';
import ChatPage from './components/ChatPage';
import AgentsGalleryPage from './components/AgentsGalleryPage';
import ModelsPage from './components/ModelsPage';
import KnowledgePage from './components/KnowledgePage';
import PersonaPage from './components/PersonaPage';
import CreatePage from './components/CreatePage';
import GalleryPage from './components/GalleryPage';
import SettingsPage from './components/SettingsPage';
import PaperAppShell from './components/paper/AppShell';
import {
  getAgents, getSessions, createAgent, deleteSession, deleteAgent, type Session,
} from './services/chat';
import { toast } from './components/ui/use-toast';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { SESSIONS_CHANGED_EVENT, emitSessionsChanged } from './utils/sessionEvents';
import { getMe } from './services/adminApi';
import type { CurrentUser, ThemeMode } from './utils/themeAccess';

/* ============================================================
   Chaya App — Paper & Press only.
   All legacy sidebar/module/subtab machinery has been deleted.
   ============================================================ */

type Chapter =
  | 'chat' | 'agents' | 'persona' | 'models'
  | 'knowledge' | 'create' | 'gallery' | 'settings';

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
};

const LS_SETTINGS = 'settings';
const LS_THEME = 'chatee_theme_mode';
const LS_SESSION = 'chatee_last_open_chat';

const chapterFromPath = (p: string): Chapter => {
  if (p.startsWith('/agents')) return 'agents';
  if (p.startsWith('/persona')) return 'persona';
  if (p.startsWith('/models')) return 'models';
  if (p.startsWith('/knowledge')) return 'knowledge';
  if (p.startsWith('/create')) return 'create';
  if (p.startsWith('/gallery')) return 'gallery';
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

  // ── Theme ──
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const raw = localStorage.getItem(LS_THEME);
      if (raw === 'light' || raw === 'dark') return raw;
    } catch {/* */}
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme-mode', themeMode);
    root.setAttribute('data-skin', 'quiet');
    if (themeMode === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    try { localStorage.setItem(LS_THEME, themeMode); } catch {/* */}
  }, [themeMode]);
  const handleThemeModeToggle = useCallback(() => {
    setThemeMode((p) => (p === 'dark' ? 'light' : 'dark'));
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
  }, [handleSelectAgentSession, loadSwitcherData]);

  // ── Agent delete ──
  const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
  const handleDeleteAgent = (s: Session, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(s);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { session_id, name, title, id, is_primary } = deleteTarget;
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
    } finally {
      setDeleteTarget(null);
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

      case 'settings':
        return (
          <SettingsPage
            user={user}
            themeMode={themeMode}
            onToggleTheme={handleThemeModeToggle}
            onSetThemeMode={setThemeMode}
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
        themeMode={themeMode}
        onToggleTheme={handleThemeModeToggle}
      >
        {renderChapter()}
      </PaperAppShell>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title="删除确认"
        description={`确定要删除「${deleteTarget?.name || deleteTarget?.title || '这只 agent'}」吗？它的所有记忆也会一起消失。`}
        confirmText="删"
        cancelText="算了"
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </div>
  );
};

export default App;
