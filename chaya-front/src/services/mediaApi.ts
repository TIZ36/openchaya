/**
 * 媒体生成 API：按供应商区分的图像/视频接口
 * 使用与主站一致的 JWT + `{ code, data }` 解包。
 */

import { getBackendUrl } from '../utils/backendUrl';
import { api } from '../utils/apiClient';

const BASE = () => `${getBackendUrl()}/api/media`;

async function req<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  const res = await api.fetchRaw(`${BASE()}${endpoint}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === 'object' && 'code' in body) {
    const c = body as { code: number; data?: T; error?: string };
    if (c.code !== 0) throw new Error(c.error || `API error ${c.code}`);
    return c.data as T;
  }
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

/** 模型能力标记 */
export interface ModelCapabilities {
  image: boolean;
  video: boolean;
}

export interface MediaProviderConfig {
  config_id: string;
  name: string;
  model: string;
  provider: string;
  /** 该配置对应模型的媒体能力 */
  capabilities?: ModelCapabilities;
  /** 是否为媒体创作专用录入 */
  media_purpose?: boolean;
  /** 是否在模型录入中标记为媒体创作台可见 */
  media_visible?: boolean;
}

export interface MediaProvider {
  id: string;
  name: string;
  image: { generate?: boolean; edit?: boolean; variations?: boolean };
  video: { submit?: boolean; status?: boolean };
  configs: MediaProviderConfig[];
}

/** 系统支持的模型能力注册条目 */
export interface ModelRegistryEntry {
  label: string;
  image: boolean;
  video: boolean;
  recommended: boolean;
  note: string;
}

/** 媒体创作产出（持久化） */
export interface MediaOutputItem {
  output_id: string;
  media_type: 'image' | 'video';
  file_path: string;
  mime_type?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  source?: string;
  file_size?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface GoogleDriveItem {
  id: string;
  name?: string;
  mime_type?: string;
  created_at?: string;
  size?: string;
  web_view_link?: string;
  thumbnail_link?: string;
  preview_url?: string;
  thumb_url?: string;
}

export interface ImagePromptPackItem {
  id: string;
  title: string;
  pinned?: boolean;
  createdAt: number;
  prompt: string;
  refImages?: Array<{
    url: string;
    mimeType?: string;
    source?: string;
  }>;
  refDirectives?: string[];
  imageSize?: {
    width: number;
    height: number;
    aspectRatio: string;
    count: number;
  };
}

export const mediaApi = {
  getProviders: () =>
    req<{ providers: MediaProvider[]; model_registry?: ModelRegistryEntry[] }>('/providers'),

  // ─── Gemini 图像 ───

  geminiImageGenerate: (body: {
    prompt: string;
    config_id?: string;
    model?: string;
    aspect_ratio?: string;
    count?: number;
  }) =>
    req<{ media?: unknown[]; content?: string; error?: string }>('/gemini/image/generate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Expand a short user idea into a nano-banana-friendly paragraph via
   *  gemini-2.5-flash. The caller should race this against a short timeout
   *  and fall back to the original prompt if it rejects or drifts. */
  geminiRewritePrompt: (body: {
    prompt: string;
    aspect_ratio?: string;
    config_id?: string;
    model?: string;
  }) =>
    req<{ prompt?: string; error?: string }>('/gemini/rewrite-prompt', {
      method: 'POST',
      body: JSON.stringify(body),
    }),


  geminiImageEdit: (body: {
    prompt: string;
    image_b64?: string;
    images_b64?: string[];
    thought_signature?: string;
    config_id?: string;
    model?: string;
    aspect_ratio?: string;
    count?: number;
  }) =>
    req<{ media?: unknown[]; content?: string; error?: string }>('/gemini/image/edit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ─── Gemini 视频 (Veo) ───

  geminiVideoSubmit: (body: {
    prompt?: string;
    image_b64?: string;
    config_id?: string;
    model?: string;
  }) =>
    req<{ task_name?: string; model?: string; error?: string }>('/gemini/video/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  geminiVideoStatus: (taskName: string, configId?: string) => {
    const qs = configId ? `?config_id=${encodeURIComponent(configId)}` : '';
    return req<{ status?: string; output?: string; progress?: number; error?: string }>(
      `/gemini/video/status/${taskName}${qs}`,
    );
  },

  /**
   * 代理下载 Gemini Veo 视频（视频 URI 需要 API Key，前端无法直接访问）。
   * 返回 Blob URL 供 <video> 标签使用。
   */
  geminiVideoDownload: async (videoUri: string, configId?: string): Promise<string> => {
    const res = await api.fetchRaw(`${BASE()}/gemini/video/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_uri: videoUri, config_id: configId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error || `视频下载失败 (HTTP ${res.status})`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },

  /** 查询 Gemini 模型能力注册表 */
  geminiModelCapabilities: () =>
    req<{ models: ModelRegistryEntry[] }>('/gemini/model-capabilities'),

  // ─── OpenAI 图像 ───

  openaiImageGenerations: (body: {
    prompt: string;
    config_id?: string;
    model?: string;
    size?: string;
    response_format?: string;
  }) =>
    req<{ media?: unknown[]; error?: string }>('/openai/image/generations', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  openaiImageEdits: (body: {
    prompt: string;
    image_b64?: string;
    image_mime?: string;
    config_id?: string;
    model?: string;
  }) =>
    req<{ media?: unknown[]; error?: string }>('/openai/image/edits', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ─── Runway 视频 ───

  runwayVideoSubmit: (body: {
    prompt_text?: string;
    prompt_image?: string;
    model?: string;
    ratio?: string;
    duration?: number;
  }) =>
    req<{ task_id?: string; error?: string }>('/runway/video/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  runwayVideoStatus: (taskId: string) =>
    req<{ status?: string; output?: string; error?: string }>(`/runway/video/status/${taskId}`),

  // ─── 媒体创作产出持久化 ───

  /** 保存产出（图片/视频 base64 或 data URI） */
  saveOutput: (body: {
    data: string;
    media_type: 'image' | 'video';
    mime_type?: string;
    prompt?: string;
    model?: string;
    provider?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }) =>
    req<MediaOutputItem & { error?: string }>('/outputs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** 产出列表 */
  listOutputs: (limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (offset != null) params.set('offset', String(offset));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return req<{ items: MediaOutputItem[] }>(`/outputs${qs}`);
  },

  listPromptPacks: () => req<{ packs: ImagePromptPackItem[] }>('/packs'),

  replacePromptPacks: (packs: ImagePromptPackItem[]) =>
    req<{ saved: number }>('/packs', {
      method: 'PUT',
      body: JSON.stringify({ packs }),
    }),

  /** 删除产出 */
  deleteOutput: (outputId: string) =>
    req<{ deleted?: boolean; error?: string }>(`/outputs/${encodeURIComponent(outputId)}`, {
      method: 'DELETE',
    }),

  /** 产出文件访问 URL（用于预览/下载） */
  getOutputFileUrl: (outputId: string) =>
    `${BASE()}/outputs/${encodeURIComponent(outputId)}/file`,

  // ─── Google Drive 联动 ───

  googleDriveAuthStart: () =>
    req<{ auth_url: string; state: string; error?: string }>('/google-drive/auth/start', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  googleDriveAuthStatus: () =>
    req<{ connected: boolean }>('/google-drive/auth/status'),

  uploadOutputToGoogleDrive: (outputId: string, body?: { folder_id?: string }) =>
    req<{ ok?: boolean; drive_file_id?: string; name?: string; web_view_link?: string; error?: string }>(
      `/outputs/${encodeURIComponent(outputId)}/upload-drive`,
      {
        method: 'POST',
        body: JSON.stringify(body || {}),
      },
    ),

  listGoogleDriveFiles: (pageSize = 40, pageToken?: string) => {
    const params = new URLSearchParams();
    params.set('page_size', String(pageSize));
    if (pageToken) params.set('page_token', pageToken);
    return req<{ items: GoogleDriveItem[]; next_page_token?: string; folder_id?: string; folder_name?: string }>(
      `/google-drive/files?${params.toString()}`,
    );
  },

  getGoogleDriveFilePreviewUrl: (fileId: string) =>
    `${BASE()}/google-drive/files/${encodeURIComponent(fileId)}/content`,

  getGoogleDriveFileThumbUrl: (fileId: string) =>
    `${BASE()}/google-drive/files/${encodeURIComponent(fileId)}/thumb`,
};
