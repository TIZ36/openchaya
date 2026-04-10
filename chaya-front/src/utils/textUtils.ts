/**
 * 文本处理工具函数
 */

/**
 * 省略 base64 字符串，避免显示过长的内容
 * 将 base64 数据替换为可读的占位符，显示数据大小
 */
export const truncateBase64Strings = (text: string): string => {
  if (!text || typeof text !== 'string') return text;
  
  // 匹配 base64 数据（通常是长字符串，只包含 A-Za-z0-9+/= 字符）
  // 1. 匹配 data URI 格式: data:image/xxx;base64,XXXXXX
  // 2. 匹配 JSON 中的 base64 字段值: "data": "XXXXXX" 或 "base64": "XXXXXX"
  
  // 首先处理 data URI 格式
  let result = text.replace(
    /data:(image|video|audio)\/[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
    (match) => {
      const prefix = match.substring(0, match.indexOf(',') + 1);
      return `${prefix}[base64数据已省略，共${Math.round((match.length - prefix.length) / 1024)}KB]`;
    }
  );
  
  // 处理 JSON 中的 base64 字段（"data": "...", "base64": "...", "image": "...", "screenshot": "..."）
  result = result.replace(
    /"(data|base64|image|screenshot|imageData|img|picture|photo)"\s*:\s*"([A-Za-z0-9+/=]{200,})"/g,
    (match, key, value) => {
      const sizeKB = Math.round(value.length / 1024);
      return `"${key}": "[base64数据已省略，共${sizeKB}KB]"`;
    }
  );
  
  // 处理可能独立存在的长 base64 字符串（连续500+个base64字符）
  result = result.replace(
    /(?<!")([A-Za-z0-9+/=]{500,})(?!")/g,
    (match) => {
      // 检查是否真的是 base64（以常见的图片 base64 开头）
      if (match.startsWith('iVBORw') || // PNG
          match.startsWith('/9j/') ||   // JPEG  
          match.startsWith('R0lGOD') || // GIF
          match.startsWith('UklGR') ||  // WebP
          match.match(/^[A-Za-z0-9+/]{50,}={0,2}$/)) {
        return `[base64数据已省略，共${Math.round(match.length / 1024)}KB]`;
      }
      return match;
    }
  );
  
  return result;
};

/**
 * 安全地将内容转换为 JSON 字符串并省略 base64
 */
export const safeJsonStringify = (obj: any, indent: number = 2): string => {
  try {
    const jsonStr = JSON.stringify(obj, null, indent);
    return truncateBase64Strings(jsonStr);
  } catch {
    return String(obj);
  }
};

/**
 * 尝试美化 JSON 字符串，如果失败则返回原始字符串
 */
export const tryPrettyJson = (str: string): string => {
  try {
    const parsed = JSON.parse(str);
    return truncateBase64Strings(JSON.stringify(parsed, null, 2));
  } catch {
    return truncateBase64Strings(str);
  }
};



