/**
 * Smartnote Cloud API adapter — v1 endpoints.
 * Docs: ~/aiproj/smartnote/cloud/api
 *
 * Auth model:
 *   1. User sets an API key (sn_live_...) once
 *   2. SDK exchanges it for a JWT via POST /v1/auth/token
 *   3. JWT is cached in-memory + localStorage; auto-refresh when close to expiry
 *   4. All other endpoints take the JWT as Bearer
 */

const LS_BASE_KEY = 'chaya_smartnote_cloud_base';
const LS_API_KEY  = 'chaya_smartnote_cloud_api_key';
const LS_JWT      = 'chaya_smartnote_cloud_jwt';
const LS_EXP      = 'chaya_smartnote_cloud_jwt_exp';

const DEFAULT_BASE = 'https://api.smartnote.cloud';

/* ============================================================
   Config — base URL + API key stored in localStorage
   ============================================================ */

export function getSmartnoteBaseUrl(): string {
  try {
    const v = localStorage.getItem(LS_BASE_KEY);
    if (v && v.trim()) return v.trim().replace(/\/$/, '');
  } catch {/* */}
  return DEFAULT_BASE;
}
export function setSmartnoteBaseUrl(url: string): void {
  try {
    const t = (url || '').trim().replace(/\/$/, '');
    if (t) localStorage.setItem(LS_BASE_KEY, t);
    else localStorage.removeItem(LS_BASE_KEY);
  } catch {/* */}
}
export function getSmartnoteApiKey(): string {
  try { return localStorage.getItem(LS_API_KEY) || ''; } catch { return ''; }
}
export function setSmartnoteApiKey(k: string): void {
  try {
    if (k) localStorage.setItem(LS_API_KEY, k);
    else localStorage.removeItem(LS_API_KEY);
    // Clear cached JWT so next call re-exchanges
    localStorage.removeItem(LS_JWT);
    localStorage.removeItem(LS_EXP);
  } catch {/* */}
}

/* ============================================================
   Auth — API key → JWT exchange with expiry + auto-refresh
   ============================================================ */

async function fetchJwt(): Promise<string> {
  const key = getSmartnoteApiKey();
  if (!key) throw new Error('未配置 Smartnote API key');
  const base = getSmartnoteBaseUrl();
  const res = await fetch(`${base}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key }),
  });
  if (!res.ok) {
    let msg = `token exchange failed (${res.status})`;
    try {
      const b = await res.json();
      if (b?.detail) msg = String(b.detail);
    } catch {/* */}
    throw new Error(msg);
  }
  const data = await res.json() as { jwt: string; expires_at: number };
  try {
    localStorage.setItem(LS_JWT, data.jwt);
    localStorage.setItem(LS_EXP, String(data.expires_at));
  } catch {/* */}
  return data.jwt;
}

async function ensureJwt(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = '';
  let exp = 0;
  try {
    jwt = localStorage.getItem(LS_JWT) || '';
    exp = Number(localStorage.getItem(LS_EXP) || 0);
  } catch {/* */}
  // Refresh if missing or expires in < 60s
  if (!jwt || !exp || exp - now < 60) return fetchJwt();
  return jwt;
}

async function req<T>(path: string, init?: RequestInit, retryOn401 = true): Promise<T> {
  const base = getSmartnoteBaseUrl();
  const jwt = await ensureJwt();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401 && retryOn401) {
    try { localStorage.removeItem(LS_JWT); localStorage.removeItem(LS_EXP); } catch {/* */}
    return req<T>(path, init, false);
  }
  if (!res.ok) {
    let msg = `Smartnote ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    } catch {/* */}
    throw new Error(msg);
  }
  if (res.status === 204) return null as unknown as T;
  return res.json() as Promise<T>;
}

