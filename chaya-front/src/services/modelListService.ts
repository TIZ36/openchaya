/**
 * 模型列表加载服务
 * 支持从各种 LLM Provider 的 API 端点自动加载模型列表
 */

export interface ModelInfo {
  id: string;
  name?: string;
  created?: number;
  owned_by?: string;
}

export interface ModelCapabilities {
  vision?: boolean;      // 是否识别图片
  image_gen?: boolean;   // 是否支持生图
  video_gen?: boolean;   // 是否支持生视频
  speech_gen?: boolean;  // 是否支持生语音
  thinking?: boolean;    // 是否为思考模型
}

export interface ModelWithCapabilities {
  id: string;
  capabilities: ModelCapabilities;
  /** 是否支持对话（generateContent），如 Gemini 的 Imagen 等仅生图模型为 false */
  isCallable?: boolean;
}

/**
 * 从 OpenAI 兼容的 API 加载模型列表（通过后端代理）
 * 支持端点：/v1/models
 */
export async function fetchOpenAICompatibleModels(
  baseUrl: string,
  apiKey?: string,
  provider?: string,
  includeCapabilities: boolean = false
): Promise<string[] | ModelWithCapabilities[]> {
  if (!baseUrl) {
    throw new Error('API URL 不能为空');
  }

  try {
    // 使用后端代理，避免 CORS 问题
    const { getBackendUrl } = await import('../utils/backendUrl');

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};
    const backendUrl = getBackendUrl();
    const proxyUrl = `${backendUrl}/api/llm/models`;
    
    // 构建查询参数
    const params = new URLSearchParams({
      api_url: baseUrl,
    });
    
    if (apiKey) {
      params.append('api_key', apiKey);
    }
    
    // 传递 provider 参数，确保后端使用正确的 API 端点
    // 如果 provider 是 'openai'，但 baseUrl 不是 OpenAI 的默认 URL，则传递 'custom'
    if (provider) {
      // 如果 provider 是 'openai' 但 URL 不是 OpenAI 默认 URL，则使用 'custom' 或 'openai'
      // 这样后端会使用传入的 api_url 而不是默认的 OpenAI URL
      if (provider === 'openai' && !baseUrl.includes('api.openai.com')) {
        // 对于自定义的 OpenAI 兼容 API（如 NVIDIA），仍然传递 'openai'，让后端使用传入的 URL
        params.append('provider', 'openai');
      } else {
        params.append('provider', provider);
      }
    }
    
    // 如果需要能力信息
    if (includeCapabilities) {
      params.append('include_capabilities', 'true');
    }
    
    const fullUrl = `${proxyUrl}?${params.toString()}`;
    
    console.log(`[ModelList] 正在通过后端代理获取模型列表: ${baseUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15秒超时（包含后端处理时间）

    const response = await authFetch(fullUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      const errorMessage = errorData.error || `获取模型列表失败: ${response.status} ${response.statusText}`;
      
      if (response.status === 401) {
        throw new Error('API Key 无效或未授权');
      }
      if (response.status === 404) {
        throw new Error(`无法找到模型列表端点。请检查 URL 是否正确。`);
      }
      throw new Error(errorMessage);
    }

    const raw = await response.json();
    // Unwrap {code, data} envelope
    const data = (raw && raw.code === 0 && raw.data) ? raw.data : raw;

    // 后端返回格式：{ models: [...], total: ... }，后端使用 snake_case is_callable
    if (data.models && Array.isArray(data.models)) {
      console.log(`[ModelList] 成功获取 ${data.models.length} 个模型:`, data.models);
      if (includeCapabilities && data.models.length > 0 && typeof data.models[0] === 'object' && 'id' in data.models[0]) {
        const list = (data.models as any[]).map((m: any) => ({
          ...m,
          isCallable: m.isCallable ?? m.is_callable ?? true,
        })) as ModelWithCapabilities[];
        return list;
      }
      return data.models as string[];
    }

    throw new Error('服务器返回的数据格式不正确');
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时：无法在15秒内连接到服务器。请检查 URL 和网络连接。');
    }
    if (error.message) {
      throw error;
    }
    throw new Error(`获取模型列表失败: ${error.message || String(error)}`);
  }
}

/**
 * 从 Anthropic API 加载模型列表（通过后端代理）
 */
export async function fetchAnthropicModels(
  baseUrl: string,
  apiKey?: string,
  includeCapabilities: boolean = false
): Promise<string[] | ModelWithCapabilities[]> {
  if (!baseUrl || !apiKey) {
    return [];
  }

  try {
    const { getBackendUrl } = await import('../utils/backendUrl');

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};
    const backendUrl = getBackendUrl();
    const proxyUrl = `${backendUrl}/api/llm/models`;
    
    const params = new URLSearchParams({
      api_url: baseUrl,
      api_key: apiKey,
      provider: 'anthropic',
    });
    
    if (includeCapabilities) {
      params.append('include_capabilities', 'true');
    }
    
    const fullUrl = `${proxyUrl}?${params.toString()}`;
    
    console.log(`[ModelList] 正在通过后端代理获取 Anthropic 模型列表: ${baseUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await authFetch(fullUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      const errorMessage = errorData.error || `获取模型列表失败: ${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const _raw = await response.json(); const data = (_raw && _raw.code === 0 && _raw.data) ? _raw.data : _raw;
    
    if (data.models && Array.isArray(data.models)) {
      console.log(`[ModelList] 成功获取 ${data.models.length} 个 Anthropic 模型:`, data.models);
      if (includeCapabilities && data.models.length > 0 && typeof data.models[0] === 'object' && 'id' in data.models[0]) {
        return (data.models as any[]).map((m: any) => ({
          ...m,
          isCallable: m.isCallable ?? m.is_callable ?? true,
        })) as ModelWithCapabilities[];
      }
      return data.models as string[];
    }

    throw new Error('服务器返回的数据格式不正确');
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时：无法在15秒内连接到服务器。请检查 URL 和网络连接。');
    }
    if (error.message) {
      throw error;
    }
    throw new Error(`获取模型列表失败: ${error.message || String(error)}`);
  }
}

/**
 * 从 Gemini API 加载模型列表（通过后端代理）
 */
export async function fetchGeminiModels(
  baseUrl: string,
  apiKey?: string,
  includeCapabilities: boolean = false
): Promise<string[] | ModelWithCapabilities[]> {
  if (!baseUrl || !apiKey) {
    return [];
  }

  try {
    const { getBackendUrl } = await import('../utils/backendUrl');

const authFetch: typeof fetch = (input, init) => {
  const token = localStorage.getItem('chaya_token');
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(input, { ...init, headers });
};
    const backendUrl = getBackendUrl();
    const proxyUrl = `${backendUrl}/api/llm/models`;
    
    const params = new URLSearchParams({
      api_url: baseUrl,
      api_key: apiKey,
      provider: 'gemini',
    });
    
    if (includeCapabilities) {
      params.append('include_capabilities', 'true');
    }
    
    const fullUrl = `${proxyUrl}?${params.toString()}`;
    
    console.log(`[ModelList] 正在通过后端代理获取 Gemini 模型列表: ${baseUrl}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await authFetch(fullUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: response.statusText }));
      const errorMessage = errorData.error || `获取模型列表失败: ${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }

    const _raw = await response.json(); const data = (_raw && _raw.code === 0 && _raw.data) ? _raw.data : _raw;
    
    if (data.models && Array.isArray(data.models)) {
      console.log(`[ModelList] 成功获取 ${data.models.length} 个 Gemini 模型:`, data.models);
      if (includeCapabilities && data.models.length > 0 && typeof data.models[0] === 'object' && 'id' in data.models[0]) {
        return (data.models as any[]).map((m: any) => ({
          ...m,
          isCallable: m.isCallable ?? m.is_callable ?? true,
        })) as ModelWithCapabilities[];
      }
      return data.models as string[];
    }

    throw new Error('服务器返回的数据格式不正确');
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时：无法在15秒内连接到服务器。请检查 URL 和网络连接。');
    }
    if (error.message) {
      throw error;
    }
    throw new Error(`获取模型列表失败: ${error.message || String(error)}`);
  }
}

/**
 * 根据 Provider 类型加载模型列表
 */
export async function fetchModelsForProvider(
  provider: string,
  apiUrl?: string,
  apiKey?: string,
  includeCapabilities: boolean = false
): Promise<string[] | ModelWithCapabilities[]> {
  if (!apiUrl) {
    return [];
  }

  switch (provider.toLowerCase()) {
    case 'openai':
    case 'deepseek':
    case 'custom':
      // OpenAI 兼容的 API（包括 NVIDIA）
      // 传递 provider 参数，确保后端使用正确的 API 端点
      return fetchOpenAICompatibleModels(apiUrl, apiKey, provider, includeCapabilities);
    
    case 'anthropic':
    case 'claude':
      // Anthropic 不提供模型列表 API
      return fetchAnthropicModels(apiUrl, apiKey, includeCapabilities);
    
    case 'gemini':
    case 'google':
      // Gemini 模型列表
      return fetchGeminiModels(apiUrl, apiKey, includeCapabilities);
    
    case 'ollama':
    case 'local':
      // Ollama 使用单独的服务
      // 这里不处理，由 ollamaService 处理
      return [];
    
    default:
      // 默认尝试 OpenAI 兼容格式
      try {
        return await fetchOpenAICompatibleModels(apiUrl, apiKey, provider, includeCapabilities);
      } catch {
        return [];
      }
  }
}
