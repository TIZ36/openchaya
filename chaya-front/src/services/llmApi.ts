/**
 * LLM配置API服务
 * 调用后端API管理LLM配置
 */

import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';

const API_BASE_URL = `${getBackendUrl()}/api/llm`;

// Delegates to central apiClient for auth + 401 handling.
const authFetch: typeof fetch = (input, init) => api.fetchRaw(input, init);

// ============================================================================
// Provider (供应商) 相关类型和API
// ============================================================================

export interface LLMProvider {
  provider_id: string;
  supplier?: string;
  name: string;
  provider_type: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  is_system: boolean;
  override_url: boolean;
  default_api_url?: string;
  logo_light?: string;
  logo_dark?: string;
  logo_theme?: 'auto' | 'light' | 'dark';
  metadata?: Record<string, any>;
  /** 列表显示顺序（越小越靠前；Chaya 选模型 Tab 与此一致） */
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProviderRequest {
  name: string;
  supplier?: string;
  provider_type: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  override_url?: boolean;
  default_api_url?: string;
  logo_theme?: 'auto' | 'light' | 'dark';
  metadata?: Record<string, any>;
}

export interface UpdateProviderRequest {
  name?: string;
  supplier?: string;
  provider_type?: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  override_url?: boolean;
  default_api_url?: string;
  logo_light?: string;
  logo_dark?: string;
  logo_theme?: 'auto' | 'light' | 'dark';
  metadata?: Record<string, any>;
}

export interface DownloadLogoResponse {
  logo_light: string;
  logo_dark: string;
  theme: string;
  format: string;
}

export interface LLMConfigFromDB {
  config_id: string;
  name: string;
  shortname?: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  supplier?: string;  // Token/计费归属供应商（如 nvidia, openai）
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled: boolean;
  is_default?: boolean;
  description?: string;
  metadata?: Record<string, any>;
  max_tokens?: number; // 模型的最大 token 限制（从后端获取）
  /** 在媒体创作台可选中（模型录入中手动开启） */
  media_visible?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateLLMConfigRequest {
  config_id?: string;
  name: string;
  shortname?: string;
  provider: 'openai' | 'deepseek' | 'anthropic' | 'local' | 'custom' | 'ollama' | 'gemini';
  supplier?: string;  // Token/计费归属供应商（如 nvidia, openai）
  api_key?: string;
  api_url?: string;
  model?: string;
  tags?: string[];
  enabled?: boolean;
  description?: string;
  metadata?: Record<string, any>;
  /** 是否在媒体创作台展示（需具备图像/视频能力才会出现在对应 Tab） */
  media_visible?: boolean;
}

/**
 * 获取所有LLM配置
 */
/** Fetch the provider's available model list using a given API key.
 *  Used when a user adds a provider and wants to auto-discover models. */
export interface AvailableModel {
  id: string;
  name: string;
}
export async function listAvailableModels(
  provider: string,
  apiKey: string,
  apiUrl?: string,
): Promise<AvailableModel[]> {
  const qs = new URLSearchParams({ provider, api_key: apiKey });
  if (apiUrl) qs.set('api_url', apiUrl);
  const resp = await authFetch(`${API_BASE_URL}/models?${qs.toString()}`);
  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (raw?.error) || `fetch models failed: ${resp.statusText}`;
    throw new Error(msg);
  }
  const data = (raw && raw.code === 0 && raw.data) ? raw.data : raw;
  const list: any[] = Array.isArray(data?.models) ? data.models : [];
  return list.map((m) => ({ id: String(m.id || m.name || ''), name: String(m.name || m.id || '') }))
    .filter((m) => m.id);
}

export async function getLLMConfigs(): Promise<LLMConfigFromDB[]> {
  const list = await api.get<any[]>('/api/llm/configs');
  // Map backend 'id' → frontend 'config_id'
  return (list || []).map(c => ({ ...c, config_id: c.config_id || c.id }));
}

/**
 * 获取单个LLM配置
 */
export async function getLLMConfig(configId: string): Promise<LLMConfigFromDB> {
  const c = await api.get<any>(`/api/llm/configs/${configId}`);
  return { ...c, config_id: c.config_id || c.id };
}

/**
 * 创建LLM配置
 */
export async function createLLMConfig(config: CreateLLMConfigRequest): Promise<{ config_id: string; message: string }> {
  const c = await api.post<any>('/api/llm/configs', config);
  return { config_id: c.config_id || c.id, message: 'created' };
}

/**
 * 更新LLM配置
 */
export async function updateLLMConfig(configId: string, updates: Partial<CreateLLMConfigRequest>): Promise<{ message: string }> {
  const response = await authFetch(`${API_BASE_URL}/configs/${configId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(`Failed to update LLM config: ${error.error?.message || response.statusText}`);
  }
  return response.json();
}

/**
 * 删除LLM配置
 */
export async function deleteLLMConfig(configId: string): Promise<{ message: string }> {
  const response = await authFetch(`${API_BASE_URL}/configs/${configId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(`Failed to delete LLM config: ${error.error?.message || response.statusText}`);
  }
  return response.json();
}

/**
 * 获取LLM配置的API密钥（用于调用）
 * 配置已删除时（404）返回空字符串，不抛错，避免删除 Token 后前端大量报错
 */
export async function getLLMConfigApiKey(configId: string): Promise<string> {
  try {
    const result = await api.get<{ api_key: string }>(`/api/llm/configs/${configId}/api-key`);
    return result?.api_key || '';
  } catch {
    return '';
  }
}

// ==================== LLM配置导入导出 ====================


/**
 * 导出单个LLM配置
 */

/**
 * 导出所有LLM配置
 */

/**
 * 导入LLM配置

/**
 * 从JSON文件导入LLM配置
 */

// ============================================================================
// Provider API
// ============================================================================

/**
 * 系统支持的供应商信息
 */
export interface SupportedProvider {
  provider_type: 'openai' | 'deepseek' | 'anthropic' | 'gemini' | 'ollama';
  name: string;
  description: string;
  default_api_url: string;
  requires_api_key: boolean;
  icon: string;
  color: string;
}

/**
 * 获取系统支持的供应商列表
 */
export async function getSupportedProviders(): Promise<SupportedProvider[]> {
  return api.get('/api/llm/providers/supported');
}

/**
 * 获取所有供应商
 */
export async function getProviders(): Promise<LLMProvider[]> {
  return api.get('/api/llm/providers');
}

/**
 * 获取单个供应商
 */
export async function getProvider(providerId: string): Promise<LLMProvider> {
  const response = await authFetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch provider: ${response.statusText}`);
  }
  return response.json();
}

/**
 * 创建供应商
 */
export async function createProvider(provider: CreateProviderRequest): Promise<{ provider_id: string; message: string }> {
  const response = await authFetch(`${API_BASE_URL}/providers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(provider),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Failed to create provider: ${error.error || response.statusText}`);
  }
  return response.json();
}

/**
 * 更新供应商
 */
export async function updateProvider(providerId: string, updates: UpdateProviderRequest): Promise<{ message: string }> {
  const response = await authFetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Failed to update provider: ${error.error || response.statusText}`);
  }
  return response.json();
}

