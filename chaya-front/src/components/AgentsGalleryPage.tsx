import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAgents, Session } from '../services/chat';
import {
  PaperPage, PaperTopbar, PaperContent, PaperCard, PaperNewCard,
  PaperDot, PaperButton,
} from './paper';

/* ============================================================
   Agents Gallery — "我养的" cards view.
   Aligned with mockups/a-agents.html. Click card → agent dossier.
   ============================================================ */

const glyphFor = (s: Session): string => {
  const name = (s.name || s.title || '').trim();
  if (!name) return '·';
  return name.charAt(0);
};

const relativeTime = (ts?: string): string => {
  if (!ts) return '—';
  const t = new Date(ts).getTime();
  if (isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

const statusFor = (s: Session): { tone: 'ok' | 'warn' | 'default'; label: string } => {
  if (!s.last_message_at) return { tone: 'default', label: '还没开始' };
  const ago = Date.now() - new Date(s.last_message_at).getTime();
  if (ago < 5 * 60 * 1000) return { tone: 'ok', label: '在线' };
  if (ago < 60 * 60 * 1000) return { tone: 'warn', label: '等你' };
  return { tone: 'default', label: '闲着' };
};

const modelLabel = (s: Session): string => {
  const raw = (s as any).model || (s as any).llm_config_id;
  if (!raw) return '未配置';
  return String(raw);
};

/** Split system prompt into a short tagline (first sentence) and longer body. */
const parsePrompt = (sp?: string): { tagline: string; rest: string } => {
  if (!sp) return { tagline: '', rest: '' };
  const text = sp.trim();
  const match = text.match(/^([^。.!?\n]{4,40})[。.!?\n]/);
  if (match) {
    return {
      tagline: match[1].trim(),
      rest: text.slice(match[0].length).trim(),
    };
  }
  // No punctuation — split arbitrarily so the card doesn't look empty.
  if (text.length > 40) {
    return { tagline: text.slice(0, 28), rest: text.slice(28).trim() };
  }
  return { tagline: text, rest: '' };
};

/** Role = short italic tagline under the name — describes WHAT the agent is. */
const roleLine = (s: Session): string => {
  const desc = (s as any).description;
  if (typeof desc === 'string' && desc.trim()) return desc.trim().slice(0, 40);
  const { tagline } = parsePrompt(s.system_prompt);
  if (tagline) return tagline;
  return s.is_primary ? '你的本命 agent' : '新同伴';
};

/** Blurb = agent's self-description (continues from system_prompt body).
 *  Never uses preview_text — that's conversation content, not agent info. */
const blurbLine = (s: Session): string => {
  const { rest, tagline } = parsePrompt(s.system_prompt);
  const body = rest || (tagline && tagline.length > 28 ? tagline : '');
  if (body) {
    const clean = body.replace(/\s+/g, ' ').trim();
    return clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
  }
  // No system prompt at all — quiet placeholder.
  return s.is_primary
    ? '还没给它写人设。进去告诉它，你想让它像谁。'
    : '还没写人设。进档案页给它一个口气。';
};

interface AgentsGalleryPageProps {
  onOpenAgent?: (session: Session) => void;
  onCreateAgent?: () => void;
}

const AgentsGalleryPage: React.FC<AgentsGalleryPageProps> = ({ onOpenAgent, onCreateAgent }) => {
  const [agents, setAgents] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const list = await getAgents();
      setAgents(list);
    } catch (e: any) {
      setErr(e?.message || '加载 agent 列表时出错');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => {
    return [...agents].sort((a, b) => {
      if (a.is_primary && !b.is_primary) return -1;
      if (!a.is_primary && b.is_primary) return 1;
      const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return tb - ta;
    });
  }, [agents]);

  const handleOpen = (s: Session) => {
    if (onOpenAgent) onOpenAgent(s);
    else navigate('/persona');
  };

  const handleCreate = () => {
    if (onCreateAgent) onCreateAgent();
    else navigate('/persona');
  };

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter One · Book of Companions"
        title="我养的"
        subtitle="你给它名字、口气、记得的事。它就慢慢长成一个只给你用的伙伴。"
        meta={loading ? '正在取…' : `${agents.length} / 共 ${agents.length}`}
        actions={
          <>
            <PaperButton variant="ghost" size="small" onClick={load} disabled={loading}>
              {loading ? '…' : '刷新'}
            </PaperButton>
            <PaperButton onClick={handleCreate}>+ 新养一只</PaperButton>
          </>
        }
      />

      <PaperContent>
        {err && (
          <p
            role="alert"
            style={{
              padding: '12px 14px',
              background: 'var(--status-error-bg)',
              border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
              color: 'oklch(0.40 0.130 25)',
              fontSize: 13,
              borderRadius: 2,
              marginBottom: 24,
              fontFamily: "'Young Serif', serif",
            }}
          >
            取 agents 的时候出错了：{err}
          </p>
        )}

        {loading && agents.length === 0 ? (
          <LoadingSkeleton />
        ) : !err && agents.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : (
          <div className="paper-card-grid">
            {sorted.map((s, idx) => {
              const st = statusFor(s);
              return (
                <PaperCard
                  key={s.id || s.session_id}
                  primary={s.is_primary}
                  primaryNote={s.is_primary ? '本命' : undefined}
                  num={String(idx + 1).padStart(2, '0')}
                  glyph={glyphFor(s)}
                  title={s.name || s.title || '未命名'}
                  role={roleLine(s)}
                  blurb={blurbLine(s)}
                  footLeft={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <PaperDot tone={st.tone} /> {st.label} · {modelLabel(s)}
                    </span>
                  }
                  footRight={relativeTime(s.last_message_at)}
                  onClick={() => handleOpen(s)}
                />
              );
            })}
            <PaperNewCard onClick={handleCreate} title="再养一只" subtitle="NEW COMPANION" />
          </div>
        )}
      </PaperContent>
    </PaperPage>
  );
};

const LoadingSkeleton: React.FC = () => (
  <div className="paper-card-grid">
    {[0, 1, 2, 3].map((i) => (
      <article
        key={i}
        className="paper-card"
        style={{ cursor: 'default', pointerEvents: 'none', opacity: 0.45 }}
      >
        <span className="c-num">0{i + 1}</span>
        <span
          className="c-glyph"
          style={{
            background: 'var(--rule)',
            color: 'transparent',
            boxShadow: 'none',
            border: '1px solid var(--rule-strong)',
          }}
        >·</span>
        <h3 style={{ color: 'var(--pencil-soft)' }}>正在取…</h3>
        <div className="c-role" style={{ color: 'var(--pencil-soft)' }}>—</div>
        <div className="c-blurb" style={{ color: 'var(--pencil-soft)', fontStyle: 'italic' }}>—</div>
      </article>
    ))}
  </div>
);

const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div
    style={{
      padding: '48px 24px',
      textAlign: 'center',
      border: '2px dashed var(--rule-strong)',
      borderRadius: 4,
      color: 'var(--pencil)',
    }}
  >
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 40, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>＋</div>
    <h3 style={{ fontFamily: "'Young Serif', serif", fontSize: 18, color: 'var(--ink-strong)', margin: 0 }}>还没养过 agent</h3>
    <p style={{ marginTop: 8, fontSize: 13, color: 'var(--pencil)', fontFamily: "'Young Serif', serif", fontStyle: 'italic', maxWidth: '40ch', margin: '8px auto 20px' }}>
      从零开始捏一个。起名字、写人设、挑模型。慢慢来。
    </p>
    <PaperButton onClick={onCreate}>开始养第一只 →</PaperButton>
  </div>
);

export default AgentsGalleryPage;
