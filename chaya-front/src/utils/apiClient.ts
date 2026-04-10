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

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    const token = this.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const base = getBackendUrl();
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: { ...this.headers(), ...(options.headers as Record<string, string> || {}) },
    });

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
    const base = getBackendUrl();
    const token = this.getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });

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
