/**
 * Per-model media capabilities. Drives the aspect picker and any future
 * model-specific UI in create mode. Source of truth: OpenAI image-generation
 * guide (2026-05) + Gemini nano-banana imageConfig docs.
 */
import { t } from '../i18n';

export interface ModelCaps {
  /** Aspect labels exposed in the picker, in display order. */
  aspects: string[];
  /** Default aspect when the model is selected. */
  defaultAspect: string;
  /**
   * Optional hint shown next to the aspect chip — e.g. "无尺寸限制" for
   * gpt-image-2 vs "三种固定尺寸" for gpt-image-1. May return ''.
   */
  hint?: string;
  /** Max parallel images supported by `n` / our `count` slider. */
  maxCount: number;
}

const GEMINI_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
// gpt-image-2: any aspect where long/short ≤ 3 and dims are multiples of 16.
// Our preset list covers the common ones; 21:9 ≈ 2.33 fits in.
const GPT_IMAGE_2_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9', '9:21'];
// gpt-image-1: only 1024², 1536×1024, 1024×1536 → 1:1, 3:2, 2:3.
const GPT_IMAGE_1_ASPECTS = ['1:1', '3:2', '2:3'];
// dall-e-3: 1024², 1792×1024, 1024×1792 → 1:1, 16:9, 9:16 (closest labels).
const DALL_E_3_ASPECTS = ['1:1', '16:9', '9:16'];

export function getMediaModelCaps(provider?: string, model?: string): ModelCaps {
  const p = (provider || '').toLowerCase();
  const m = (model || '').toLowerCase();

  if (/gpt-image-2/.test(m)) {
    return { aspects: GPT_IMAGE_2_ASPECTS, defaultAspect: '1:1', hint: t('misc.caps.anyRatio'), maxCount: 8 };
  }
  if (/gpt-image-1/.test(m) || (p === 'openai' && /gpt-image/.test(m))) {
    return { aspects: GPT_IMAGE_1_ASPECTS, defaultAspect: '1:1', hint: t('misc.caps.threeFixedSizes'), maxCount: 4 };
  }
  if (/dall-?e-3/.test(m)) {
    return { aspects: DALL_E_3_ASPECTS, defaultAspect: '1:1', hint: '1024² / 1792×1024', maxCount: 1 };
  }
  // OpenAI generic fallback → assume newest family (gpt-image-2-ish).
  if (p === 'openai') {
    return { aspects: GPT_IMAGE_2_ASPECTS, defaultAspect: '1:1', hint: 'OpenAI', maxCount: 8 };
  }
  // Gemini / unknown → keep the legacy full set.
  return { aspects: GEMINI_ASPECTS, defaultAspect: '1:1', maxCount: 8 };
}
