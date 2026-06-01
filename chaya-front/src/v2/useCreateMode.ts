import { useCallback, useMemo, useState } from 'react';
import { mediaApi } from '../services/mediaApi';
import { getMediaModelCaps } from './mediaModelCaps';
import { useI18n } from '../i18n';

export interface RefImage {
  id: string;
  /** raw base64 (no data: prefix) */
  data: string;
  mimeType: string;
  directive: string;
  fileName?: string;
}

export interface CreateConfig {
  style: string;
  aspect: string;     // e.g. '1:1', '3:2', '16:9'
  count: number;      // 1..8
  negative: string;
  configId?: string;  // LLM config id
  model?: string;
  provider?: string;  // 'gemini' | 'openai' | ... — drives endpoint routing
}

export interface PendingBatch {
  /** synthetic message id used to render the assistant batch message */
  batchId: string;
  prompt: string;
  count: number;
  /** image data URIs as they come back; null while pending */
  slots: (string | null)[];
  pending: boolean;
}

// Default Gemini aspect list — kept for backward-compat re-exports.
const ASPECT_CYCLE = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const COUNT_CYCLE = [1, 2, 4, 6, 8];

export function useCreateMode(initial?: Partial<CreateConfig>) {
  const { t: tr } = useI18n();
  const [cfg, setCfg] = useState<CreateConfig>({
    style: initial?.style ?? '',
    aspect: initial?.aspect ?? '1:1',
    count: initial?.count ?? 4,
    negative: initial?.negative ?? '',
    configId: initial?.configId,
    model: initial?.model ?? 'gemini-2.5-flash-image',
  });
  const [refs, setRefs] = useState<RefImage[]>([]);

  const caps = useMemo(() => getMediaModelCaps(cfg.provider, cfg.model), [cfg.provider, cfg.model]);

  const cycleAspect = () =>
    setCfg((c) => {
      const list = getMediaModelCaps(c.provider, c.model).aspects;
      const i = list.indexOf(c.aspect);
      return { ...c, aspect: list[(i + 1) % list.length] || list[0] || '1:1' };
    });
  const cycleCount = () =>
    setCfg((c) => ({ ...c, count: COUNT_CYCLE[(COUNT_CYCLE.indexOf(c.count) + 1) % COUNT_CYCLE.length] || 1 }));
  const setStyle = (s: string) => setCfg((c) => ({ ...c, style: s }));
  const setNegative = (s: string) => setCfg((c) => ({ ...c, negative: s }));
  const setAspect = (a: string) => setCfg((c) => ({ ...c, aspect: a }));
  const setCount = (n: number) =>
    setCfg((c) => {
      const max = getMediaModelCaps(c.provider, c.model).maxCount;
      return { ...c, count: Math.max(1, Math.min(max, n)) };
    });
  /**
   * Switch model. If the new model doesn't support the current aspect, snap
   * to its default — otherwise the picker would show a stale value that the
   * backend will silently substitute. count is also clamped to the new max.
   */
  const setModelConfig = (configId: string | undefined, model: string | undefined, provider?: string) =>
    setCfg((c) => {
      const next = getMediaModelCaps(provider ?? c.provider, model || c.model);
      const aspect = next.aspects.includes(c.aspect) ? c.aspect : next.defaultAspect;
      const count = Math.min(c.count, next.maxCount);
      return { ...c, configId, model: model || c.model, provider: provider ?? c.provider, aspect, count };
    });

  const addRefFromFile = useCallback(async (file: File) => {
    const b64 = await fileToBase64(file);
    setRefs((rs) => [...rs, {
      id: `r-${Date.now()}-${rs.length}`,
      data: b64,
      mimeType: file.type || 'image/png',
      directive: '',
      fileName: file.name,
    }]);
  }, []);
  const removeRef = (id: string) => setRefs((rs) => rs.filter((r) => r.id !== id));
  /** Replace the entire refs list. Used by 重新生成 to restore the historical
   *  reference images into the create-mode ref strip on rerun. */
  const replaceRefs = (next: RefImage[]) => setRefs(next);
  const setRefDirective = (id: string, d: string) =>
    setRefs((rs) => rs.map((r) => (r.id === id ? { ...r, directive: d } : r)));

  /** Compose final prompt that travels to the model. Mirrors v1 CreatePage. */
  const composePrompt = useCallback((basePrompt: string): string => {
    const parts: string[] = [];
    if (basePrompt.trim()) parts.push(basePrompt.trim());
    if (cfg.style.trim()) parts.push(cfg.style.trim());
    if (cfg.negative.trim()) parts.push(`(avoid: ${cfg.negative.trim()})`);
    if (refs.length > 0) {
      const labels = refs.map((_, i) => `#${i + 1}`).join(' / ');
      parts.push(`(refs: ${labels})`);
      const perRef = refs
        .map((r, i) => (r.directive.trim() ? `#${i + 1}: ${r.directive.trim()}` : ''))
        .filter(Boolean);
      if (perRef.length > 0) parts.push(`(refs usage — ${perRef.join('; ')})`);
    }
    return parts.join('. ');
  }, [cfg.style, cfg.negative, refs]);

  /**
   * Generate `count` images in parallel, calling onSlot(i, dataUri) as each
   * resolves. Returns when all calls settle.
   */
  const generate = useCallback(async (
    basePrompt: string,
    onSlot: (idx: number, dataUri: string | null, error?: string) => void,
    /**
     * Optional override of the live hook state. Used by "重新生成" to fire a
     * batch from a *frozen* spec on a historical message, instead of whatever
     * the user has on screen right now. When `cfg`/`refs` are supplied here,
     * the corresponding closure values are ignored.
     */
    override?: { cfg?: Partial<CreateConfig>; refs?: RefImage[] },
    /**
     * Optional partial-image callback for OpenAI streaming. Fires 1-3 times
     * per slot before the final `onSlot`, with refinement frames. UI uses
     * these to show a progressive preview ("初稿 → 优化 → 终稿"); they are NOT
     * persisted (only the final from onSlot is saved).
     */
    onPartial?: (idx: number, dataUri: string) => void,
  ): Promise<void> => {
    const effCfg: CreateConfig = { ...cfg, ...(override?.cfg || {}) };
    const effRefs: RefImage[] = override?.refs ?? refs;
    const hasRefs = effRefs.length > 0;
    const providerKey = (effCfg.provider || '').toLowerCase();
    const modelKey = (effCfg.model || '').toLowerCase();
    const isOpenAI = providerKey === 'openai' || /gpt-image|dall-?e/.test(modelKey);

    // Rewriter is Gemini-specific (nano-banana paragraph prompt). Skip for
    // OpenAI to avoid burning Gemini quota and to preserve user's literal prompt.
    let baseForCompose = basePrompt;
    if (!isOpenAI && !hasRefs && basePrompt.trim()) {
      try {
        const rewriteRes = await Promise.race<any>([
          mediaApi.geminiRewritePrompt({
            prompt: basePrompt.trim(),
            aspect_ratio: effCfg.aspect,
            config_id: effCfg.configId,
            model: effCfg.model,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        const expanded: string | undefined = rewriteRes?.prompt;
        if (expanded && expanded.trim().length > basePrompt.trim().length) {
          baseForCompose = expanded.trim();
        }
      } catch { /* fall back to raw */ }
    }

    // Compose the final prompt using the *effective* refs / style so rerun
    // matches the original (composePrompt() reads the live state — bypass it
    // when an override is supplied).
    const finalPrompt = (override?.refs || override?.cfg)
      ? composePromptFrom(baseForCompose, effCfg, effRefs)
      : composePrompt(baseForCompose);

    const oneCall = async (idx: number) => {
      try {
        const body: any = {
          prompt: finalPrompt,
          aspect_ratio: effCfg.aspect,
          count: 1,
        };
        if (effCfg.configId) body.config_id = effCfg.configId;
        if (effCfg.model) body.model = effCfg.model;

        // OpenAI path uses SSE so the UI can paint partial frames before the
        // final image lands. gpt-image-2 can take 30-60s end-to-end; partials
        // arrive 1-3 times in between, which makes the wait feel responsive.
        if (isOpenAI) {
          const streamBody: any = { ...body, partial_images: 2 };
          if (hasRefs) streamBody.images_b64 = effRefs.map((r) => r.data);
          let finalUri: string | null = null;
          let finalMime = 'image/png';
          let errored = false;
          const handler = (e: any) => {
            if (e?.type === 'partial' && e?.data) {
              const mime = e.mimeType || 'image/png';
              const uri = `data:${mime};base64,${e.data}`;
              onPartial?.(idx, uri);
            } else if (e?.type === 'done' && e?.data) {
              finalMime = e.mimeType || 'image/png';
              finalUri = `data:${finalMime};base64,${e.data}`;
            } else if (e?.type === 'error') {
              errored = true;
              onSlot(idx, null, e?.message || 'stream error');
            }
          };
          if (hasRefs) {
            await mediaApi.openaiImageEditsStream(streamBody, handler);
          } else {
            await mediaApi.openaiImageGenerationsStream(streamBody, handler);
          }
          if (!finalUri && !errored) { onSlot(idx, null, tr('settings.create.noFinalImage')); return; }
          if (!finalUri) return; // error already reported
          onSlot(idx, finalUri);
          // NB: 不在这里 saveOutput —— OpenAI 流式后端在 `.completed` 事件里已把
          // 终稿落进 media_outputs（safety-net，source=…-stream-safety），见
          // media_openai.go。前端再存一次会让同一张图在画廊里出现两条。
          // Gemini 走请求/响应、后端不落库，仍由下方分支显式 saveOutput。
          return;
        }

        // Gemini path stays request/response (no streaming for nano-banana).
        let res: any;
        if (hasRefs) {
          res = await mediaApi.geminiImageEdit({
            ...body,
            images_b64: effRefs.map((r) => r.data),
          });
        } else {
          res = await mediaApi.geminiImageGenerate(body);
        }
        if (res?.error) { onSlot(idx, null, res.error); return; }
        const media = Array.isArray(res?.media) ? res.media : [];
        const first = media[0] as any;
        const data: string | undefined = first?.data;
        const mime: string = first?.mimeType || first?.mime_type || 'image/png';
        if (!data) { onSlot(idx, null, tr('settings.create.emptyResult')); return; }
        const dataUri = data.startsWith('data:') ? data : `data:${mime};base64,${data}`;
        onSlot(idx, dataUri);

        // persist for gallery; best-effort
        void mediaApi.saveOutput({
          data: dataUri,
          media_type: 'image',
          mime_type: mime,
          prompt: finalPrompt,
          provider: 'gemini',
          model: effCfg.model,
          source: 'create-mode',
        }).catch(() => { /* ignore */ });
      } catch (e: any) {
        onSlot(idx, null, e?.message || String(e));
      }
    };

    await Promise.all(Array.from({ length: effCfg.count }).map((_, i) => oneCall(i)));
  }, [cfg, refs, composePrompt, tr]);

  return {
    cfg, refs, caps,
    setStyle, setNegative, setAspect, setCount, setModelConfig,
    cycleAspect, cycleCount,
    addRefFromFile, removeRef, replaceRefs, setRefDirective,
    composePrompt, generate,
  };
}

export const ASPECT_OPTIONS = ASPECT_CYCLE;
export const COUNT_OPTIONS = COUNT_CYCLE;

/** Stateless variant of composePrompt used by `generate` with an override. */
function composePromptFrom(basePrompt: string, cfg: CreateConfig, refs: RefImage[]): string {
  const parts: string[] = [];
  if (basePrompt.trim()) parts.push(basePrompt.trim());
  if (cfg.style.trim()) parts.push(cfg.style.trim());
  if (cfg.negative.trim()) parts.push(`(avoid: ${cfg.negative.trim()})`);
  if (refs.length > 0) {
    const labels = refs.map((_, i) => `#${i + 1}`).join(' / ');
    parts.push(`(refs: ${labels})`);
    const perRef = refs
      .map((r, i) => (r.directive.trim() ? `#${i + 1}: ${r.directive.trim()}` : ''))
      .filter(Boolean);
    if (perRef.length > 0) parts.push(`(refs usage — ${perRef.join('; ')})`);
  }
  return parts.join('. ');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf('base64,');
      resolve(i >= 0 ? s.slice(i + 7) : s);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
