/**
 * Context Module Types
 * 上下文模块类型定义
 */

import type { Message } from '../message/types';
import type { MediaItem } from '../shared/types';

// ============================================================================
// Context Strategy Types - 上下文策略类型
// ============================================================================

/**
 * 上下文策略类型
 */
export type ContextStrategyType = 'sliding_window' | 'summary' | 'rag' | 'hybrid';

/**
 * 上下文策略接口
 */
export interface IContextStrategy {
  name: ContextStrategyType;
  
  /**
   * 选择消息
   */
  select(
    history: Message[],
    newMessage: string,
    budget: TokenBudget,
    config: ContextConfig
  ): Promise<Message[]>;
}

// ============================================================================
// Text Context Types - 文字上下文类型
// ============================================================================

/**
 * Token 预算
 */
export interface TokenBudget {
  total: number;              // 总预算
  system: number;             // 系统提示词占用
  tools: number;              // 工具描述占用
  available: number;          // 可用于历史的预算
  reservedForResponse: number; // 为回复预留的预算
}

/**
 * 上下文配置
 */
export interface ContextConfig {
  maxTokens: number;              // 模型最大 token
  reservedForResponse: number;    // 为回复预留的 token
  strategy: ContextStrategyType;  // 构建策略
  
  // 滑动窗口配置
  window?: {
    recentCount: number;          // 最近 N 条必须保留
    importantRoles: string[];     // 重要角色消息优先
  };
  
  // 摘要配置
  summary?: {
    enabled: boolean;
    threshold: number;            // 超过多少条开始摘要
    summaryModel?: string;        // 用于摘要的模型
  };
  
  // RAG 配置
  rag?: {
    enabled: boolean;
    topK: number;                 // 检索 top K 条
    minSimilarity: number;        // 最小相似度阈值
  };
  
  // 多模态配置
  media?: {
    imageTokenEstimate: number;   // 每张图片估算 token
    maxImages: number;            // 最多保留几张图
    compressLargeImages: boolean; // 是否压缩大图
  };
}

/**
 * 默认上下文配置
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxTokens: 128000,
  reservedForResponse: 4096,
  strategy: 'sliding_window',
  window: {
    recentCount: 20,
    importantRoles: ['system'],
  },
  summary: {
    enabled: false,
    threshold: 50,
  },
  rag: {
    enabled: false,
    topK: 5,
    minSimilarity: 0.7,
  },
  media: {
    imageTokenEstimate: 1000,
    maxImages: 5,
    compressLargeImages: true,
  },
};

/**
 * 上下文构建结果
 */
export interface ContextResult {
  messages: Message[];          // 最终的消息数组
  tokenUsage: {
    system: number;
    history: number;
    tools: number;
    total: number;
    budget: number;
  };
  metadata: {
    truncatedCount: number;       // 被截断的消息数
    summarizedCount: number;      // 被摘要的消息数
    ragRetrievedCount: number;    // RAG 检索的消息数
  };
}

// ============================================================================
// Media Context Types - 媒体上下文类型
// ============================================================================

/**
 * 媒体生成类型
 */
export type MediaGenerationType = 'img2img' | 'img2video' | 'text2img' | 'text2video';

/**
 * 媒体上下文配置
 */
export interface MediaContextConfig {
  // 是否启用历史关联
  enableHistory: boolean;
  
  // 历史关联配置
  history?: {
    maxLookback: number;        // 最多回看几条消息
    similarityThreshold: number; // 关联性阈值（0-1）
    sameSessionOnly: boolean;   // 只在同一会话内查找
  };
}

/**
 * 默认媒体上下文配置
 */
export const DEFAULT_MEDIA_CONTEXT_CONFIG: MediaContextConfig = {
  enableHistory: true,
  history: {
    maxLookback: 5,
    similarityThreshold: 0.5,
    sameSessionOnly: true,
  },
};

/**
 * 媒体生成上下文
 */
export interface MediaGenerationContext {
  type: MediaGenerationType;
  
  // 文生X：只需要提示词
  prompt: string;
  negativePrompt?: string;
  
  // 图生X：需要参考图
  referenceMedia?: MediaItem;
  
  // 系统配置
  systemPrompt?: string;    // 风格指导等
  
  // 历史关联（可选）
  historyContext?: {
    relatedMessages: MediaMessage[];  // 相关的历史媒体消息
    isIteration: boolean;             // 是否是迭代调整
    iterationChain?: string[];        // 迭代链的消息ID
  };
  
  // 生成参数
  options?: {
    width?: number;
    height?: number;
    steps?: number;
    seed?: number;
  };
}

/**
 * 媒体消息
 */
export interface MediaMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  media?: MediaItem[];
  timestamp: number;
}

/**
 * 媒体上下文输入
 */
export interface MediaContextInput {
  sessionId: string;
  prompt: string;
  referenceMedia?: MediaItem;
  systemPrompt?: string;
  outputType?: 'image' | 'video';
}
