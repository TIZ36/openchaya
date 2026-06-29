/**
 * data URL / base64 归一化工具
 *
 * 目标：兼容历史数据中“纯 base64（无 data: 前缀）”的图片/媒体，统一转换为可直接用于 <img src> 的 data URL。
 */

// 兼容 base64 与 base64url（- _），并允许末尾 padding
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function inferImageMimeFromBase64Payload(payload: string): string | null {
  const base64 = payload.startsWith('data:') ? payload.slice(payload.indexOf(',') + 1) : payload.trim();
  if (base64.startsWith('iVBORw')) return 'image/png';
  if (base64.startsWith('/9j/') || base64.startsWith('9j/')) return 'image/jpeg';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return null;
}

export function looksLikeBase64Payload(value: string, minLen: number = 50): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) return true;
  // 降低最小长度要求（二维码可能较小），但至少 50 字符
  const normalized = trimmed.replace(/\s+/g, '');
  if (normalized.length < minLen) return false;
  // 检查是否以常见的图片 base64 开头（即使数据被截断，开头也应该正确）
  if (normalized.startsWith('iVBORw') || // PNG
      normalized.startsWith('/9j/') ||   // JPEG
      normalized.startsWith('R0lGOD') ||  // GIF
      normalized.startsWith('UklGR')) {  // WebP
    return true;
  }
  return BASE64_RE.test(normalized);
}

/**
 * 将可能是“纯 base64”的字符串转换为 data URL。
 *
 * - 已经是 http(s)/data/blob/file 等 URL：原样返回
 * - 纯 base64（无 data: 前缀）：补齐 `data:${mime};base64,`
 * - 其他：原样返回
 */
export function ensureDataUrlFromMaybeBase64(value: string, fallbackMime: string = 'image/jpeg'): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return trimmed;

  // 已是可用 URL
  if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;

  // 纯 base64：补齐 data:
  // 这里先做一次去空白的归一化：后端/历史数据可能把 base64 分行存储
  const normalized = trimmed.replace(/\s+/g, '');
  if (!looksLikeBase64Payload(normalized)) return trimmed;

  const inferred = inferImageMimeFromBase64Payload(normalized);
  const mime = inferred || fallbackMime || 'application/octet-stream';
  return `data:${mime};base64,${normalized}`;
}

export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const s = String(dataUrl ?? '').trim();
  if (!s.startsWith('data:')) return null;
  const commaIdx = s.indexOf(',');
  if (commaIdx < 0) return null;

  const meta = s.slice(5, commaIdx); // remove "data:"
  const body = s.slice(commaIdx + 1);
  const mimeType = meta.split(';')[0] || 'application/octet-stream';
  return { mimeType, base64: body };
}

export function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const { mimeType, base64 } = parsed;
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return { blob: new Blob([byteArray], { type: mimeType }), mimeType };
}

/**
 * 将可能是 dataURL / base64url / 缺 padding 的内容，归一化为 Gemini inlineData 可接受的“标准 base64”。
 *
 * - 去除 data: 前缀（如果存在）
 * - 去除所有空白字符
 * - base64url -> base64（- -> +, _ -> /）
 * - 自动补齐 padding（=）到长度为 4 的倍数
 *
 * 返回 null 表示输入为空或明显不合法（避免把坏图塞进 inlineData 导致整个请求 400）。
 */
export function normalizeBase64ForInlineData(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const parsed = parseDataUrl(raw);
  let base64 = (parsed ? parsed.base64 : raw).replace(/\s+/g, '');
  if (!base64) return null;

  // base64url -> 标准 base64
  base64 = base64.replace(/-/g, '+').replace(/_/g, '/');

  // 自动补齐 padding（Google API 对缺 padding 的容错不稳定，统一补齐）
  const mod = base64.length % 4;
  if (mod === 1) {
    // 这种长度不可能是合法 base64
    return null;
  }
  if (mod === 2) base64 += '==';
  if (mod === 3) base64 += '=';

  // 轻量校验：只允许 base64 字符集 + padding
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  return base64;
}