/**
 * 删除供应商
 */
export async function deleteProvider(providerId: string): Promise<{ message: string }> {
  const response = await authFetch(`${API_BASE_URL}/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`Failed to delete provider: ${error.error || response.statusText}`);
  }
  return response.json();
}

/**
 * 保存供应商列表顺序（左侧拖拽后调用）
 */
export async function reorderProviders(providerIds: string[]): Promise<{ message: string; updated: number }> {
  const response = await authFetch(`${API_BASE_URL}/providers/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider_ids: providerIds }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to reorder providers: ${response.statusText}`);
  }
  return response.json();
}

/**
 * 按供应商 sort_order 排列模型配置（用于 Chaya 等场景）
 */

/**
 * 从 LobeHub CDN 下载供应商 Logo
 */

/**
 * Logo 选项
 */
export interface LogoOption {
  type: string;
  url: string;
  preview: string;
}

/**
 * Logo 选项响应
 */
export interface LogoOptionsResponse {
  light_options: LogoOption[];
  dark_options: LogoOption[];
  slug: string;
}

/**
 * 获取供应商的 Logo 选项（浅色和深色两组）
 */
export async function getProviderLogoOptions(provider: string): Promise<LogoOptionsResponse> {
  const response = await authFetch(`${API_BASE_URL}/providers/logo-options?provider=${encodeURIComponent(provider)}`);
  if (!response.ok) {
    let errorData: any = { error: 'Unknown error' };
    try {
      errorData = await response.json();
    } catch {
      // 如果JSON解析失败，使用默认错误
    }
    // 创建一个包含更多信息的错误对象
    const errorObj: any = new Error(errorData.error || response.statusText);
    errorObj.response = response;
    errorObj.errorData = errorData;
    throw errorObj;
  }
  const data = await response.json();
  return {
    light_options: data.light_options || [],
    dark_options: data.dark_options || [],
    slug: data.slug || ''
  };
}

