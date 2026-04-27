import type { Session } from './chat';
import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';

const authFetch: typeof fetch = (input, init) => api.fetchRaw(input, init);

const API_BASE = `${getBackendUrl()}/api`;

export interface RoleVersion {
  version_id: string;
  is_current: boolean;
  created_at?: string;
  updated_at?: string;
  metadata?: any;
  /** 人设名称（快照） */
  name?: string | null;
  /** 人设内容预览（前 300 字） */
  system_prompt_preview?: string | null;
}

export async function listRoleVersions(roleId: string): Promise<RoleVersion[]> {
  const resp = await authFetch(`${API_BASE}/agents/${encodeURIComponent(roleId)}/versions`);
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to list role versions: ${resp.statusText}`);
  }
  const data = await resp.json();
  return data.versions || [];
}

export async function activateRoleVersion(roleId: string, versionId: string): Promise<{ success: boolean; current_role_version_id: string }> {
  const resp = await authFetch(`${API_BASE}/agents/${encodeURIComponent(roleId)}/versions/${encodeURIComponent(versionId)}/activate`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to activate role version: ${resp.statusText}`);
  }
  return await resp.json();
}

export async function createSessionFromRole(params: {
  role_id: string;
  role_version_id?: string;
  title?: string;
}): Promise<Session> {
  const resp = await authFetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: params.title,
      session_type: 'memory',
      source_role_id: params.role_id,
      source_role_version_id: params.role_version_id,
    }),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to create session from role: ${resp.statusText}`);
  }
  return await resp.json();
}

export async function createRole(params: {
  name: string;
  avatar: string;
  system_prompt: string;
  llm_config_id: string;
  media_output_path?: string;
  title?: string;
  persona?: any; // Persona 高级配置（语音、自驱思考、记忆触发）
}): Promise<Session> {
  const resp = await authFetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: params.title,
      name: params.name,
      avatar: params.avatar,
      system_prompt: params.system_prompt,
      llm_config_id: params.llm_config_id,
      media_output_path: params.media_output_path,
      session_type: 'agent',
      ext: params.persona ? { persona: params.persona } : undefined,
    }),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to create role: ${resp.statusText}`);
  }
  return await resp.json();
}

export async function applyRoleToSession(params: {
  session_id: string;
  role_id: string;
  role_version_id?: string;
  keep_session_llm_config?: boolean;
}): Promise<{ success: boolean; session_id: string; role_id: string; role_version_id: string; llm_config_id: string | null }> {
  const resp = await authFetch(`${API_BASE}/sessions/${encodeURIComponent(params.session_id)}/apply-role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_id: params.role_id,
      role_version_id: params.role_version_id,
      keep_session_llm_config: Boolean(params.keep_session_llm_config),
    }),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    throw new Error(payload?.error || `Failed to apply role: ${resp.statusText}`);
  }
  return await resp.json();
}

/** 人设预设（昵称 + 系统提示词，用于列表与聊天切换） */
export interface PersonaPreset {
  id: string;
  nickname: string;
  system_prompt: string;
}

/** 音色预设（昵称 + TTS 配置，用于列表与聊天切换） */
export interface VoicePreset {
  id: string;
  nickname: string;
  provider: string;
  voiceId: string;
  voiceName: string;
  language?: string;
  speed?: number;
}

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
