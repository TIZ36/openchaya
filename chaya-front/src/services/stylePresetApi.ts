/**
 * 风格预设 API 服务
 * 
 * 提供获取本地、Civitai、Lexica 等多源风格预设
 */

export interface StylePreset {
  id: string;
  label: string;
  text: string;
  source: 'local' | 'civitai' | 'lexica';
  color?: 'accent' | 'secondary' | 'highlight';
  tags?: string[];
  preview_url?: string;
  metadata?: Record<string, any>;
}

export interface StylePresetsResponse {
  presets: StylePreset[];
  total: number;
  page: number;
  has_more: boolean;
  source: string;
}

export async function fetchStylePresets(options?: {
  source?: 'all' | 'local' | 'civitai' | 'lexica';
  query?: string;
  limit?: number;
  page?: number;
}): Promise<StylePresetsResponse> {
  const params = new URLSearchParams({
    source: options?.source || 'all',
    query: options?.query || '',
    limit: String(options?.limit || 20),
    page: String(options?.page || 1),
  });

  const { getBackendUrl } = await import('../utils/backendUrl');
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(`${getBackendUrl()}/api/media/style-presets?${params}`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch style presets: ${response.status}`);
  }

  return response.json();
}

export async function searchStylePresets(query: string, source: string = 'all'): Promise<StylePreset[]> {
  const response = await fetchStylePresets({
    source: source as any,
    query,
    limit: 30,
  });
  return response.presets;
}
