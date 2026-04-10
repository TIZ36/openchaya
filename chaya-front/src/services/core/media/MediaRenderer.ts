/**
 * MediaRenderer - 媒体渲染器
 * 统一的多模态渲染调度器
 */

import type {
  MediaItem,
  MediaType,
  IMediaHandler,
  RenderConfig,
  RenderResult,
  MediaMetadata,
} from './types';
import { DEFAULT_RENDER_CONFIG } from './types';
import { ImageHandler, AudioHandler, VideoHandler, TextHandler } from './handlers';
import { createLogger } from '../shared/utils';

const logger = createLogger('MediaRenderer');

/**
 * 媒体渲染器
 */
export class MediaRenderer {
  private handlers: Map<MediaType, IMediaHandler>;
  private config: RenderConfig;

  constructor(config?: Partial<RenderConfig>) {
    this.config = { ...DEFAULT_RENDER_CONFIG, ...config };
    
    // 初始化处理器
    this.handlers = new Map<MediaType, IMediaHandler>([
      ['image', new ImageHandler(this.config.image)],
      ['audio', new AudioHandler(this.config.audio)],
      ['video', new VideoHandler(this.config.video)],
      ['text', new TextHandler(this.config.text)],
    ]);
  }

  /**
   * 注册自定义处理器
   */
  registerHandler(handler: IMediaHandler): void {
    this.handlers.set(handler.type, handler);
    logger.info('Handler registered', { type: handler.type });
  }

  /**
   * 获取处理器
   */
  getHandler(type: MediaType): IMediaHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * 渲染媒体项
   */
  async render(item: MediaItem): Promise<RenderResult> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }

    const sourceUrl = await handler.getSourceUrl(item);
    const metadata = await handler.getMetadata(item);

    return {
      type: item.type,
      sourceUrl,
      metadata,
      cleanup: () => handler.release(item),
    };
  }

  /**
   * 批量渲染
   */
  async renderMany(items: MediaItem[]): Promise<RenderResult[]> {
    return Promise.all(items.map((item) => this.render(item)));
  }

  /**
   * 获取渲染 URL
   */
  async getSourceUrl(item: MediaItem): Promise<string> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }
    return handler.getSourceUrl(item);
  }

  /**
   * 转换为 base64
   */
  async toBase64(item: MediaItem): Promise<string> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }
    return handler.toBase64(item);
  }

  /**
   * 转换为 Blob
   */
  async toBlob(item: MediaItem): Promise<Blob> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }
    return handler.toBlob(item);
  }

  /**
   * 获取元数据
   */
  async getMetadata(item: MediaItem): Promise<MediaMetadata> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }
    return handler.getMetadata(item);
  }

  /**
   * 下载媒体
   */
  async download(item: MediaItem, filename?: string): Promise<void> {
    const handler = this.findHandler(item);
    if (!handler) {
      throw new Error(`No handler for media type: ${item.type}`);
    }

    const blob = await handler.toBlob(item);
    const url = URL.createObjectURL(blob);
    
    const defaultFilename = this.generateFilename(item);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || defaultFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logger.debug('Media downloaded', { type: item.type, filename: filename || defaultFilename });
  }

  /**
   * 释放资源
   */
  release(item: MediaItem): void {
    const handler = this.findHandler(item);
    if (handler) {
      handler.release(item);
    }
  }

  /**
   * 释放所有资源
   */
  releaseAll(): void {
    this.handlers.forEach((handler) => {
      if ('releaseAll' in handler && typeof handler.releaseAll === 'function') {
        handler.releaseAll();
      }
    });
    logger.info('All resources released');
  }

  // ============================================================================
  // Static Utilities
  // ============================================================================

  /**
   * 推断媒体类型
   */
  static inferType(mimeType: string): MediaType {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
    return 'text'; // 默认文本
  }

  /**
   * 从 base64 推断 MIME 类型
   */
  static inferMimeType(base64: string): string {
    // 检查 data URL 前缀
    if (base64.startsWith('data:')) {
      const match = base64.match(/^data:([^;,]+)/);
      if (match) return match[1];
    }

    // 根据 base64 前缀推断
    if (base64.startsWith('iVBORw')) return 'image/png';
    if (base64.startsWith('/9j/') || base64.startsWith('9j/')) return 'image/jpeg';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    if (base64.startsWith('UklGR')) return 'image/webp';
    if (base64.startsWith('AAAA')) return 'video/mp4';
    
    return 'application/octet-stream';
  }

  /**
   * 检测是否为 base64 数据
   */
  static isBase64(str: string): boolean {
    if (!str) return false;
    const trimmed = str.trim();
    if (trimmed.startsWith('data:')) return true;
    if (trimmed.length < 100) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
  }

  /**
   * 创建 MediaItem
   */
  static createItem(
    source: string | Blob | File,
    options: { type?: MediaType; mimeType?: string } = {}
  ): MediaItem {
    if (typeof source === 'string') {
      // URL
      if (/^(https?:|blob:|file:)/i.test(source)) {
        const mimeType = options.mimeType || 'application/octet-stream';
        return {
          type: options.type || MediaRenderer.inferType(mimeType),
          mimeType,
          source: 'url',
          url: source,
        };
      }
      
      // base64
      const mimeType = options.mimeType || MediaRenderer.inferMimeType(source);
      return {
        type: options.type || MediaRenderer.inferType(mimeType),
        mimeType,
        source: 'base64',
        data: source.startsWith('data:') ? source.split(',')[1] : source,
      };
    }

    if (source instanceof File) {
      return {
        type: options.type || MediaRenderer.inferType(source.type),
        mimeType: source.type,
        source: 'file',
        file: source,
        filename: source.name,
        size: source.size,
      };
    }

    if (source instanceof Blob) {
      return {
        type: options.type || MediaRenderer.inferType(source.type),
        mimeType: source.type,
        source: 'blob',
        blob: source,
        size: source.size,
      };
    }

    throw new Error('Invalid media source');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 查找合适的处理器
   */
  private findHandler(item: MediaItem): IMediaHandler | undefined {
    // 先按类型查找
    const handler = this.handlers.get(item.type);
    if (handler?.canHandle(item)) {
      return handler;
    }

    // 遍历查找
    for (const h of this.handlers.values()) {
      if (h.canHandle(item)) {
        return h;
      }
    }

    return undefined;
  }

  /**
   * 生成文件名
   */
  private generateFilename(item: MediaItem): string {
    if (item.filename) return item.filename;
    
    const ext = item.mimeType?.split('/')[1] || 'bin';
    const timestamp = Date.now();
    return `${item.type}-${timestamp}.${ext}`;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let mediaRendererInstance: MediaRenderer | null = null;

/**
 * 获取媒体渲染器单例
 */
export function getMediaRenderer(config?: Partial<RenderConfig>): MediaRenderer {
  if (!mediaRendererInstance) {
    mediaRendererInstance = new MediaRenderer(config);
  }
  return mediaRendererInstance;
}
