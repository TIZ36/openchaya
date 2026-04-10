/**
 * AudioHandler - 音频处理器
 * 处理各种格式的音频文件
 */

import type { MediaItem, IMediaHandler, MediaMetadata, RenderConfig } from '../types';

/**
 * 音频处理器
 */
export class AudioHandler implements IMediaHandler {
  type: 'audio' = 'audio';
  
  private blobUrls: Set<string> = new Set();
  private config: RenderConfig['audio'];

  constructor(config?: RenderConfig['audio']) {
    this.config = config;
  }

  /**
   * 检查是否支持该媒体
   */
  canHandle(item: MediaItem): boolean {
    return item.type === 'audio' && item.mimeType?.startsWith('audio/');
  }

  /**
   * 获取渲染用的 URL
   */
  async getSourceUrl(item: MediaItem): Promise<string> {
    // 已有 URL
    if (item.url) {
      if (/^(https?:|data:|blob:|file:)/i.test(item.url)) {
        return item.url;
      }
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

    throw new Error('No valid audio source');
  }

  /**
   * 转换为 base64
   */
  async toBase64(item: MediaItem): Promise<string> {
    if (item.data) {
      return item.data.startsWith('data:')
        ? item.data.split(',')[1]
        : item.data;
    }

    if (item.url && this.looksLikeBase64(item.url)) {
      return item.url;
    }

    if (item.url && /^https?:/i.test(item.url)) {
      const response = await fetch(item.url);
      const blob = await response.blob();
      return this.blobToBase64(blob);
    }

    if (item.blob) {
      return this.blobToBase64(item.blob);
    }

    if (item.file) {
      return this.blobToBase64(item.file);
    }

    throw new Error('Cannot convert to base64');
  }

  /**
   * 转换为 Blob
   */
  async toBlob(item: MediaItem): Promise<Blob> {
    if (item.blob) {
      return item.blob;
    }

    if (item.file) {
      return item.file;
    }

    if (item.data) {
      return this.base64ToBlob(item.data, item.mimeType);
    }

    if (item.url && this.looksLikeBase64(item.url)) {
      return this.base64ToBlob(item.url, item.mimeType);
    }

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
      type: 'audio',
      mimeType: item.mimeType,
      size: item.size,
      duration: item.duration,
    };

    // 如果缺少时长信息，尝试获取
    if (!metadata.duration) {
      try {
        const url = await this.getSourceUrl(item);
        metadata.duration = await this.getAudioDuration(url);
      } catch {
        // 忽略错误
      }
    }

    return metadata;
  }

  /**
   * 释放资源
   */
  release(item: MediaItem): void {
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

  private looksLikeBase64(s: string): boolean {
    if (!s) return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('data:')) return true;
    if (trimmed.length < 100) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

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

  private getAudioDuration(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.onloadedmetadata = () => {
        resolve(audio.duration);
      };
      audio.onerror = reject;
      audio.src = url;
    });
  }
}
