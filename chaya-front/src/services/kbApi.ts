/**
 * 知识库 API — 适配 chaya-engine（/api/kb/documents、upload、text、search、stats）
 * kb_id 语义 = Agent 实体 id（agid），与旧版多租户 KB 表不同。
 */

import { getBackendUrl } from '../utils/backendUrl';
import { getAgents, agentApiId, type Session } from './chat';

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (body && typeof body === 'object' && 'code' in body) {
    const c = (body as { code?: number; error?: string }).code;
    if (c !== 0 && c !== undefined) {
      throw new Error((body as { error?: string }).error || `API error ${c}`);
    }
    return (body as { data: T }).data;
  }
  return body as T;
}

export interface KnowledgeBase {
  kb_id: string;
  name: string;
  description?: string;
  embedding_config_id?: string;
  embedding_model?: string;
  embedding_dims?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  doc_count: number;
  chunk_count: number;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface KBDocument {
  doc_id: string;
  kb_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  chunk_count: number;
  status: string;
  error_msg?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KBSearchResult {
  text: string;
  score: number;
  doc_id: string;
  doc_name: string;
  chunk_index: number;
  heading?: string;
  kb_id: string;
}

export interface KBAssignment {
  assignment_id: string;
  kb_id: string;
  target_session_id: string;
  search_top_k: number;
  score_threshold: number;
  kb_name?: string;
  kb_description?: string;
  doc_count?: number;
  chunk_count?: number;
  kb_status?: string;
  created_at?: string;
}

type KBStats = { doc_count: number; chunk_count: number; agent_id?: string };

async function fetchStatsByConversation(conversationId: string): Promise<KBStats> {
  const url = `${getBackendUrl()}/api/kb/stats?conversation_id=${encodeURIComponent(conversationId)}`;
  const resp = await authFetch(url);
  if (!resp.ok) throw new Error(`stats ${resp.status}`);
  return unwrap<KBStats>(resp);
}

async function fetchStatsByAgent(agentId: string): Promise<KBStats> {
  const url = `${getBackendUrl()}/api/kb/stats?agent_id=${encodeURIComponent(agentId)}`;
  const resp = await authFetch(url);
  if (!resp.ok) throw new Error(`stats ${resp.status}`);
  return unwrap<KBStats>(resp);
}

function normalizeDoc(d: Record<string, unknown>, kbId: string): KBDocument {
  const id = String(d.doc_id ?? d.id ?? '');
  return {
    doc_id: id,
    kb_id: String(d.agent_id ?? kbId),
    file_name: String(d.file_name ?? ''),
    file_type: String(d.file_type ?? '').replace(/^\./, '') || 'txt',
    file_size: Number(d.file_size ?? 0),
    chunk_count: Number(d.chunk_count ?? 0),
    status: String(d.status ?? 'pending'),
    error_msg: d.error_msg != null ? String(d.error_msg) : undefined,
    created_at: d.created_at != null ? String(d.created_at) : undefined,
  };
}

function sessionDisplayName(s: Session): string {
  const n = (s.name || s.title || 'Agent').trim();
  return n || 'Agent';
}

// ==================== KB CRUD（引擎侧每 Agent 一个向量库；以下为兼容层） ====================

export async function createKB(_params: {
  name: string;
  description?: string;
  embedding_config_id?: string;
  embedding_model?: string;
}): Promise<KnowledgeBase> {
  const agents = await getAgents();
  const a = agents[0];
  if (!a?.session_id) throw new Error('无可用 Agent 会话');
  return getAgentKB(a.session_id);
}

export async function listKBs(): Promise<KnowledgeBase[]> {
  const agents = await getAgents();
  const out: KnowledgeBase[] = [];
  for (const a of agents) {
    const sid = a.session_id;
    const aid = agentApiId(a);
    if (!sid || !aid) continue;
    try {
      const st = await fetchStatsByConversation(sid);
      out.push({
        kb_id: aid,
        name: `${sessionDisplayName(a)}的知识库`,
        doc_count: st.doc_count,
        chunk_count: st.chunk_count,
        status: 'ready',
        embedding_config_id: 'local',
      });
    } catch {
      /* ignore */
    }
  }
  return out;
}

export async function getKB(kb_id: string): Promise<KnowledgeBase | null> {
  try {
    const st = await fetchStatsByAgent(kb_id);
    return {
      kb_id,
      name: '知识库',
      doc_count: st.doc_count,
      chunk_count: st.chunk_count,
      status: 'ready',
      embedding_config_id: 'local',
    };
  } catch {
    return null;
  }
}

export async function updateKB(_kb_id: string, _params: { name?: string; description?: string }): Promise<KnowledgeBase> {
  throw new Error('chaya-engine 暂不支持重命名知识库实体');
}

export async function deleteKB(_kb_id: string): Promise<void> {
  throw new Error('chaya-engine 暂不支持删除 Agent 级知识库');
}

// ==================== Documents ====================

export async function uploadDocuments(
  kb_id: string,
  files: File[],
): Promise<{ documents: KBDocument[] }> {
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  const url = `${getBackendUrl()}/api/kb/documents/upload?agent_id=${encodeURIComponent(kb_id)}`;
  const resp = await authFetch(url, { method: 'POST', body: fd });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Upload failed: ${resp.status}`);
  }
  const data = await unwrap<{ documents: Record<string, unknown>[] }>(resp);
  const docs = (data.documents || []).map((d) => normalizeDoc(d, kb_id));
  return { documents: docs };
}

export async function listDocuments(kb_id: string): Promise<KBDocument[]> {
  const url = `${getBackendUrl()}/api/kb/documents?agent_id=${encodeURIComponent(kb_id)}`;
  const resp = await authFetch(url);
  if (!resp.ok) return [];
  const rows = await unwrap<Record<string, unknown>[]>(resp);
  return (rows || []).map((d) => normalizeDoc(d, kb_id));
}

export async function deleteDocument(_kb_id: string, doc_id: string): Promise<void> {
  const resp = await authFetch(`${getBackendUrl()}/api/kb/documents/${encodeURIComponent(doc_id)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error('删除失败');
  await unwrap<unknown>(resp);
}

// ==================== Search ====================

export async function searchKB(
  kb_id: string,
  query: string,
  top_k: number = 5,
): Promise<KBSearchResult[]> {
  const resp = await authFetch(`${getBackendUrl()}/api/kb/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, agent_id: kb_id, top_k }),
  });
  if (!resp.ok) return [];
  const data = await unwrap<{ results: Record<string, unknown>[] }>(resp);
  const raw = data.results || [];
  let docNames = new Map<string, string>();
  try {
    const docs = await listDocuments(kb_id);
    docNames = new Map(docs.map((d) => [d.doc_id, d.file_name]));
  } catch {
    /* ignore */
  }
  return raw.map((r, i) => ({
    text: String(r.text ?? ''),
    score: Number(r.score ?? 0),
    doc_id: String(r.doc_id ?? ''),
    doc_name: docNames.get(String(r.doc_id ?? '')) || String(r.doc_id ?? ''),
    chunk_index: i,
    heading: r.heading != null ? String(r.heading) : undefined,
    kb_id,
  }));
}

// ==================== Embedding Config ====================

export async function updateKBEmbedding(_kb_id: string, _embedding_config_id: string): Promise<KnowledgeBase> {
  throw new Error('Embedding 由 chaya-engine 配置（embedding.mode / sidecar_url）管理，请修改 config.yaml 后重启引擎');
}

// ==================== Agent Auto-KB ====================

export async function getAgentKB(sessionId: string): Promise<KnowledgeBase> {
  const agents = await getAgents();
  const match = agents.find((a) => a.session_id === sessionId);
  if (!match) {
    throw new Error('未找到该会话对应的 Agent，请从左侧选择 Agent 会话');
  }
  const agentId = agentApiId(match);
  const st = await fetchStatsByConversation(sessionId);
  return {
    kb_id: agentId,
    name: `${sessionDisplayName(match)}的知识库`,
    doc_count: st.doc_count,
    chunk_count: st.chunk_count,
    status: 'ready',
    embedding_config_id: 'local',
    embedding_model: 'sentence-transformers',
    embedding_dims: 384,
  };
}

export async function addTextDocument(
  kb_id: string,
  text: string,
  title?: string,
): Promise<KBDocument> {
  const resp = await authFetch(`${getBackendUrl()}/api/kb/documents/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, title, agent_id: kb_id }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `保存失败: ${resp.status}`);
  }
  const doc = await unwrap<Record<string, unknown>>(resp);
  return normalizeDoc(doc, kb_id);
}

// ==================== Assignments（引擎未实现，占位） ====================

export async function assignKB(_params: {
  kb_id: string;
  target_session_id: string;
  search_top_k?: number;
  score_threshold?: number;
}): Promise<void> {
  throw new Error('当前后端未实现 KB 指派');
}

export async function unassignKB(_kb_id: string, _session_id: string): Promise<void> {
  throw new Error('当前后端未实现 KB 指派');
}

export async function getAssignments(_session_id: string): Promise<KBAssignment[]> {
  return [];
}
