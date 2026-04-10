import React, { useState } from 'react';
import { api } from '../utils/apiClient';
import type { CurrentUser, TenantInfo } from '../utils/themeAccess';
import { getMe } from '../services/adminApi';

interface LoginPageProps {
  onLogin: () => void;
}

type SetupPhase = 'idle' | 'creating_agent' | 'preparing' | 'ready';

const SETUP_MESSAGES: Record<SetupPhase, string> = {
  idle: '',
  creating_agent: '正在为你创建专属 AI 助手...',
  preparing: '初始化记忆系统与工具...',
  ready: '一切就绪，欢迎使用 Chaya ✨',
};

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>('idle');

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
        // founder/me enrichment is best-effort during login
      }

      if (isRegister) {
        // Registration → show setup animation
        // Backend already creates PrimaryAgent in register handler,
        // but we show a friendly animation to set expectations
        setSetupPhase('creating_agent');
        await sleep(1500);
        setSetupPhase('preparing');
        await sleep(1200);
        setSetupPhase('ready');
        await sleep(800);
      }

      onLogin();
    } catch (err: any) {
      setError(err.message || 'Failed');
    } finally {
      setLoading(false);
    }
  };

  // Setup animation screen
  if (setupPhase !== 'idle') {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--surface-primary, #0a0a0a)',
        color: 'var(--text-primary, #e0e0e0)',
        gap: 24,
      }}>
        {/* Animated avatar */}
        <div style={{
          width: 72, height: 72, borderRadius: '50%',
          background: 'linear-gradient(135deg, #c9a84c, #8b6914)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 28, fontWeight: 700, color: '#0a0a1a',
          boxShadow: '0 0 40px rgba(201,168,76,0.3)',
          animation: 'pulse-glow 2s ease-in-out infinite',
        }}>
          {(name || email || 'U')[0].toUpperCase()}
        </div>

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {(['creating_agent', 'preparing', 'ready'] as SetupPhase[]).map((phase, i) => (
            <div key={phase} style={{
              width: 8, height: 8, borderRadius: '50%',
              background: phaseIndex(setupPhase) >= i ? '#c9a84c' : 'rgba(255,255,255,0.1)',
              transition: 'background 0.5s ease',
              boxShadow: phaseIndex(setupPhase) >= i ? '0 0 8px rgba(201,168,76,0.5)' : 'none',
            }} />
          ))}
        </div>

        {/* Status text */}
        <div style={{
          fontSize: 14, color: 'rgba(255,255,255,0.7)',
          transition: 'opacity 0.3s ease',
          textAlign: 'center',
        }}>
          {SETUP_MESSAGES[setupPhase]}
        </div>

        <style>{`
          @keyframes pulse-glow {
            0%, 100% { box-shadow: 0 0 20px rgba(201,168,76,0.2); transform: scale(1); }
            50% { box-shadow: 0 0 40px rgba(201,168,76,0.4); transform: scale(1.05); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--surface-primary, #0a0a0a)',
      color: 'var(--text-primary, #e0e0e0)',
    }}>
      <div style={{ width: 320 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🤖</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Chaya</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted, #666)', marginTop: 4 }}>AI Agent Engine</p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'register' && (
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="Name" required
              style={inputStyle}
            />
          )}
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="Email" required
            style={inputStyle}
          />
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" required
            style={inputStyle}
          />

          {error && <p style={{ color: '#ef4444', fontSize: 12, margin: 0 }}>{error}</p>}

          <button
            type="submit" disabled={loading}
            style={{
              padding: '10px 0',
              borderRadius: 10,
              border: 'none',
              background: '#4f46e5',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted, #666)', marginTop: 16 }}>
          {mode === 'login' ? (
            <>No account? <button onClick={() => setMode('register')} style={linkStyle}>Register</button></>
          ) : (
            <>Have account? <button onClick={() => setMode('login')} style={linkStyle}>Sign In</button></>
          )}
        </p>
      </div>
    </div>
  );
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid var(--border-default, #333)',
  background: 'var(--surface-secondary, #1a1a1a)',
  color: 'var(--text-primary, #e0e0e0)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
};

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#6366f1',
  cursor: 'pointer',
  textDecoration: 'underline',
  fontSize: 12,
  padding: 0,
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function phaseIndex(phase: SetupPhase): number {
  return ['creating_agent', 'preparing', 'ready'].indexOf(phase);
}

export default LoginPage;