export async function smartnoteProbe(): Promise<{ ok: boolean; error?: string }> {
  try {
    const base = getSmartnoteBaseUrl();
    const res = await fetch(`${base}/v1/health`);
    if (!res.ok) return { ok: false, error: `health ${res.status}` };
    const key = getSmartnoteApiKey();
    if (!key) return { ok: false, error: 'no api key' };
    await ensureJwt();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ============================================================
   Types (mirror cloud pydantic models)
   ============================================================ */

export type MemoryKind = 'fact' | 'preference' | 'procedure' | 'episode' | 'document_ref';

export interface Memory {
  id: string;
  workspace_id: string;
  author_agent: string;
  kind: MemoryKind;
  scope: string;
  content: string;
  structured?: Record<string, unknown> | null;
  tags: string[];
  source_refs: Array<Record<string, unknown>>;
  confidence: number;
  pinned: boolean;
  supersedes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryCreate {
  kind: MemoryKind;
  content: string;
  scope?: string;
  structured?: Record<string, unknown>;
  tags?: string[];
  source_refs?: Array<Record<string, unknown>>;
  confidence?: number;
  pinned?: boolean;
  supersedes?: string;
}

export interface MemoryPatch {
  content?: string;
  scope?: string;
  structured?: Record<string, unknown>;
  tags?: string[];
  source_refs?: Array<Record<string, unknown>>;
  confidence?: number;
  pinned?: boolean;
}

export interface RetrievedMemory {
  id: string;
  kind: string;
  scope: string;
  content: string;
  tags: string[];
  score: number;
  vector_score: number;
  lexical_score: number;
  pinned: boolean;
  author_agent: string;
  created_at: string;
}

export interface Document {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  byte_size: number;
  ingested_at: string | null;
  created_at: string;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** A knowledge domain (知识域) is a workspace tag: its `name` is the domain's
 *  alias/identifier used everywhere (memory tags, doc metadata.domains, the
 *  @mention in chat, and the retrieve `tags` filter). */
export interface Tag {
  id?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order?: number;
}

/* ============================================================
   Memories CRUD
   ============================================================ */

export const smartnoteMemories = {
  list: (params: { kind?: MemoryKind; scope?: string; tag?: string; q?: string; since?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return req<{ memories: Memory[] }>(`/v1/memories${suffix}`);
  },
  get: (id: string) => req<Memory>(`/v1/memories/${encodeURIComponent(id)}`),
  create: (body: MemoryCreate) =>
    req<Memory>('/v1/memories', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, patch: MemoryPatch) =>
    req<Memory>(`/v1/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) =>
    req<void>(`/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/* ============================================================
   Retrieve
   ============================================================ */

export interface RetrieveRequest {
  query: string;
  kinds?: MemoryKind[];
  scope?: string;
  tags?: string[];
  topk?: number;
  vector_weight?: number;
  lexical_weight?: number;
}

export async function smartnoteRetrieve(r: RetrieveRequest) {
  return req<{ results: RetrievedMemory[]; query_embedded: boolean }>(
    '/v1/retrieve',
    { method: 'POST', body: JSON.stringify(r) },
  );
}

/* ============================================================
   Documents (create + ingest + list)
   ============================================================ */

export const smartnoteDocuments = {
  list: () => req<{ documents: Document[] }>('/v1/documents'),
  get: (id: string) => req<Document & { content: string }>(`/v1/documents/${encodeURIComponent(id)}`),
  create: (body: { name: string; content: string; kind?: string; metadata?: Record<string, unknown> }) =>
    req<Document>('/v1/documents', { method: 'POST', body: JSON.stringify(body) }),
  /** Partial update. Note: `metadata` REPLACES the stored object, so callers
   *  must merge with the existing metadata. Patching metadata.domains re-tags
   *  the document's already-ingested chunks in place (cloud-side), so a domain
   *  reassignment takes effect for `@域` retrieval without re-ingesting. */
  patch: (id: string, body: { name?: string; content?: string; kind?: string; metadata?: Record<string, unknown> }) =>
    req<Document>(`/v1/documents/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  /** Chunks, embeds, and lands as memories. Synchronous at MVP. */
  ingest: (id: string) =>
    req<{ ok: boolean; chunks: number }>(`/v1/documents/${encodeURIComponent(id)}/ingest`, { method: 'POST' }),
};

/* ============================================================
   Knowledge domains (= workspace tags)
   ============================================================ */

export const smartnoteTags = {
  /** GET /v1/tags returns a bare array. */
  list: () => req<Tag[]>('/v1/tags'),
  /** Create or update a domain (idempotent on name). */
  upsert: (body: Tag) =>
    req<Tag>('/v1/tags', { method: 'POST', body: JSON.stringify(body) }),
  remove: (name: string) =>
    req<{ ok: boolean; deleted: number }>(`/v1/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};

/* ============================================================
   Usage (quota)
   ============================================================ */

export async function smartnoteUsage() {
  return req<{ workspace_id: string; memories?: number; documents?: number; embed_tokens?: number; [k: string]: unknown }>(
    '/v1/usage',
  );
}
