import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';

const authFetch: typeof fetch = (input, init) => api.fetchRaw(input, init);

const API_BASE = `${getBackendUrl()}/api`;

export async function updateRoleProfile(
  roleId: string,
  updates: {
    name?: string | null;
    avatar?: string | null;
    system_prompt?: string | null;
    llm_config_id?: string | null;
    media_output_path?: string | null;
    title?: string | null;
    reason?: string;
    persona?: any; // Persona 高级配置
    /** 直接更新 ext（与 persona 合并：若同时传 persona 则 ext.persona 以 persona 为准） */
    ext?: Record<string, any>;
  },
): Promise<{ success: boolean; role_id: string; current_role_version_id?: string; message?: string }> {
  const bodyData: any = { ...updates };
  if (updates.persona != null || updates.ext != null) {
    bodyData.ext = { ...(updates.ext || {}), ...(updates.persona != null ? { persona: updates.persona } : {}) };
    delete bodyData.persona;
  }
  if (updates.ext != null && updates.persona == null) {
    bodyData.ext = updates.ext;
  }
  const resp = await authFetch(`${API_BASE}/agents/${encodeURIComponent(roleId)}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyData),
  });
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const errMsg =
      (raw && typeof raw === 'object' && 'error' in raw && (raw as { error?: string }).error) ||
      `Failed to update role profile: ${resp.statusText}`;
    throw new Error(errMsg);
  }
  if (raw && typeof raw === 'object' && 'code' in raw) {
    const r = raw as { code: number; error?: string; data?: unknown };
    if (r.code !== 0) throw new Error(r.error || 'API error');
    return r.data as { success: boolean; role_id: string; current_role_version_id?: string; message?: string };
  }
  return raw as { success: boolean; role_id: string; current_role_version_id?: string; message?: string };
}
