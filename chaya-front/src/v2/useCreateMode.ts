import { useCallback, useState } from 'react';
import { mediaApi } from '../services/mediaApi';

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
  configId?: string;  // LLM config (Gemini)
  model?: string;
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

// Mirrors CreatePage SIZES (verified against Gemini nano-banana).
const ASPECT_CYCLE = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const COUNT_CYCLE = [1, 2, 4, 6, 8];

export function useCreateMode(initial?: Partial<CreateConfig>) {
  const [cfg, setCfg] = useState<CreateConfig>({
    style: initial?.style ?? '',
    aspect: initial?.aspect ?? '1:1',
    count: initial?.count ?? 4,
    negative: initial?.negative ?? '',
    configId: initial?.configId,
    model: initial?.model ?? 'gemini-2.5-flash-image',
  });
  const [refs, setRefs] = useState<RefImage[]>([]);

  const cycleAspect = () =>
    setCfg((c) => ({ ...c, aspect: ASPECT_CYCLE[(ASPECT_CYCLE.indexOf(c.aspect) + 1) % ASPECT_CYCLE.length] || '1:1' }));
  const cycleCount = () =>
    setCfg((c) => ({ ...c, count: COUNT_CYCLE[(COUNT_CYCLE.indexOf(c.count) + 1) % COUNT_CYCLE.length] || 1 }));
  const setStyle = (s: string) => setCfg((c) => ({ ...c, style: s }));
  const setNegative = (s: string) => setCfg((c) => ({ ...c, negative: s }));
  const setAspect = (a: string) => setCfg((c) => ({ ...c, aspect: a }));
  const setCount = (n: number) => setCfg((c) => ({ ...c, count: Math.max(1, Math.min(8, n)) }));
  const setModelConfig = (configId: string | undefined, model: string | undefined) =>
    setCfg((c) => ({ ...c, configId, model: model || c.model }));

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
  ): Promise<void> => {
    const hasRefs = refs.length > 0;

    // Rewriter only when there are no refs (edit path keeps prompt literal).
    let baseForCompose = basePrompt;
    if (!hasRefs && basePrompt.trim()) {
      try {
        const rewriteRes = await Promise.race<any>([
          mediaApi.geminiRewritePrompt({
            prompt: basePrompt.trim(),
            aspect_ratio: cfg.aspect,
            config_id: cfg.configId,
            model: cfg.model,
          }),
          new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        const expanded: string | undefined = rewriteRes?.prompt;
        if (expanded && expanded.trim().length > basePrompt.trim().length) {
          baseForCompose = expanded.trim();
        }
      } catch { /* fall back to raw */ }
    }

    const finalPrompt = composePrompt(baseForCompose);

    const oneCall = async (idx: number) => {
      try {
        const body: any = {
          prompt: finalPrompt,
          aspect_ratio: cfg.aspect,
          count: 1,
        };
        if (cfg.configId) body.config_id = cfg.configId;
        if (cfg.model) body.model = cfg.model;

        let res: any;
        if (hasRefs) {
          res = await mediaApi.geminiImageEdit({
            ...body,
            images_b64: refs.map((r) => r.data),
          });
        } else {
          res = await mediaApi.geminiImageGenerate(body);
        }
        if (res?.error) { onSlot(idx, null, res.error); return; }
        const media = Array.isArray(res?.media) ? res.media : [];
        const first = media[0] as any;
        const data: string | undefined = first?.data;
        const mime: string = first?.mimeType || first?.mime_type || 'image/png';
        if (!data) { onSlot(idx, null, '空结果'); return; }
        const dataUri = data.startsWith('data:') ? data : `data:${mime};base64,${data}`;
        onSlot(idx, dataUri);

        // persist for gallery; best-effort
        void mediaApi.saveOutput({
          data: dataUri,
          media_type: 'image',
          mime_type: mime,
          prompt: finalPrompt,
          provider: 'gemini',
          model: cfg.model,
          source: 'create-mode',
        }).catch(() => { /* ignore */ });
      } catch (e: any) {
        onSlot(idx, null, e?.message || String(e));
      }
    };

    await Promise.all(Array.from({ length: cfg.count }).map((_, i) => oneCall(i)));
  }, [cfg, refs, composePrompt]);

  return {
    cfg, refs,
    setStyle, setNegative, setAspect, setCount, setModelConfig,
    cycleAspect, cycleCount,
    addRefFromFile, removeRef, setRefDirective,
    composePrompt, generate,
  };
}

export const ASPECT_OPTIONS = ASPECT_CYCLE;
export const COUNT_OPTIONS = COUNT_CYCLE;

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
