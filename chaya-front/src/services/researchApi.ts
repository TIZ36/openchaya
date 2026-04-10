import { getBackendUrl } from '../utils/backendUrl';

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};

const API_BASE = `${getBackendUrl()}/api/research`;

export type ResearchSourceType = 'url' | 'file' | 'image' | 'dir';

export interface ResearchSource {
  source_id: string;
  session_id: string;
  source_type: ResearchSourceType;
  title?: string;
  url?: string;
  file_path?: string;
  mime_type?: string;
  meta?: any;
  created_at?: string;
}

export async function addUrlSource(params: {
  session_id: string;
  url: string;
  title?: string;
}): Promise<ResearchSource> {
  const resp = await authFetch(`${API_BASE}/sources/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Failed to add url source: ${resp.statusText}`);
  return await resp.json();
}

export async function listSources(session_id: string): Promise<ResearchSource[]> {
  const resp = await authFetch(`${API_BASE}/sources?session_id=${encodeURIComponent(session_id)}`);
  if (!resp.ok) throw new Error(`Failed to list sources: ${resp.statusText}`);
  const data = await resp.json();
  return data.sources || [];
}

export async function uploadSources(params: {
  session_id: string;
  files: File[];
  upload_kind?: 'files' | 'dir';
  dir_alias?: string;
}): Promise<{ sources: ResearchSource[]; indexed_documents: number }> {
  const fd = new FormData();
  fd.append('session_id', params.session_id);
  if (params.upload_kind) fd.append('upload_kind', params.upload_kind);
  if (params.dir_alias) fd.append('dir_alias', params.dir_alias);
  for (const f of params.files) {
    // If it's directory selection, preserve relative path
    const anyF: any = f as any;
    const rel = anyF.webkitRelativePath || f.name;
    fd.append('files', f, rel);
  }

  const resp = await authFetch(`${API_BASE}/sources/upload`, {
    method: 'POST',
    body: fd,
  });
  if (!resp.ok) {
    let payload: any = null;
    try {
      payload = await resp.json();
    } catch {}
    if (resp.status === 413) {
      const maxBytes = payload?.max_bytes;
      const maxMb = typeof maxBytes === 'number' ? Math.round(maxBytes / 1024 / 1024) : undefined;
      throw new Error(`上传内容过大（413）。${maxMb ? `后端限制约 ${maxMb}MB。` : ''}请减少文件数量/大小，或提高 backend/config.yaml 的 research.upload_max_mb。`);
    }
    throw new Error(payload?.message || payload?.error || `Failed to upload sources: ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
}

export async function resolveSources(params: {
  session_id: string;
  tokens: string[];
}): Promise<{ resolved: any[] }> {
  const resp = await authFetch(`${API_BASE}/sources/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Failed to resolve sources: ${resp.statusText}`);
  return await resp.json();
}

export function getSourceFileUrl(params: { session_id: string; source_id: string }): string {
  const { session_id, source_id } = params;
  return `${API_BASE}/sources/file?session_id=${encodeURIComponent(session_id)}&source_id=${encodeURIComponent(source_id)}`;
}

export async function retrieve(params: {
  session_id: string;
  query: string;
  limit?: number;
}): Promise<{ results: Array<{ doc_id: string; source_id: string; rel_path?: string; score: number; snippet: string }> }> {
  const resp = await authFetch(`${API_BASE}/retrieve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Failed to retrieve: ${resp.statusText}`);
  return await resp.json();
}


