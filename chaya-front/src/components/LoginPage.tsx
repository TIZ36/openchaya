import React, { useEffect, useRef, useState } from 'react';
import { api } from '../utils/apiClient';
import type { CurrentUser, TenantInfo } from '../utils/themeAccess';
import { getMe } from '../services/adminApi';

interface LoginPageProps {
  onLogin: () => void;
}

type SetupPhase = 'idle' | 'creating_agent' | 'preparing' | 'ready';

const SETUP_COPY: Record<Exclude<SetupPhase, 'idle'>, string> = {
  creating_agent: '正在为你塑造一位专属伙伴',
  preparing:      '让它熟悉自己的记忆与工具',
  ready:          '一切就绪，欢迎来到 Chaya',
};

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>('idle');
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const isRegister = mode === 'register';
      const path = isRegister ? '/api/auth/register' : '/api/auth/login';
      const body = isRegister ? { email, name, password } : { email, password };
      const res = await api.post<{ token: string; user: CurrentUser; tenant?: TenantInfo }>(path, body);
      api.setToken(res.token);
      api.setUser(res.user, res.tenant);
      try {
        const me = await getMe();
        api.setUser(me.user, me.tenant);
      } catch {
        // enrichment is best-effort
      }

      if (isRegister) {
        setSetupPhase('creating_agent');
        await sleep(1400);
        setSetupPhase('preparing');
        await sleep(1200);
        setSetupPhase('ready');
        await sleep(800);
      }
      onLogin();
    } catch (err: any) {
      setError(translateError(err?.message));
    } finally {
      setLoading(false);
    }
  };

  if (setupPhase !== 'idle') {
    return <SetupStage phase={setupPhase} displayName={name || email} />;
  }

  const isRegister = mode === 'register';

  return (
    <div style={s.frame}>
      {/* LEFT — hero pane */}
      <section style={s.left}>
        <div style={s.leftBorder} aria-hidden />
        <div style={s.leftTop}>
          <div style={s.overline}>Chaya · Engine · Vol. 1</div>
          <h1 style={s.hero}>
            Chaya<span style={s.heroDot}>.</span>
          </h1>
          <p style={s.copy}>
            一个可以 <em style={s.copyEm}>慢慢养成</em>、慢慢像你的 AI 伙伴。<br />
            你给它名字、口气、读过的书。它记得。
          </p>
          <svg style={{ marginTop: 28, display: 'block' }} width="160" height="10" viewBox="0 0 160 10" fill="none" aria-hidden>
            <path
              d="M1 5.2 C 22 3.2, 44 7.2, 66 4.6 S 114 3.4, 136 5.8 S 154 4.2, 159 5.0"
              stroke="var(--accent-ink)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeOpacity="0.7"
              fill="none"
            />
          </svg>
        </div>

        <div style={s.marginalia}>
          "不急。慢慢来，小店不靠多，靠稳。"
          <div style={s.marginaliaSig}>—— 阿茶，某天下午</div>
        </div>

        <div style={s.colophon}>
          <span>© 2026</span>
          <span>v1 · handmade</span>
        </div>
      </section>

      {/* RIGHT — form pane */}
      <section style={s.right}>
        <div>
          <div style={s.overlineR}>{isRegister ? 'Say hello' : 'Welcome back'}</div>
          <div style={s.tabs}>
            <button type="button" onClick={() => setMode('login')} style={tabStyle(!isRegister)}>
              登入
              {!isRegister && <span style={s.tabUnderline} aria-hidden />}
            </button>
            <span style={s.tabSep}>/</span>
            <button type="button" onClick={() => setMode('register')} style={tabStyle(isRegister)}>
              新来的
              {isRegister && <span style={s.tabUnderline} aria-hidden />}
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={s.form} noValidate>
          {isRegister && (
            <Field
              ref={firstRef}
              label="名字"
              hint="它会用这个名字叫你"
              type="text"
              value={name}
              onChange={setName}
              autoComplete="name"
              required
            />
          )}
          <Field
            ref={isRegister ? undefined : firstRef}
            label="邮箱"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
            placeholder="you@somewhere.com"
          />
          <Field
            label="密码"
            hint={isRegister ? '至少 8 个字符' : undefined}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            required
            minLength={isRegister ? 8 : undefined}
            placeholder="···········"
          />

          {error && (
            <p role="alert" style={s.errMsg}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{ ...s.submit, ...(loading ? s.submitLoading : null) }}
            onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = 'var(--accent-ink-h)'; }}
            onMouseLeave={(e) => { if (!loading) e.currentTarget.style.background = 'var(--accent-ink)'; }}
          >
            {loading
              ? (isRegister ? '正在为你准备…' : '正在登入…')
              : (isRegister ? '开始养成 →' : '继续 →')}
          </button>
        </form>

        <div style={s.auxLine}>
          <span>
            {isRegister ? (
              <>有账号了？<a onClick={() => setMode('login')} style={s.auxLink}>回去登入</a></>
            ) : (
              <>忘了？<a style={s.auxLink}>寄一封重置信</a></>
            )}
          </span>
          <span style={s.kbd}>⌘↵ 继续</span>
        </div>
      </section>
    </div>
  );
};

