/**
 * 获取后端 API 地址的工具函数
 * 根据当前访问的域名动态推断后端地址，支持局域网访问
 */

/**
 * 获取后端 API 地址
 * 优先级：
 * 1. localStorage 中保存的配置（chatee_backend_url）
 * 2. 环境变量 VITE_BACKEND_URL
 * 3. 根据当前访问的域名动态推断（同域名，端口 3002）
 * 4. 默认值 http://localhost:3002
 */
const DEFAULT_HTTP_BACKEND = 'http://localhost:3002';

export function getBackendUrl(): string {
  // 1. 优先使用 localStorage 中保存的配置
  if (typeof window !== 'undefined') {
    const savedUrl = localStorage.getItem('chatee_backend_url');
    if (savedUrl && savedUrl.trim() !== '') {
      return savedUrl.trim();
    }
  }

  // 2. 使用环境变量
  const envUrl = import.meta.env.VITE_BACKEND_URL;
  if (envUrl && envUrl.trim() !== '') {
    return envUrl.trim();
  }

  // 3. 在浏览器环境中，根据当前访问的域名动态推断
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    // Electron file:// 或 hostname 为空时无法推断，走默认本机 HTTP
    if (protocol === 'file:' || !hostname) {
      return DEFAULT_HTTP_BACKEND;
    }
    // 支持局域网访问：如果访问 http://192.168.x.x:5177，会自动使用 http://192.168.x.x:3002
    return `${protocol}//${hostname}:3002`;
  }

  // 4. 默认值
  return DEFAULT_HTTP_BACKEND;
}

