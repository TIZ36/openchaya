/**
 * MCP 媒体提取器
 * 用于从 MCP 返回结果中直接提取 base64 媒体数据，避免将大量 base64 数据发送给 LLM
 */

export interface ExtractedMedia {
  type: 'image' | 'video' | 'audio';
  mimeType: string;
  data: string; // base64 编码的数据
}

export interface MCPMediaExtractionResult {
  /** 清理后的内容（base64 数据被替换为占位符） */
  cleanedContent: any;
  /** 提取出的媒体列表 */
  media: ExtractedMedia[];
  /** 是否有提取到媒体 */
  hasMedia: boolean;
}

/**
 * 检测字符串是否是有效的 base64 图片数据
 */
function isValidBase64Image(data: string): boolean {
  if (!data || typeof data !== 'string') return false;
  
  // 检查长度（至少 50 字符才可能是图片，二维码可能较小）
  if (data.length < 50) return false;
  
  // 检查是否是有效的 base64 字符
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  // 取前 1000 个字符检查，避免检查整个大字符串
  const sample = data.substring(0, Math.min(data.length, 1000));
  if (!base64Regex.test(sample)) return false;
  
  // 检查是否以常见的图片 base64 开头（即使数据被截断，开头也应该正确）
  if (sample.startsWith('iVBORw') || // PNG
      sample.startsWith('/9j/') ||   // JPEG
      sample.startsWith('R0lGOD') ||  // GIF
      sample.startsWith('UklGR')) {  // WebP
    return true;
  }
  
  // 如果数据很长（>1000字符），很可能是完整的 base64 图片
  if (data.length > 1000) {
    return true;
  }
  
  return true;
}

/**
 * 从 MCP 结果中提取媒体内容
 * 支持多种 MCP 响应格式
 */
export function extractMCPMedia(mcpResult: any): MCPMediaExtractionResult {
  const media: ExtractedMedia[] = [];
  let cleanedContent = mcpResult;
  
  console.log('[MCPMediaExtractor] 开始提取媒体，输入类型:', typeof mcpResult);
  
  try {
    // 如果是字符串，尝试解析为 JSON
    let contentObj = mcpResult;
    if (typeof mcpResult === 'string') {
      try {
        contentObj = JSON.parse(mcpResult);
      } catch {
        // 不是 JSON，直接返回
        console.log('[MCPMediaExtractor] 输入不是 JSON');
        return { cleanedContent: mcpResult, media: [], hasMedia: false };
      }
    }
    
    // 深度克隆，以便我们可以修改它
    cleanedContent = JSON.parse(JSON.stringify(contentObj));
    
    // 处理 MCP 标准响应格式: { result: { content: [...] } }
    const contentArray = contentObj?.result?.content || contentObj?.content || (Array.isArray(contentObj) ? contentObj : null);
    
    if (Array.isArray(contentArray)) {
      console.log('[MCPMediaExtractor] 发现 content 数组，长度:', contentArray.length);
      console.log('[MCPMediaExtractor] content 数组预览:', JSON.stringify(contentArray.slice(0, 3).map(item => ({
        type: item?.type,
        mimeType: item?.mimeType || item?.mime_type,
        dataLength: item?.data?.length || 0,
        dataPreview: item?.data ? item.data.substring(0, 50) + '...' : 'no data',
      })), null, 2));
      
      for (let i = 0; i < contentArray.length; i++) {
        const item = contentArray[i];
        
        // 处理图片
        if (item.type === 'image') {
          const mimeType = item.mimeType || item.mime_type || 'image/png';
          const data = item.data;
          
          // 放宽检查：只要 data 存在且长度 >= 50，就尝试提取（二维码可能较小）
          if (data && typeof data === 'string' && data.length >= 50) {
            console.log('[MCPMediaExtractor] 提取图片:', { mimeType, dataLength: data.length, preview: data.substring(0, 50) });
            media.push({
              type: 'image',
              mimeType,
              data, // 直接使用原始 data，即使可能被截断，也尝试显示
            });
            
            // 替换为占位符
            const placeholder = `[图片已提取: ${mimeType}, ${Math.round(data.length / 1024)}KB]`;
            replaceInCleanedContent(cleanedContent, i, { type: 'image', placeholder });
          } else if (data && typeof data === 'string' && data.length > 0) {
            // 即使数据很短，也尝试提取（可能是被截断的，但至少尝试显示）
            console.warn('[MCPMediaExtractor] 图片数据较短，可能不完整:', { mimeType, dataLength: data.length });
            media.push({
              type: 'image',
              mimeType,
              data,
            });
            const placeholder = `[图片已提取: ${mimeType}, ${data.length} 字符（可能不完整）]`;
            replaceInCleanedContent(cleanedContent, i, { type: 'image', placeholder });
          }
        }
        
        // 处理视频
        else if (item.type === 'video') {
          const mimeType = item.mimeType || item.mime_type || 'video/mp4';
          const data = item.data;
          
          if (data && data.length > 100) {
            console.log('[MCPMediaExtractor] 提取视频:', { mimeType, dataLength: data.length });
            media.push({
              type: 'video',
              mimeType,
              data,
            });
            
            // 替换为占位符
            const placeholder = `[视频已提取: ${mimeType}, ${Math.round(data.length / 1024)}KB]`;
            replaceInCleanedContent(cleanedContent, i, { type: 'video', placeholder });
          }
        }
        
        // 处理音频
        else if (item.type === 'audio') {
          const mimeType = item.mimeType || item.mime_type || 'audio/mp3';
          const data = item.data;
          
          if (data && data.length > 100) {
            console.log('[MCPMediaExtractor] 提取音频:', { mimeType, dataLength: data.length });
            media.push({
              type: 'audio',
              mimeType,
              data,
            });
            
            // 替换为占位符
            const placeholder = `[音频已提取: ${mimeType}, ${Math.round(data.length / 1024)}KB]`;
            replaceInCleanedContent(cleanedContent, i, { type: 'audio', placeholder });
          }
        }
      }
    }
    
    // 还要检查其他可能包含 base64 图片的字段
    extractFromNestedObject(contentObj, cleanedContent, media, '');
    
  } catch (e) {
    console.error('[MCPMediaExtractor] 提取失败:', e);
  }
  
  console.log('[MCPMediaExtractor] 提取完成，媒体数量:', media.length);
  
  return {
    cleanedContent,
    media,
    hasMedia: media.length > 0,
  };
}