/* ---------- Field ---------- */

type FieldProps = {
  label: string;
  hint?: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
};

const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  ({ label, hint, type, value, onChange, autoComplete, required, minLength, placeholder }, ref) => {
    const [focused, setFocused] = useState(false);
    return (
      <label style={{ display: 'block' }}>
        <span style={s.fieldLabel}>
          <span style={s.fieldLabelText}>{label}</span>
          {hint && <span style={s.fieldHint}>{hint}</span>}
        </span>
        <input
          ref={ref}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          placeholder={placeholder}
          style={{
            ...s.fieldInput,
            borderBottomColor: focused ? 'var(--accent-ink)' : 'var(--rule-strong)',
          }}
        />
      </label>
    );
  },
);
Field.displayName = 'Field';

/* ---------- SetupStage ---------- */

const SetupStage: React.FC<{ phase: Exclude<SetupPhase, 'idle'>; displayName: string }> = ({ phase, displayName }) => {
  const order: Exclude<SetupPhase, 'idle'>[] = ['creating_agent', 'preparing', 'ready'];
  const idx = order.indexOf(phase);
  const initial = (displayName || 'U').trim().charAt(0).toUpperCase();

  return (
    <div style={s.setupWrap}>
      <div style={s.stampBlock} aria-hidden>
        {initial}
        <span style={s.stampPin} aria-hidden />
      </div>

      <ol style={s.stepList}>
        {order.map((p, i) => {
          const done = i <= idx;
          const current = i === idx;
          return (
            <li key={p} style={s.stepItem}>
              <span style={{ ...s.stepN, color: done ? 'var(--accent-ink)' : 'var(--pencil-soft)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{
                color: current ? 'var(--ink-strong)' : done ? 'var(--pencil)' : 'var(--pencil-soft)',
                fontWeight: current ? 500 : 400,
                transition: 'color 360ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}>
                {SETUP_COPY[p]}
              </span>
            </li>
          );
        })}
      </ol>

      <p style={s.setupFoot}>{phase === 'ready' ? '欢迎来到 Chaya' : '请稍等片刻'}</p>

      <style>{`
        @keyframes inkPulse {
          0%, 100% { opacity: 1; transform: translateY(0); }
          50%      { opacity: 0.78; transform: translateY(-1px); }
        }
      `}</style>
    </div>
  );
};

/* ---------- helpers ---------- */

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function translateError(raw?: string): string {
  if (!raw) return '请再试一次';
  const m = raw.toLowerCase();
  if (m.includes('invalid') && m.includes('password')) return '邮箱或密码不对';
  if (m.includes('unauthorized') || m.includes('401'))   return '邮箱或密码不对';
  if (m.includes('already exists') || m.includes('409')) return '这个邮箱已经注册过了';
  if (m.includes('network') || m.includes('failed to fetch')) return '连不上服务器，检查一下网络？';
  return raw;
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 20,
    color: active ? 'var(--ink-strong)' : 'var(--pencil)',
    cursor: 'pointer',
    padding: 0,
    paddingBottom: 6,
    background: 'transparent',
    border: 0,
    position: 'relative',
    letterSpacing: '0.01em',
  };
}

/* ---------- style book ---------- */

const fontDisplay = "'Young Serif', 'LXGW WenKai', ui-serif, Georgia, serif";
const fontSans = "'Commissioner', 'LXGW WenKai', ui-sans-serif, system-ui, sans-serif";
const fontMono = "'JetBrains Mono', ui-monospace, monospace";

const s: Record<string, React.CSSProperties> = {
  frame: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    height: '100vh',
    width: '100%',
    fontFamily: fontSans,
    color: 'var(--ink)',
    background: 'var(--paper)',
  },
  left: {
    padding: '60px 72px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 24,
    borderRight: '1px solid var(--rule)',
    background: 'linear-gradient(180deg, var(--paper) 0%, color-mix(in oklch, var(--accent-ink) 4%, var(--paper)) 100%)',
    position: 'relative',
  },
  leftBorder: {
    position: 'absolute',
    inset: 24,
    pointerEvents: 'none',
    border: '1px solid var(--rule-strong)',
    borderImage: 'repeating-linear-gradient(45deg, var(--rule-strong) 0, var(--rule-strong) 6px, transparent 6px, transparent 12px) 1',
    opacity: 0.25,
  },
  leftTop: { position: 'relative', zIndex: 1 },
  overline: {
    fontSize: 11,
    letterSpacing: '0.28em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 18,
  },
  hero: {
    fontFamily: fontDisplay,
    fontSize: 72,
    lineHeight: 0.95,
    color: 'var(--ink-strong)',
    letterSpacing: '-0.02em',
    margin: 0,
  },
  heroDot: { color: 'var(--accent-ink)' },
  copy: {
    marginTop: 18,
    maxWidth: '38ch',
    fontSize: 16,
    lineHeight: 1.8,
    color: 'var(--ink)',
  },
  copyEm: {
    fontFamily: fontDisplay,
    fontStyle: 'italic',
    color: 'var(--accent-ink)',
  },
  marginalia: {
    position: 'relative',
    zIndex: 1,
    padding: '14px 18px',
    background: 'color-mix(in oklch, var(--marginalia) 35%, transparent)',
    borderLeft: '3px solid var(--marginalia-ink)',
    maxWidth: '44ch',
    fontFamily: fontDisplay,
    fontStyle: 'italic',
    fontSize: 13.5,
    color: 'var(--marginalia-ink)',
    lineHeight: 1.7,
  },
  marginaliaSig: {
    fontFamily: fontMono,
    fontSize: 10.5,
    fontStyle: 'normal',
    letterSpacing: '0.12em',
    color: 'var(--pencil)',
    marginTop: 6,
  },
  colophon: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    fontFamily: fontMono,
    fontSize: 11,
    color: 'var(--pencil)',
    letterSpacing: '0.08em',
    position: 'relative',
    zIndex: 1,
  },
  right: {
    padding: '60px 64px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 32,
    maxWidth: 520,
    width: '100%',
  },
  overlineR: {
    fontSize: 11,
    letterSpacing: '0.28em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  tabs: {
    display: 'flex',
    gap: 20,
    alignItems: 'baseline',
    marginTop: 10,
  },
  tabSep: {
    color: 'var(--rule-strong)',
    fontFamily: fontDisplay,
    fontSize: 18,
  },
  tabUnderline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -2,
    height: 2,
    background: 'var(--accent-ink)',
    borderRadius: 1,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 22,
  },
  fieldLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  fieldLabelText: {
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  fieldHint: {
    fontFamily: fontDisplay,
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--marginalia-ink)',
  },
  fieldInput: {
    width: '100%',
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    outline: 'none',
    padding: '8px 0',
    fontFamily: fontSans,
    fontSize: 14.5,
    color: 'var(--ink)',
    transition: 'border-bottom-color 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    caretColor: 'var(--accent-ink)',
    borderRadius: 0,
  },
  errMsg: {
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--status-error)',
    margin: 0,
    marginTop: -6,
  },
  submit: {
    marginTop: 8,
    width: '100%',
    padding: 14,
    fontFamily: fontDisplay,
    fontSize: 15,
    letterSpacing: '0.04em',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    transition: 'background 220ms cubic-bezier(0.22, 1, 0.36, 1)',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 6px oklch(0.18 0.02 310 / 0.12)',
  },
  submitLoading: {
    background: 'var(--accent-soft)',
    color: 'var(--pencil)',
    cursor: 'progress',
    boxShadow: 'none',
  },
  auxLine: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 12,
    color: 'var(--pencil)',
    paddingTop: 12,
    borderTop: '1px solid var(--rule)',
  },
  auxLink: {
    color: 'var(--accent-ink)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    cursor: 'pointer',
  },
  kbd: {
    fontFamily: fontMono,
    fontSize: 11,
    letterSpacing: '0.08em',
    color: 'var(--pencil-soft)',
  },
  /* setup stage */
  setupWrap: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 32px',
    gap: 32,
    background: 'var(--paper)',
    color: 'var(--ink)',
    fontFamily: fontSans,
  },
  stampBlock: {
    position: 'relative',
    width: 96,
    height: 96,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--page-elev)',
    color: 'var(--accent-ink)',
    fontFamily: fontDisplay,
    fontSize: 42,
    lineHeight: 1,
    borderRadius: 4,
    boxShadow:
      'inset 0 0 0 1px var(--rule-strong), inset 0 1px 0 color-mix(in oklch, var(--paper) 90%, transparent), 0 14px 30px oklch(0.18 0.02 310 / 0.10), 0 2px 4px oklch(0.18 0.02 310 / 0.08)',
    animation: 'inkPulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  },
  stampPin: {
    position: 'absolute',
    top: -6,
    left: -6,
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--marginalia-ink)',
  },
  stepList: {
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    color: 'var(--pencil)',
    margin: 0,
    padding: 0,
  },
  stepItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  stepN: {
    fontFamily: fontDisplay,
    fontSize: 14,
    width: 18,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  setupFoot: {
    fontSize: 11,
    fontStyle: 'italic',
    color: 'var(--pencil-soft)',
    fontFamily: fontDisplay,
  },
};

export default LoginPage;
