/**
 * 统一 API 客户端
 * - 自动添加 JWT Authorization header
 * - 自动解包 {code: 0, data: ...} 响应格式
 * - 统一错误处理
 */

import { getBackendUrl } from './backendUrl';
import { buildStoredUser, type CurrentUser, type TenantInfo } from './themeAccess';

const TOKEN_KEY = 'chaya_token';
const USER_KEY = 'chaya_user';

class ApiClient {
  getToken(): string | null {
    return typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;
  }

  setToken(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  }

  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  getUser(): CurrentUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (!raw) return null;
      return buildStoredUser(JSON.parse(raw));
    } catch { return null; }
  }

  setUser(user: CurrentUser, tenant?: TenantInfo | null) {
    localStorage.setItem(USER_KEY, JSON.stringify(buildStoredUser(user, tenant)));
  }

  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  /**
   * Low-level: native fetch with JWT auto-attached and centralised 401 handling.
   * Use this from service files instead of rolling your own authFetch — that
   * way every call benefits from token injection, auto-logout on 401, and any
   * future cross-cutting concern (retries, telemetry, request IDs).
   *
   * Accepts either a path ("/api/foo") or an absolute URL.
   */
  async fetchRaw(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' && input.startsWith('/')
      ? `${getBackendUrl()}${input}`
      : input;
    const headers = new Headers(init.headers || {});
    if (!headers.has('Authorization')) {
      const token = this.getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(url as RequestInfo, { ...init, headers });
    if (res.status === 401) this.handleUnauthorized();
    return res;
  }

  /**
   * Called when any request comes back 401. Clears the token and bounces to
   * the login screen — without this, every service would need to handle
   * token expiry itself, and they all do it inconsistently.
   */
  private unauthorizedHandled = false;
  private handleUnauthorized() {
    if (this.unauthorizedHandled) return;
    // 没有 token 本来就是未登录态（按需登录：可免登录浏览本地功能）——此时 401 是预期的，
    // 绝不能 clearToken + reload，否则未登录访问任何受保护接口都会触发整页刷新死循环
    // （reload 后 api 是新实例、unauthorizedHandled 重置，挡不住 → 一直闪 + 卡死）。
    // 仅当「本地有 token 但被服务端拒绝」（过期/失效）时才登出并刷新到登录态。
    if (!this.getToken()) return;
    this.unauthorizedHandled = true;
    this.clearToken();
    if (typeof window !== 'undefined') {
      // Defer so the in-flight caller still sees its 401 and can show a toast.
      setTimeout(() => window.location.reload(), 50);
    }
  }

  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await this.fetchRaw(path, { ...options, headers });

    // Handle non-JSON responses (blobs, empty)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return undefined as T;
    }

    const body = await res.json();

    // Unwrap {code, data} envelope
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        const err = new Error(body.error || `API error ${body.code}`);
        (err as any).code = body.code;
        throw err;
      }
      return body.data as T;
    }

    // Fallback: return raw (for non-envelope responses)
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body as T;
  }

  requestRaw<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    return this.request<T>(path, options);
  }

  get<T = any>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T = any>(path: string, data?: any): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  put<T = any>(path: string, data?: any): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  del<T = any>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * Upload files (multipart/form-data, no Content-Type header — browser sets it)
   */
  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const res = await this.fetchRaw(path, { method: 'POST', body: formData });
    const body = await res.json();
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) throw new Error(body.error || `API error ${body.code}`);
      return body.data as T;
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body as T;
  }
}

export const api = new ApiClient();
