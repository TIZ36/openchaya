/**
 * Token 计数工具（前端版本）
 */

/**
 * 估算文本的 Token 数量
 */
export function estimate_tokens(text: string, model: string = 'gpt-4'): number {
  if (!text) {
    return 0;
  }
  
  // 统计中文字符数
  const chinese_chars = Array.from(text).filter(char => 
    char >= '\u4e00' && char <= '\u9fff'
  ).length;
  
  // 统计其他字符数
  const other_chars = text.length - chinese_chars;
  
  // 估算：中文按 1.5 字符/token，其他按 4 字符/token
  const estimated_tokens = Math.floor(chinese_chars / 1.5 + other_chars / 4);
  
  return Math.max(1, estimated_tokens);
}

/**
 * 估算消息列表的总 Token 数量
 */
export function estimate_messages_tokens(messages: Array<{ content?: string; thinking?: string; tool_calls?: any[] }>, model: string = 'gpt-4'): number {
  let total_tokens = 0;
  const message_overhead = 4; // 每个消息的开销
  
  for (const msg of messages) {
    const content = msg.content || '';
    const thinking = msg.thinking || '';
    
    total_tokens += estimate_tokens(content, model);
    if (thinking) {
      total_tokens += estimate_tokens(thinking, model);
    }
    total_tokens += message_overhead;
    
    if (msg.tool_calls) {
      total_tokens += msg.tool_calls.length * 50;
    }
  }
  
  return total_tokens;
}

/**
 * 获取模型的最大 Token 限制
 */
export function get_model_max_tokens(model: string): number {
  const model_limits: Record<string, number> = {
    'gpt-4': 8192,
    'gpt-4-turbo': 128000,
    'gpt-4-turbo-preview': 128000,
    'gpt-4-32k': 32768,
    'gpt-3.5-turbo': 16385,
    'gpt-3.5-turbo-16k': 16385,
    'o1-preview': 200000,
    'o1-mini': 128000,
    'claude-3-5-sonnet-20241022': 200000,
    'claude-3-opus-20240229': 200000,
    'claude-3-sonnet-20240229': 200000,
    'claude-3-haiku-20240307': 200000,
    // Google Gemini
    'gemini-2.5-flash': 1048576,  // 1M tokens
    'gemini-2.5-pro': 1048576,  // 1M tokens
    'gemini-2.0-flash': 1048576,  // 1M tokens
    'gemini-2.0-flash-exp': 1048576,  // 1M tokens
    'gemini-1.5-pro': 2097152,  // 2M tokens
    'gemini-1.5-flash': 1048576,  // 1M tokens
    'gemini-3-pro': 1048576,  // 1M tokens (预览版，保守估计)
    'gemini-3-pro-preview': 1048576,  // 1M tokens
    'gemini-2.5-flash-image': 1048576,  // 1M tokens (图片生成模型)
    'gemini-2.0-flash-preview-image-generation': 1048576,  // 1M tokens (图片生成模型)
    'gemini-3-pro-image-preview': 1048576,  // 1M tokens (图片生成模型)
    'llama2': 4096,
    'llama3': 8192,
  };
  
  for (const [key, limit] of Object.entries(model_limits)) {
    if (key.toLowerCase().includes(model.toLowerCase()) || model.toLowerCase().includes(key.toLowerCase())) {
      return limit;
    }
  }
  
  return 8192; // 默认值
}

