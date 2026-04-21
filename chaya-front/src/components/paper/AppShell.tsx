import React, { useMemo } from 'react';
import type { Session } from '../../services/chat';
import { PaperHandRule } from './index';

/* ============================================================
   Paper App Shell — replaces the legacy app-sidebar + app-frame.
   Matches mockups/a-*.html visual: wordmark, wavy rule, 7 chapters.
   Stateless — takes active chapter + callbacks as props.
   ============================================================ */

export type Chapter =
  | 'chat'
  | 'agents'
  | 'persona'
  | 'models'
  | 'knowledge'
  | 'create'
  | 'gallery'
  | 'settings';

export interface PaperAppShellProps {
  activeChapter: Chapter;
  onChapterChange: (c: Chapter) => void;
  agents: Session[];
  topics: Session[];
  selectedSessionId: string | null;
  onSelectAgent: (sessionId: string) => void;
  onSelectTopic: (sessionId: string) => void;
  onCreateAgent: () => void;
  creatingAgent?: boolean;
  onDeleteAgent?: (agent: Session, e: React.MouseEvent) => void;
  userLabel?: string;
  onLogout?: () => void;
  themeMode?: 'light' | 'dark';
  onToggleTheme?: () => void;
  children: React.ReactNode;
}

const CHAPTERS: { id: Chapter; n: string; name: string; subFn?: (ctx: ShellCtx) => string }[] = [
  { id: 'chat',       n: '00', name: '对话',    subFn: (c) => (c.topics.length > 0 ? `${c.topics.length}` : '—') },
  { id: 'agents',     n: '01', name: '我养的',  subFn: (c) => `${c.agents.length}` },
  { id: 'persona',    n: '02', name: '人设',    subFn: () => '—' },
  { id: 'models',     n: '03', name: '模型',    subFn: () => '—' },
  { id: 'knowledge',  n: '04', name: '知识',    subFn: () => '—' },
  { id: 'create',     n: '05', name: '创作',    subFn: () => '画' },
  { id: 'gallery',    n: '06', name: '作品集',  subFn: () => '—' },
  { id: 'settings',   n: '07', name: '设置',    subFn: () => '—' },
];

interface ShellCtx { agents: Session[]; topics: Session[]; }

const glyph = (name: string): string => {
  const s = (name || '').trim();
  return s ? s.charAt(0) : '·';
};

const relTime = (ts?: string) => {
  if (!ts) return '—';
  const d = Date.now() - new Date(ts).getTime();
  if (isNaN(d)) return '—';
  if (d < 5 * 60 * 1000) return '刚';
  if (d < 60 * 60 * 1000) return `${Math.floor(d / 60000)}m`;
  if (d < 24 * 60 * 60 * 1000) return `${Math.floor(d / 3600000)}h`;
  const days = Math.floor(d / 86400000);
  if (days === 1) return '昨';
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

const PaperAppShell: React.FC<PaperAppShellProps> = ({
  activeChapter,
  onChapterChange,
  agents,
  topics,
  selectedSessionId,
  onSelectAgent,
  onSelectTopic,
  onCreateAgent,
  creatingAgent,
  onDeleteAgent,
  userLabel,
  onLogout,
  themeMode = 'light',
  onToggleTheme,
  children,
}) => {
  const ctx: ShellCtx = { agents, topics };

  const sortedAgents = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.is_primary && !b.is_primary) return -1;
      if (!a.is_primary && b.is_primary) return 1;
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
  }, [agents]);

  const recentTopics = useMemo(() => {
    return [...topics]
      .sort((a, b) => {
        const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 6);
  }, [topics]);

  return (
    <div className="pshell">
      <aside className="pshell-side">
        <div className="pshell-brand">
          <div className="pshell-wordmark">Chaya<span>.</span></div>
          <div className="pshell-tagline">手作 · 一个慢 AI</div>
          <PaperHandRule width={96} />
        </div>

        <div className="pshell-section">
          <div className="pshell-label">章节</div>
          <nav className="pshell-nav">
            {CHAPTERS.map((ch) => (
              <button
                key={ch.id}
                type="button"
                className={`pshell-nav-item ${activeChapter === ch.id ? 'is-active' : ''}`}
                onClick={() => onChapterChange(ch.id)}
              >
                <span className="n">{ch.n}</span>
                <span className="name">{ch.name}</span>
                <span className="sub">{ch.subFn ? ch.subFn(ctx) : ''}</span>
              </button>
            ))}
          </nav>
        </div>

        {activeChapter === 'chat' && sortedAgents.length > 0 && (
          <div className="pshell-section pshell-section-scroll">
            <div className="pshell-label">
              你养的
              <button
                type="button"
                className="pshell-plus"
                onClick={onCreateAgent}
                disabled={creatingAgent}
                title="新养一只"
              >
                ＋
              </button>
            </div>
            <div className="pshell-agents">
              {sortedAgents.map((a, i) => {
                const sid = a.session_id;
                const active = sid === selectedSessionId;
                const label = a.name || a.title || `Agent ${sid.slice(0, 6)}`;
                return (
                  <button
                    key={sid}
                    type="button"
                    className={`pshell-agent ${active ? 'is-active' : ''} ${a.is_primary ? 'is-primary' : ''}`}
                    onClick={() => onSelectAgent(sid)}
                    title={label}
                  >
                    <span className="pshell-agent-gly" aria-hidden>{glyph(label)}</span>
                    <span className="pshell-agent-name">{label}</span>
                    <span className="pshell-agent-sub">{a.is_primary ? '本命' : String(i + 1).padStart(2, '0')}</span>
                    {!a.is_primary && onDeleteAgent && (
                      <button
                        type="button"
                        className="pshell-agent-del"
                        title={`删掉 ${label}`}
                        onClick={(e) => { e.stopPropagation(); onDeleteAgent(a, e); }}
                      >×</button>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {activeChapter === 'chat' && recentTopics.length > 0 && (
          <div className="pshell-section">
            <div className="pshell-label">最近的信</div>
            <div className="pshell-agents">
              {recentTopics.map((t) => {
                const sid = t.session_id;
                const active = sid === selectedSessionId;
                const label = t.name || t.title || t.preview_text || `会话 ${sid.slice(0, 6)}`;
                return (
                  <button
                    key={sid}
                    type="button"
                    className={`pshell-agent pshell-agent-topic ${active ? 'is-active' : ''}`}
                    onClick={() => onSelectTopic(sid)}
                    title={label}
                  >
                    <span className="pshell-agent-gly pshell-agent-gly--topic" aria-hidden>—</span>
                    <span className="pshell-agent-name">{label}</span>
                    <span className="pshell-agent-sub">{relTime(t.last_message_at)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="pshell-foot">
          <div className="pshell-foot-user" title={userLabel || ''}>
            <span className="pshell-foot-user-dot" aria-hidden />
            <span className="pshell-foot-user-name">{userLabel || '未登入'}</span>
          </div>
          <div className="pshell-foot-tools">
            <button
              type="button"
              className="pshell-foot-btn"
              onClick={onToggleTheme}
              title={themeMode === 'dark' ? '切到浅色' : '切到深色'}
            >
              {themeMode === 'dark' ? '☽' : '☀'}
            </button>
            {onLogout && (
              <button
                type="button"
                className="pshell-foot-btn"
                onClick={onLogout}
                title="登出"
              >⤴</button>
            )}
          </div>
        </div>
      </aside>

      <main className="pshell-main">{children}</main>
    </div>
  );
};

export default PaperAppShell;
