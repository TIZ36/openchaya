/**
 * MediaContext - 媒体上下文
 * 管理媒体生成的上下文，支持可选的历史关联
 */

import type { MediaItem } from '../shared/types';
import type {
  MediaContextConfig,
  MediaGenerationContext,
  MediaGenerationType,
  MediaContextInput,
  MediaMessage,
} from './types';
import { DEFAULT_MEDIA_CONTEXT_CONFIG } from './types';
import { createLogger } from '../shared/utils';

const logger = createLogger('MediaContext');

/**
 * 媒体消息获取回调
 */
export type MediaMessageCallback = (
  sessionId: string,
  limit: number
) => Promise<MediaMessage[]>;

/**
 * 媒体上下文
 */
export class MediaContext {
  private config: MediaContextConfig;
  private messageCallback?: MediaMessageCallback;

  constructor(config?: Partial<MediaContextConfig>) {
    this.config = { ...DEFAULT_MEDIA_CONTEXT_CONFIG, ...config };
  }

  /**
   * 设置消息获取回调
   */
  setMessageCallback(callback: MediaMessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * 构建媒体生成上下文
   */
  async build(input: MediaContextInput): Promise<MediaGenerationContext> {
    const type = this.inferType(input);
    
    const context: MediaGenerationContext = {
      type,
      prompt: input.prompt,
      referenceMedia: input.referenceMedia,
      systemPrompt: input.systemPrompt,
    };

    // 检查是否需要历史关联
    if (this.config.enableHistory && this.messageCallback) {
      const historyContext = await this.findRelatedHistory(input);
      if (historyContext) {
        context.historyContext = historyContext;
        logger.debug('Found history context', {
          sessionId: input.sessionId,
          isIteration: historyContext.isIteration,
          relatedCount: historyContext.relatedMessages.length,
        });
      }
    }

    return context;
  }

  /**
   * 推断生成类型
   */
  private inferType(input: MediaContextInput): MediaGenerationType {
    const hasRef = !!input.referenceMedia;
    const isVideo = input.outputType === 'video' ||
      input.prompt?.toLowerCase().includes('video') ||
      input.prompt?.includes('视频');

    if (hasRef && isVideo) return 'img2video';
    if (hasRef) return 'img2img';
    if (isVideo) return 'text2video';
    return 'text2img';
  }

  /**
   * 查找相关历史
   */
  private async findRelatedHistory(
    input: MediaContextInput
  ): Promise<MediaGenerationContext['historyContext'] | null> {
    if (!this.messageCallback) return null;

    const historyConfig = this.config.history ?? DEFAULT_MEDIA_CONTEXT_CONFIG.history!;
    const { maxLookback } = historyConfig;

    // 获取最近的媒体消息
    const recentMedia = await this.messageCallback(input.sessionId, maxLookback);

    if (recentMedia.length === 0) {
      return null;
    }

    // 检查是否是迭代调整
    const isIteration = this.detectIteration(recentMedia, input);

    if (isIteration) {
      return {
        relatedMessages: recentMedia,
        isIteration: true,
        iterationChain: recentMedia.map((m) => m.id),
      };
    }

    // 检查关键词相关性
    const related = this.filterByRelevance(recentMedia, input.prompt);

    if (related.length > 0) {
      return {
        relatedMessages: related,
        isIteration: false,
      };
    }

    return null;
  }

  /**
   * 检测是否是迭代调整
   * 场景：用户说"把背景改成蓝色"、"再亮一点"
   */
  private detectIteration(history: MediaMessage[], input: MediaContextInput): boolean {
    // 如果用户提供了新的参考图，不是迭代
    if (input.referenceMedia) return false;

    // 如果最近有 assistant 的媒体输出，可能是迭代
    const lastAssistantMedia = history.find(
      (m) => m.role === 'assistant' && m.media && m.media.length > 0
    );

    if (!lastAssistantMedia) return false;

    // 检查提示词是否包含迭代关键词
    const iterationKeywords = [
      '改', '换', '调', '修改', '变',
      '更', '再', '继续', '保持',
      'change', 'modify', 'adjust', 'keep', 'make it',
    ];

    const prompt = input.prompt.toLowerCase();
    return iterationKeywords.some((keyword) => prompt.includes(keyword));
  }

  /**
   * 按相关性过滤
   */
  private filterByRelevance(
    history: MediaMessage[],
    prompt: string
  ): MediaMessage[] {
    if (!prompt) return [];

    const promptWords = this.extractKeywords(prompt);
    if (promptWords.length === 0) return [];

    return history.filter((msg) => {
      const msgWords = this.extractKeywords(msg.content);
      const overlap = promptWords.filter((w) => msgWords.includes(w));
      return overlap.length >= 1; // 至少有一个关键词匹配
    });
  }

  /**
   * 提取关键词
   */
  private extractKeywords(text: string): string[] {
    if (!text) return [];
    
    // 简单分词
    const words = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    // 过滤停用词
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      '的', '是', '在', '了', '和', '与', '或', '而', '但',
    ]);

    return words.filter((w) => !stopWords.has(w));
  }

  /**
   * 从迭代链获取最后的媒体
   */
  getLastMediaFromChain(context: MediaGenerationContext): MediaItem | undefined {
    if (!context.historyContext?.isIteration) return undefined;

    const { relatedMessages } = context.historyContext;
    
    // 从后往前找 assistant 的媒体输出
    for (let i = relatedMessages.length - 1; i >= 0; i--) {
      const msg = relatedMessages[i];
      if (msg.role === 'assistant' && msg.media && msg.media.length > 0) {
        return msg.media[0];
      }
    }

    return undefined;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let mediaContextInstance: MediaContext | null = null;

/**
 * 获取媒体上下文单例
 */
export function getMediaContext(config?: Partial<MediaContextConfig>): MediaContext {
  if (!mediaContextInstance) {
    mediaContextInstance = new MediaContext(config);
  }
  return mediaContextInstance;
}
