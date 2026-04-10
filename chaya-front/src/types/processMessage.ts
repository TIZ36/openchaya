/**
 * ProcessMessage 统一协议（可扩展）
 * 必需字段：type / contentType / timestamp / title
 */

export type ProcessContentType = 'text' | 'image' | 'images' | string;

export interface ProcessMessage {
  /** 类型（允许扩展） */
  type: string;
  /** 内容类型（text/image/images，允许扩展） */
  contentType: ProcessContentType;
  /** 毫秒时间戳 */
  timestamp: number;
  /** 标题（用于 tag 显示） */
  title: string;
  /** 文本内容 */
  content?: string;
  /** 单图 */
  image?: { mimeType: string; data: string };
  /** 多图 */
  images?: Array<{ mimeType: string; data: string }>;
  /** 扩展字段 */
  meta?: Record<string, any>;
  /** 允许任意扩展字段 */
  [key: string]: any;
}

export type ProcessMessages = ProcessMessage[];
