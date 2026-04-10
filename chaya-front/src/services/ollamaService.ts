/**
 * Ollama 服务模块
 * 用于与 Ollama 服务器交互，获取模型列表等
 */

export interface OllamaModel {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * 获取 Ollama 服务器上的可用模型列表（通过后端代理）
 * @param serverUrl Ollama 服务器地址（如 http://10.104.4.16:11434）
 * @returns 模型名称数组
 * @throws 如果服务器不可访问或请求失败
 */
export async function fetchOllamaModels(serverUrl: string): Promise<string[]> {
  if (!serverUrl) {
    throw new Error('Ollama 服务器地址不能为空');
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
    
    // 规范化 URL：移除尾部斜杠
    const normalizedUrl = serverUrl.trim().replace(/\/+$/, '');
    
    // 构建查询参数
    const params = new URLSearchParams({
      api_url: normalizedUrl,
      provider: 'ollama',
    });
    
    const fullUrl = `${proxyUrl}?${params.toString()}`;
    
    console.log(`[Ollama] 正在通过后端代理获取模型列表: ${normalizedUrl}`);
    
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
      
      if (response.status === 404) {
        throw new Error(`无法连接到 Ollama 服务器: ${normalizedUrl}。请检查服务器地址是否正确。`);
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    // 后端返回格式：{ models: [...], total: ... }
    if (data.models && Array.isArray(data.models)) {
      console.log(`[Ollama] 成功获取 ${data.models.length} 个模型:`, data.models);
      return data.models;
    }

    throw new Error('服务器返回的数据格式不正确');
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时：无法在15秒内连接到 Ollama 服务器。请检查服务器地址和网络连接。');
    }
    
    if (error.message) {
      throw error;
    }
    
    throw new Error(`获取模型列表失败: ${error.message || String(error)}`);
  }
}