/**
 * 在清理后的内容中替换媒体数据
 */
function replaceInCleanedContent(cleanedContent: any, index: number, replacement: { type: string; placeholder: string }) {
  const contentArray = cleanedContent?.result?.content || cleanedContent?.content;
  if (Array.isArray(contentArray) && contentArray[index]) {
    // 保留类型信息，但用占位符替换数据
    contentArray[index] = {
      type: 'text',
      text: replacement.placeholder,
      _originalType: replacement.type,
    };
  }
}

/**
 * 递归检查嵌套对象中的 base64 图片数据
 */
function extractFromNestedObject(
  obj: any, 
  cleanedObj: any, 
  media: ExtractedMedia[], 
  path: string
): void {
  if (!obj || typeof obj !== 'object') return;
  
  // 检查常见的图片字段名
  const imageFieldNames = ['image', 'screenshot', 'base64', 'imageData', 'img', 'picture', 'photo', 'thumbnail'];
  const videoFieldNames = ['video', 'videoData', 'clip'];
  const audioFieldNames = ['audio', 'audioData', 'sound'];
  
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const currentPath = path ? `${path}.${key}` : key;
    
    // 跳过已经处理过的 content 数组
    if (key === 'content' && Array.isArray(value)) continue;
    
    if (typeof value === 'string' && value.length > 1000) {
      // 检查是否是 base64 图片
      const lowerKey = key.toLowerCase();
      
      if (imageFieldNames.some(name => lowerKey.includes(name)) && isValidBase64Image(value)) {
        console.log('[MCPMediaExtractor] 从字段提取图片:', currentPath, 'length:', value.length);
        
        // 尝试检测 MIME 类型
        let mimeType = 'image/png';
        if (value.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (value.startsWith('iVBORw')) mimeType = 'image/png';
        else if (value.startsWith('R0lGOD')) mimeType = 'image/gif';
        else if (value.startsWith('UklGR')) mimeType = 'image/webp';
        
        media.push({
          type: 'image',
          mimeType,
          data: value,
        });
        
        // 替换为占位符
        if (cleanedObj && cleanedObj[key]) {
          cleanedObj[key] = `[图片已提取: ${mimeType}, ${Math.round(value.length / 1024)}KB]`;
        }
      }
      
      // 检查是否是 data URI 格式
      else if (value.startsWith('data:image/')) {
        const match = value.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          const mimeType = match[1];
          const data = match[2];
          
          console.log('[MCPMediaExtractor] 从 data URI 提取图片:', currentPath, 'mimeType:', mimeType);
          
          media.push({
            type: 'image',
            mimeType,
            data,
          });
          
          if (cleanedObj && cleanedObj[key]) {
            cleanedObj[key] = `[图片已提取: ${mimeType}, ${Math.round(data.length / 1024)}KB]`;
          }
        }
      }
      
      // 检查视频字段
      else if (videoFieldNames.some(name => lowerKey.includes(name))) {
        console.log('[MCPMediaExtractor] 从字段提取视频:', currentPath);
        media.push({
          type: 'video',
          mimeType: 'video/mp4',
          data: value,
        });
        
        if (cleanedObj && cleanedObj[key]) {
          cleanedObj[key] = `[视频已提取: video/mp4, ${Math.round(value.length / 1024)}KB]`;
        }
      }
      
      // 检查音频字段
      else if (audioFieldNames.some(name => lowerKey.includes(name))) {
        console.log('[MCPMediaExtractor] 从字段提取音频:', currentPath);
        media.push({
          type: 'audio',
          mimeType: 'audio/mp3',
          data: value,
        });
        
        if (cleanedObj && cleanedObj[key]) {
          cleanedObj[key] = `[音频已提取: audio/mp3, ${Math.round(value.length / 1024)}KB]`;
        }
      }
    }
    
    // 递归处理嵌套对象
    else if (typeof value === 'object' && value !== null) {
      extractFromNestedObject(value, cleanedObj?.[key], media, currentPath);
    }
  }
}

/**
 * 快速检测 MCP 结果是否可能包含媒体
 * 用于快速判断是否需要进行完整的提取
 */
export function mightContainMedia(mcpResult: any): boolean {
  if (!mcpResult) return false;
  
  const str = typeof mcpResult === 'string' ? mcpResult : JSON.stringify(mcpResult);
  
  // 快速检查关键字
  return str.includes('"type":"image"') || 
         str.includes('"type": "image"') ||
         str.includes('"image"') ||
         str.includes('"screenshot"') ||
         str.includes('"base64"') ||
         str.includes('data:image/') ||
         str.includes('"type":"video"') ||
         str.includes('"type":"audio"') ||
         // 检查长字符串（可能是 base64）
         str.length > 10000;
}

