import React, { useEffect, useRef, useState } from 'react';
import { api } from '../utils/apiClient';
import type { CurrentUser, TenantInfo } from '../utils/themeAccess';
import { getMe } from '../services/adminApi';
import { IconLogo } from './icons';
import { useI18n } from '../i18n';
import './theme.css';

interface Props {
  onLogin: () => void;
  /** 提供 onClose → 渲染成可关闭的浮层（按需登录）；省略 → 整页登录（旧行为）。 */
  onClose?: () => void;
}

const LoginPage: React.FC<Props> = ({ onLogin, onClose }) => {
  const { t: tr } = useI18n();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, [mode]);
  // 浮层模式：Esc 关闭。
  useEffect(() => {
    if (!onClose) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
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
      } catch { /* best-effort */ }
      onLogin();
    } catch (err: any) {
      const msg = String(err?.message || tr('common.error'));
      setError(msg.includes('401') || /invalid/i.test(msg) ? tr('login.badCredentials') : msg);
    } finally {
      setLoading(false);
    }
  };

  const col = (
        <div className="v2-login-col">
          <div className="v2-login-mark" aria-hidden><IconLogo /></div>
          <div className="v2-login-brand">{tr('login.brand')}</div>
          <div className="v2-login-tag">{tr('login.tagline')}</div>

          <form onSubmit={submit} className="v2-login-form">
            {mode === 'register' && (
              <label className="v2-field">
                <span>{tr('login.name')}</span>
                <input
                  ref={mode === 'register' ? firstRef : undefined}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tr('login.namePlaceholder')}
                  autoComplete="nickname"
                />
              </label>
            )}
            <label className="v2-field">
              <span>{tr('login.email')}</span>
              <input
                ref={mode === 'login' ? firstRef : undefined}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>
            <label className="v2-field">
              <span>{tr('login.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? tr('login.passwordRegisterPlaceholder') : tr('login.passwordPlaceholder')}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'register' ? 8 : undefined}
              />
            </label>

            {error && <div className="v2-login-err">{error}</div>}

            <button type="submit" className="v2-login-submit" disabled={loading}>
              {loading ? tr('common.loading') : mode === 'login' ? tr('login.submitLogin') : tr('login.submitRegister')}
            </button>
          </form>

          <div className="v2-login-switch">
            {mode === 'login' ? (
              <>{tr('login.noAccount')}<button type="button" onClick={() => setMode('register')}>{tr('login.goRegister')}</button></>
            ) : (
              <>{tr('login.haveAccount')}<button type="button" onClick={() => setMode('login')}>{tr('login.goLogin')}</button></>
            )}
          </div>

          <div className="v2-login-foot">{tr('login.foot')}</div>
        </div>
  );

  // 浮层模式（按需登录）：可点遮罩 / ✕ / Esc 关闭，不挡本地功能。
  if (onClose) {
    return (
      <div className="v2-modal-mask v2-login-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="v2-login-modal" role="dialog" aria-modal="true" aria-label={tr('login.dialogLabel')} onMouseDown={(e) => e.stopPropagation()}>
          <button className="v2-login-x" onClick={onClose} aria-label={tr('common.close')}>✕</button>
          {col}
        </div>
      </div>
    );
  }
  // 整页模式（旧行为，保留以备直接作为登录页使用）。
  return (
    <div className="chaya-v2">
      <div className="v2-tb"><div className="v2-dots"><i /><i /><i /></div></div>
      <div className="v2-login-page">{col}</div>
    </div>
  );
};

export default LoginPage;
