/**
 * ImageHandler - 图片处理器
 * 处理 base64/url/blob 格式的图片
 */

import type { MediaItem, IMediaHandler, MediaMetadata, RenderConfig } from '../types';

/**
 * 图片处理器
 */
export class ImageHandler implements IMediaHandler {
  type: 'image' = 'image';
  
  private blobUrls: Set<string> = new Set();
  private config: RenderConfig['image'];

  constructor(config?: RenderConfig['image']) {
    this.config = config;
  }

  /**
   * 检查是否支持该媒体
   */
  canHandle(item: MediaItem): boolean {
    return item.type === 'image' && item.mimeType?.startsWith('image/');
  }

  /**
   * 获取渲染用的 URL
   */
  async getSourceUrl(item: MediaItem): Promise<string> {
    // 已有 URL
    if (item.url) {
      // 检查是否是完整 URL
      if (/^(https?:|data:|blob:|file:)/i.test(item.url)) {
        return item.url;
      }
      // 可能是原始 base64 数据
      if (this.looksLikeBase64(item.url)) {
        return `data:${item.mimeType};base64,${item.url}`;
      }
    }

    // base64 数据
    if (item.data) {
      if (item.data.startsWith('data:')) {
        return item.data;
      }
      return `data:${item.mimeType};base64,${item.data}`;
    }

    // Blob 对象
    if (item.blob) {
      const url = URL.createObjectURL(item.blob);
      this.blobUrls.add(url);
      return url;
    }

    // File 对象
    if (item.file) {
      const url = URL.createObjectURL(item.file);
      this.blobUrls.add(url);
      return url;
    }

    throw new Error('No valid image source');
  }

  /**
   * 转换为 base64
   */
  async toBase64(item: MediaItem): Promise<string> {
    // 已有 base64
    if (item.data) {
      return item.data.startsWith('data:')
        ? item.data.split(',')[1]
        : item.data;
    }

    // URL 可能是 base64
    if (item.url && this.looksLikeBase64(item.url)) {
      return item.url;
    }

    // 从 URL 加载
    if (item.url && /^https?:/i.test(item.url)) {
      const response = await fetch(item.url);
      const blob = await response.blob();
      return this.blobToBase64(blob);
    }

    // 从 Blob 转换
    if (item.blob) {
      return this.blobToBase64(item.blob);
    }

    // 从 File 转换
    if (item.file) {
      return this.blobToBase64(item.file);
    }

    throw new Error('Cannot convert to base64');
  }

  /**
   * 转换为 Blob
   */
  async toBlob(item: MediaItem): Promise<Blob> {
    // 已有 Blob
    if (item.blob) {
      return item.blob;
    }

    // 已有 File
    if (item.file) {
      return item.file;
    }

    // 从 base64 转换
    if (item.data) {
      return this.base64ToBlob(item.data, item.mimeType);
    }

    // URL 可能是 base64
    if (item.url && this.looksLikeBase64(item.url)) {
      return this.base64ToBlob(item.url, item.mimeType);
    }

    // 从 URL 加载
    if (item.url) {
      const response = await fetch(item.url);
      return response.blob();
    }

    throw new Error('Cannot convert to Blob');
  }

  /**
   * 获取元数据
   */
  async getMetadata(item: MediaItem): Promise<MediaMetadata> {
    const metadata: MediaMetadata = {
      type: 'image',
      mimeType: item.mimeType,
      size: item.size,
      width: item.width,
      height: item.height,
    };

    // 如果缺少尺寸信息，尝试获取
    if (!metadata.width || !metadata.height) {
      try {
        const url = await this.getSourceUrl(item);
        const dimensions = await this.getImageDimensions(url);
        metadata.width = dimensions.width;
        metadata.height = dimensions.height;
      } catch {
        // 忽略错误
      }
    }

    // 如果缺少大小信息
    if (!metadata.size && item.data) {
      metadata.size = Math.ceil(item.data.length * 0.75);
    }

    return metadata;
  }

  /**
   * 释放资源
   */
  release(item: MediaItem): void {
    // 释放 blob URL
    this.blobUrls.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    this.blobUrls.clear();
  }

  /**
   * 释放所有资源
   */
  releaseAll(): void {
    this.blobUrls.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    this.blobUrls.clear();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 检测是否为 base64 数据
   */
  private looksLikeBase64(s: string): boolean {
    if (!s) return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('data:')) return true;
    if (trimmed.length < 100) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
  }

  /**
   * Blob 转 base64
   */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /**
   * base64 转 Blob
   */
  private base64ToBlob(base64: string, mimeType: string): Blob {
    const cleanBase64 = base64.startsWith('data:')
      ? base64.split(',')[1]
      : base64;
    
    const byteCharacters = atob(cleanBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  /**
   * 获取图片尺寸
   */
  private getImageDimensions(url: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = reject;
      img.src = url;
    });
  }
}
