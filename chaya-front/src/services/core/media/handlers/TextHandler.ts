/**
 * TextHandler - 文本处理器
 * 处理富文本和 Markdown
 */

import type { MediaItem, IMediaHandler, MediaMetadata, RenderConfig } from '../types';

/**
 * 文本处理器
 */
export class TextHandler implements IMediaHandler {
  type: 'text' = 'text';
  
  private config: RenderConfig['text'];

  constructor(config?: RenderConfig['text']) {
    this.config = config;
  }

  /**
   * 检查是否支持该媒体
   */
  canHandle(item: MediaItem): boolean {
    return (
      item.type === 'text' ||
      item.mimeType?.startsWith('text/') ||
      item.mimeType === 'application/json'
    );
  }

  /**
   * 获取渲染用的 URL
   */
  async getSourceUrl(item: MediaItem): Promise<string> {
    // 文本一般不需要 URL，直接返回 data URL
    const content = await this.getContent(item);
    return `data:${item.mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  }

  /**
   * 获取文本内容
   */
  async getContent(item: MediaItem): Promise<string> {
    // 直接数据
    if (item.data) {
      // 如果是 base64 编码的文本
      if (this.looksLikeBase64(item.data)) {
        return atob(item.data);
      }
      return item.data;
    }

    // URL
    if (item.url) {
      if (item.url.startsWith('data:')) {
        const commaIndex = item.url.indexOf(',');
        if (commaIndex !== -1) {
          const data = item.url.slice(commaIndex + 1);
          return decodeURIComponent(data);
        }
      }
      const response = await fetch(item.url);
      return response.text();
    }

    // Blob
    if (item.blob) {
      return item.blob.text();
    }

    // File
    if (item.file) {
      return item.file.text();
    }

    throw new Error('No valid text source');
  }

  /**
   * 转换为 base64
   */
  async toBase64(item: MediaItem): Promise<string> {
    const content = await this.getContent(item);
    return btoa(unescape(encodeURIComponent(content)));
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

    const content = await this.getContent(item);
    return new Blob([content], { type: item.mimeType });
  }

  /**
   * 获取元数据
   */
  async getMetadata(item: MediaItem): Promise<MediaMetadata> {
    let content: string | undefined;
    try {
      content = await this.getContent(item);
    } catch {
      // 忽略
    }

    return {
      type: 'text',
      mimeType: item.mimeType,
      size: content ? new Blob([content]).size : item.size,
      charCount: content?.length,
      lineCount: content?.split('\n').length,
    };
  }

  /**
   * 释放资源（文本一般不需要）
   */
  release(_item: MediaItem): void {
    // 文本不需要特殊释放
  }

  // ============================================================================
  // Text Processing Methods
  // ============================================================================

  /**
   * 检测是否为 Markdown
   */
  isMarkdown(content: string): boolean {
    // 简单检测 Markdown 特征
    const markdownPatterns = [
      /^#{1,6}\s/m,           // 标题
      /^\s*[-*+]\s/m,         // 无序列表
      /^\s*\d+\.\s/m,         // 有序列表
      /\[.+\]\(.+\)/,         // 链接
      /`{1,3}[^`]+`{1,3}/,    // 代码
      /^\s*>/m,               // 引用
    ];

    return markdownPatterns.some((pattern) => pattern.test(content));
  }

  /**
   * 检测代码语言
   */
  detectLanguage(content: string): string | null {
    // 简单的语言检测
    if (/^(import|from|def|class)\s/m.test(content)) return 'python';
    if (/^(const|let|var|function|import|export)\s/m.test(content)) return 'javascript';
    if (/^(interface|type|namespace)\s/m.test(content)) return 'typescript';
    if (/^(package|import|func|type)\s/m.test(content)) return 'go';
    if (/^(fn|let|mut|impl|struct)\s/m.test(content)) return 'rust';
    if (/<\?php/i.test(content)) return 'php';
    if (/<html|<!DOCTYPE/i.test(content)) return 'html';
    if (/^\s*{[\s\S]*".*":[\s\S]*}$/m.test(content)) return 'json';
    
    return null;
  }

  /**
   * 截断文本
   */
  truncate(content: string, maxLength?: number): string {
    const limit = maxLength ?? this.config?.maxLength ?? 100000;
    if (content.length <= limit) return content;
    return content.slice(0, limit) + '\n... (truncated)';
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private looksLikeBase64(s: string): boolean {
    if (!s) return false;
    if (s.length < 50) return false;
    return /^[A-Za-z0-9+/]+={0,2}$/.test(s.trim());
  }
}
