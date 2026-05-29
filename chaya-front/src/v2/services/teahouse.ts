/**
 * 茶话 (teahouse) — direct-to-model conversations, no Agent.
 *
 * Backend persists them as `conversations` rows with `type=teahouse`; the
 * llm_config_id + optional model override live in `Config` jsonb. Messages,
 * deletion, rename all reuse the existing /api/conversations endpoints.
 */
import { api } from '../../utils/apiClient';
import type { Session } from '../../services/chat';

interface TeahouseConv {
  id: string;
  title?: string;
  user_id: string;
  type: 'teahouse';
  config: { llm_config_id: string; model?: string };
  created_at?: string;
  updated_at?: string;
}

function toSession(raw: any): Session {
  const cfg = (raw?.config ?? {}) as { llm_config_id?: string; model?: string };
  return {
    session_id: raw.id,
    title: raw.title,
    name: raw.title,
    session_type: 'topic_general',
    llm_config_id: cfg.llm_config_id,
    ext: { teahouse: true, llm_config_id: cfg.llm_config_id, model: cfg.model },
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  } as Session;
}

export async function listTeahouses(): Promise<Session[]> {
  const rows = await api.get<TeahouseConv[]>('/api/teahouse/conversations');
  return (rows || []).map(toSession);
}

export async function createTeahouse(params: {
  llm_config_id: string;
  model?: string;
  title?: string;
}): Promise<Session> {
  const raw = await api.post<TeahouseConv>('/api/teahouse/conversations', params);
  return toSession(raw);
}

export async function updateTeahouse(
  id: string,
  patch: { title?: string; llm_config_id?: string; model?: string },
): Promise<Session> {
  const raw = await api.request<TeahouseConv>(`/api/teahouse/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return toSession(raw);
}

export function isTeahouseSession(s: Session | null | undefined): boolean {
  return !!s && !!(s as any).ext?.teahouse;
}
