import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../services/chat';
import type { CurrentUser } from '../../utils/themeAccess';
import { PaperHandRule } from './index';
import { getTheme, setTheme, type ThemeName, getTone, setTone, TONES, type ToneName } from '../../utils/theme';
import { Link } from 'react-router-dom';

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
  | 'integrations'
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
  /** Full user object — drives the avatar menu (plan badge, usage, theme). */
  currentUser?: CurrentUser | null;
  children: React.ReactNode;
}

// 'persona' is intentionally absent from this list — the page still exists
// and is reachable by clicking an agent in 「我养的」 (which navigates to
// /persona). Removing it from the nav avoids a redundant top-level entry.
const CHAPTERS: { id: Chapter; n: string; name: string; subFn?: (ctx: ShellCtx) => string }[] = [
  { id: 'chat',       n: '00', name: '对话',    subFn: (c) => (c.topics.length > 0 ? `${c.topics.length}` : '—') },
  { id: 'agents',     n: '01', name: '我养的',  subFn: (c) => `${c.agents.length}` },
  { id: 'models',     n: '02', name: '模型',    subFn: () => '—' },
  { id: 'knowledge',  n: '03', name: '知识',    subFn: () => '—' },
  { id: 'create',     n: '04', name: '创作',    subFn: () => '画' },
  { id: 'gallery',    n: '05', name: '作品集',  subFn: () => '—' },
  { id: 'integrations', n: '06', name: '接口', subFn: () => '插件' },
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
  currentUser,
  children,
}) => {
  const ctx: ShellCtx = { agents, topics };
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);

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
          <button
            type="button"
            ref={menuAnchorRef}
            className="pshell-foot-user pshell-foot-user-btn"
            title={userLabel || ''}
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
          >
            <span className="pshell-foot-user-dot" aria-hidden />
            <span className="pshell-foot-user-name">{userLabel || '未登入'}</span>
            <span className="pshell-foot-user-chev">{menuOpen ? '▾' : '▸'}</span>
          </button>
          {menuOpen && (
            <UserMenuPopover
              user={currentUser || null}
              onClose={() => setMenuOpen(false)}
              onLogout={onLogout}
              onOpenSettings={() => { onChapterChange('settings'); setMenuOpen(false); }}
              anchorRef={menuAnchorRef}
            />
          )}
        </div>
      </aside>

      <main className="pshell-main">{children}</main>
    </div>
  );
};

/* ============================================================
   Avatar / user menu popover
   Anchored above the foot user button. Shows plan + usage badges,
   theme toggle (Pro+ gated visually but the toggle still works),
   settings shortcut, logout.
   ============================================================ */

interface UserMenuPopoverProps {
  user: CurrentUser | null;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenSettings: () => void;
  onLogout?: () => void;
}

const planLabel: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  ultra: 'Ultra',
};

const UserMenuPopover: React.FC<UserMenuPopoverProps> = ({ user, anchorRef, onClose, onOpenSettings, onLogout }) => {
  const [theme, setLocalTheme] = useState<ThemeName>(getTheme());
  const [tone, setLocalTone] = useState<ToneName>(getTone());
  const popRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape. We anchor to the bottom-left foot
  // button so the menu floats up — the popover lives in the sidebar's
  // overflow space, no portal needed.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const plan = (user?.tenant?.plan || 'free') as 'free' | 'pro' | 'ultra';
  const limits = user?.limits;
  const usage = user?.usage;
  const darkModeAllowed = !!limits?.dark_mode || plan !== 'free' || !!user?.is_founder;

  const flipTheme = () => {
    const next: ThemeName = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setLocalTheme(next);
  };

  const pickTone = (t: ToneName) => {
    if (t === tone) return;
    setTone(t);
    setLocalTone(t);
  };

  // "X / N" usage; -1 = ∞.
  const fmtUsage = (used?: number, max?: number): string => {
    const u = typeof used === 'number' ? used : 0;
    if (typeof max !== 'number' || max < 0) return `${u} / ∞`;
    return `${u} / ${max}`;
  };

  return (
    <div ref={popRef} className="pshell-user-menu">
      <div className="pshell-user-menu-head">
        <div className="pshell-user-menu-email">{user?.email || user?.name || '未登入'}</div>
        <div className="pshell-user-menu-plan">
          <span className={`pshell-plan-badge plan-${plan}`}>{planLabel[plan] || plan}</span>
          {user?.is_founder && <span className="pshell-plan-badge plan-founder">Founder</span>}
        </div>
      </div>

      <div className="pshell-user-menu-stats">
        <div className="pshell-user-menu-stat">
          <span>Agent</span>
          <span className="mono">{fmtUsage(usage?.agents, limits?.agents)}</span>
        </div>
      </div>

      <div className="pshell-user-menu-divider" />

      <div className="pshell-user-menu-tones" role="radiogroup" aria-label="主题色调">
        <span className="pshell-user-menu-tones-label">主题</span>
        <div className="pshell-user-menu-tones-list">
          {TONES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={tone === t.key}
              className={`pshell-tone-swatch${tone === t.key ? ' is-active' : ''}`}
              style={{ ['--swatch' as any]: t.swatch }}
              onClick={() => pickTone(t.key)}
              title={t.label}
            >
              <span className="pshell-tone-swatch-dot" />
              <span className="pshell-tone-swatch-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="pshell-user-menu-row"
        onClick={() => { if (darkModeAllowed) flipTheme(); }}
        disabled={!darkModeAllowed}
        title={darkModeAllowed ? '切换深色 / 浅色' : '深色模式仅 Pro+ 可用'}
      >
        <span className="pshell-user-menu-row-label">深色模式</span>
        <span className="pshell-user-menu-row-value">
          {darkModeAllowed ? (theme === 'dark' ? '已开' : '关') : 'Pro+'}
        </span>
      </button>

      <Link
        to="/settings"
        className="pshell-user-menu-row"
        onClick={(e) => { e.preventDefault(); onOpenSettings(); }}
      >
        <span className="pshell-user-menu-row-label">设置</span>
        <span className="pshell-user-menu-row-value">→</span>
      </Link>

      {onLogout && (
        <button
          type="button"
          className="pshell-user-menu-row danger"
          onClick={() => { onLogout(); onClose(); }}
        >
          <span className="pshell-user-menu-row-label">登出</span>
          <span className="pshell-user-menu-row-value">⤴</span>
        </button>
      )}
    </div>
  );
};

export default PaperAppShell;
