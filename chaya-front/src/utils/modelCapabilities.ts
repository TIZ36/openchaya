/**
 * 模型能力推断与展示（与后端 api/llm infer_model_capabilities 一致）
 * 用于补全未保存 capability 的配置（如 deepseek-reasoner）及统一展示
 */

import type { ModelCapabilities } from '../services/modelListService';

/** 根据模型名推断能力（子串匹配，与后端一致） */
export function inferCapabilitiesFromModelName(modelName: string): ModelCapabilities {
  if (!modelName) return {};
  const m = modelName.toLowerCase();
  const cap: ModelCapabilities = {};
  const visionKw = ['vision', 'multimodal', 'image', 'gpt-4o', 'claude-3', 'gemini', 'o1', 'o3'];
  if (visionKw.some(kw => m.includes(kw))) cap.vision = true;
  const imageGenKw = ['image-generation', 'dalle', 'flux', 'imagen', 'image-gen', 'grok-imagine', 'gpt-image'];
  if (imageGenKw.some(kw => m.includes(kw))) cap.image_gen = true;
  const videoGenKw = ['video-generation', 'runway', 'sora', 'veo', 'video-gen', 'grok-imagine-1.0-video'];
  if (videoGenKw.some(kw => m.includes(kw))) cap.video_gen = true;
  const speechKw = ['tts', 'speech', 'voice', 'whisper'];
  if (speechKw.some(kw => m.includes(kw))) cap.speech_gen = true;
  const thinkingKw = ['thinking', 'reasoner', 'reasoning', 'o1-mini', 'o1-preview', 'o1', 'o3-mini', 'o3', 'deepseek-r1', 'r1', 'gemini-2.0-flash-thinking', 'gemini-exp', 'exp-'];
  if (thinkingKw.some(kw => m.includes(kw))) cap.thinking = true;
  return cap;
}

/** 合并后端/保存的 capabilities 与按模型名推断的能力（有一方为 true 即显示） */
export function getDisplayCapabilities(
  capabilities: ModelCapabilities | null | undefined,
  modelName?: string
): ModelCapabilities | null {
  const inferred = modelName ? inferCapabilitiesFromModelName(modelName) : {};
  const fromMeta = capabilities || {};
  const merged: ModelCapabilities = {
    vision: Boolean(fromMeta.vision || inferred.vision),
    image_gen: Boolean(fromMeta.image_gen || inferred.image_gen),
    video_gen: Boolean(fromMeta.video_gen || inferred.video_gen),
    speech_gen: Boolean(fromMeta.speech_gen || inferred.speech_gen),
    thinking: Boolean(fromMeta.thinking || inferred.thinking),
  };
  if (!merged.vision && !merged.image_gen && !merged.video_gen && !merged.speech_gen && !merged.thinking) return null;
  return merged;
}

export const CAPABILITY_TITLES: Record<keyof ModelCapabilities, string> = {
  vision: '是否识别图片',
  image_gen: '是否支持生图',
  video_gen: '是否支持生视频',
  speech_gen: '是否支持生语音',
  thinking: '是否为思考模型',
};
