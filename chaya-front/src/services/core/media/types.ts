/**
 * Media Module Types
 * 多模态展示模块类型定义
 */

// ============================================================================
// Media Types - 媒体类型
// ============================================================================

/**
 * 媒体类型
 */
export type MediaType = 'image' | 'audio' | 'video' | 'text';

/**
 * 媒体来源
 */
export type MediaSource = 'base64' | 'url' | 'blob' | 'file';

/**
 * 媒体项
 */
export interface MediaItem {
  type: MediaType;
  mimeType: string;
  source: MediaSource;
  data?: string;       // base64 data
  url?: string;        // URL
  blob?: Blob;         // Blob object
  file?: File;         // File object
  
  // 元数据
  width?: number;
  height?: number;
  duration?: number;   // 音频/视频时长（秒）
  size?: number;       // 文件大小（字节）
  filename?: string;
}

/**
 * 渲染配置
 */
export interface RenderConfig {
  // 图片配置
  image?: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;         // 0-1
    lazyLoad?: boolean;
  };
  
  // 音频配置
  audio?: {
    autoplay?: boolean;
    controls?: boolean;
    loop?: boolean;
  };
  
  // 视频配置
  video?: {
    autoplay?: boolean;
    controls?: boolean;
    loop?: boolean;
    muted?: boolean;
    maxWidth?: number;
    maxHeight?: number;
  };
  
  // 文本配置
  text?: {
    markdown?: boolean;
    highlight?: boolean;
    maxLength?: number;
  };
}

/**
 * 默认渲染配置
 */
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  image: {
    maxWidth: 1920,
    maxHeight: 1080,
    quality: 0.85,
    lazyLoad: true,
  },
  audio: {
    autoplay: false,
    controls: true,
    loop: false,
  },
  video: {
    autoplay: false,
    controls: true,
    loop: false,
    muted: true,
    maxWidth: 1920,
    maxHeight: 1080,
  },
  text: {
    markdown: true,
    highlight: true,
    maxLength: 100000,
  },
};

// ============================================================================
// Handler Types - 处理器类型
// ============================================================================

/**
 * 媒体处理器接口
 */
export interface IMediaHandler {
  type: MediaType;
  
  /**
   * 检查是否支持该媒体
   */
  canHandle(item: MediaItem): boolean;
  
  /**
   * 获取渲染用的 URL
   */
  getSourceUrl(item: MediaItem): Promise<string>;
  
  /**
   * 转换为 base64
   */
  toBase64(item: MediaItem): Promise<string>;
  
  /**
   * 转换为 Blob
   */
  toBlob(item: MediaItem): Promise<Blob>;
  
  /**
   * 获取元数据
   */
  getMetadata(item: MediaItem): Promise<MediaMetadata>;
  
  /**
   * 释放资源
   */
  release(item: MediaItem): void;
}

/**
 * 媒体元数据
 */
export interface MediaMetadata {
  type: MediaType;
  mimeType: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  [key: string]: unknown;
}

// ============================================================================
// Render Result Types - 渲染结果类型
// ============================================================================

/**
 * 渲染结果
 */
export interface RenderResult {
  type: MediaType;
  sourceUrl: string;
  metadata: MediaMetadata;
  cleanup: () => void;
}
