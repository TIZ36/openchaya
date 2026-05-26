import React, { useEffect, useRef, useState } from 'react';
import { api } from '../utils/apiClient';
import type { CurrentUser, TenantInfo } from '../utils/themeAccess';
import { getMe } from '../services/adminApi';
import './theme.css';

interface Props { onLogin: () => void }

const LoginPage: React.FC<Props> = ({ onLogin }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, [mode]);

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
      const msg = String(err?.message || '出错了');
      setError(msg.includes('401') || /invalid/i.test(msg) ? '邮箱或密码不对' : msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chaya-v2">
      <div className="v2-tb"><div className="v2-dots"><i /><i /><i /></div></div>
      <div className="v2-login-page">
        <div className="v2-login-col">
          <div className="v2-login-brand">茶话 · Chaya</div>
          <div className="v2-login-tag">极简、克制、可信。</div>

          <form onSubmit={submit} className="v2-login-form">
            {mode === 'register' && (
              <label className="v2-field">
                <span>名字</span>
                <input
                  ref={mode === 'register' ? firstRef : undefined}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="想被怎么称呼"
                  autoComplete="nickname"
                />
              </label>
            )}
            <label className="v2-field">
              <span>邮箱</span>
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
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 8 位' : '密码'}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'register' ? 8 : undefined}
              />
            </label>

            {error && <div className="v2-login-err">{error}</div>}

            <button type="submit" className="v2-login-submit" disabled={loading}>
              {loading ? '稍等…' : mode === 'login' ? '登入' : '注册'}
            </button>
          </form>

          <div className="v2-login-switch">
            {mode === 'login' ? (
              <>没有账号？<button type="button" onClick={() => setMode('register')}>注册一个</button></>
            ) : (
              <>已经有账号？<button type="button" onClick={() => setMode('login')}>去登入</button></>
            )}
          </div>

          <div className="v2-login-foot">登入即同意 服务条款 · 隐私协议</div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
