/**
 * Integrations API — MCP servers + Skills.
 * Mirrors the backend's /api/mcp/servers and /api/skills endpoints
 * plus per-agent bind/unbind endpoints.
 */

import { api } from '../utils/apiClient';

/* ---------- MCP servers ---------- */

export type MCPTransport = 'http' | 'sse' | 'stdio';

export interface MCPServer {
  id: string;
  tenant_id?: string;
  name: string;
  url: string;
  type: MCPTransport | string;
  config?: Record<string, unknown>;
  enabled: boolean;
  healthy: boolean;
  created_at?: string;
}

export interface MCPServerCreate {
  name: string;
  url: string;
  type?: MCPTransport;
  enabled?: boolean;
  // Free-form fields land in config jsonb on the server side.
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export const mcpApi = {
  list: () => api.get<MCPServer[]>('/api/mcp/servers'),
  create: (body: MCPServerCreate) => api.post<MCPServer>('/api/mcp/servers', body),
  update: (id: string, body: Partial<MCPServerCreate> & { enabled?: boolean }) =>
    api.put<MCPServer>(`/api/mcp/servers/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api.del(`/api/mcp/servers/${encodeURIComponent(id)}`),

  probe: (id: string) =>
    api.post<{ ok: boolean; tool_count: number; tools?: string[]; error?: string }>(
      `/api/mcp/servers/${encodeURIComponent(id)}/probe`
    ),

  // Agent-scoped bindings
  listForAgent: (agentId: string) =>
    api.get<MCPServer[]>(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`),
  bindToAgent: (agentId: string, mcpServerId: string) =>
    api.post(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`, { mcp_server_id: mcpServerId }),
  unbindFromAgent: (agentId: string, mcpServerId: string) =>
    api.del(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(mcpServerId)}`),
};

/* ---------- MCP OAuth ---------- */

export interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  resource?: string;
  client_id?: string;
  client_secret?: string;
  client_name?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  // Some servers don't require OAuth at all — discover returns empty/none.
  required?: boolean;
}

/**
 * Backend's discover endpoint returns the raw RFC 9728 + RFC 8414 docs:
 *   { protected_resource: {...}, authorization_server: {...}, resource: string }
 * The downstream /authorize endpoint expects flat fields, so we flatten here
 * and let callers stay simple. Pulls authorization_endpoint, token_endpoint,
 * registration_endpoint, resource, client_id (if pre-registered) and the
 * supported-methods arrays.
 */
function flattenDiscovery(raw: any): OAuthMetadata {
  if (!raw || typeof raw !== 'object') return {};
  const as = raw.authorization_server || {};
  const pr = raw.protected_resource || {};
  return {
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint,
    resource: raw.resource || pr.resource,
    client_id: as.client_id,
    client_secret: as.client_secret,
    client_name: as.client_name,
    code_challenge_methods_supported: as.code_challenge_methods_supported,
    token_endpoint_auth_methods_supported: as.token_endpoint_auth_methods_supported,
  };
}

export const oauthApi = {
  /** Probe an MCP URL for OAuth requirements + endpoints. */
  discover: async (mcpUrl: string): Promise<OAuthMetadata> => {
    const raw = await api.post<any>('/api/mcp/oauth/discover', { mcp_url: mcpUrl });
    return flattenDiscovery(raw);
  },

  /** Build the authorization URL (PKCE + state stashed in backend Redis). */
  authorize: (body: OAuthMetadata & { mcp_url: string }) =>
    api.post<{ authorization_url: string; client_id: string; state: string }>(
      '/api/mcp/oauth/authorize', body
    ),

  /**
   * Did the user complete the dance? Poll until has_token=true.
   * `expired` distinguishes "授权过但 token 失效了 → 重新授权" from "从未授权".
   */
  tokenStatus: (mcpUrl: string) =>
    api.get<{ has_token: boolean; expired?: boolean; mcp_url: string }>(
      `/api/mcp/oauth/token-status?mcp_url=${encodeURIComponent(mcpUrl)}`
    ),
};

/* ---------- Skills ---------- */

export interface Skill {
  id: string;
  tenant_id?: string;
  name: string;
  description?: string;
  // jsonb arrays — backend tolerates string[], object[], or anything serialisable
  keywords?: string[];
  steps?: Array<Record<string, unknown> | string>;
  required_mcp?: string[];
  created_at?: string;
}

export interface SkillCreate {
  name: string;
  description?: string;
  keywords?: string[];
  steps?: Array<Record<string, unknown> | string>;
  required_mcp?: string[];
}

export const skillsApi = {
  list: () => api.get<Skill[]>('/api/skills'),
  create: (body: SkillCreate) => api.post<Skill>('/api/skills', body),
  get: (id: string) => api.get<Skill>(`/api/skills/${encodeURIComponent(id)}`),
  update: (id: string, body: Partial<SkillCreate>) =>
    api.put<Skill>(`/api/skills/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api.del(`/api/skills/${encodeURIComponent(id)}`),

  // Agent-scoped bindings
  listForAgent: (agentId: string) =>
    api.get<Skill[]>(`/api/agents/${encodeURIComponent(agentId)}/skills`),
  attachToAgent: (agentId: string, skillId: string) =>
    api.post(`/api/agents/${encodeURIComponent(agentId)}/skills`, { skill_id: skillId }),
  detachFromAgent: (agentId: string, skillId: string) =>
    api.del(`/api/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`),
};
