import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { toast } from './ui/use-toast';
import { PaperPage, PaperTopbar, PaperContent } from './paper';
import { loadBlurredSet, saveBlurredSet, BLURRED_IMG_CSS } from '../utils/blurred';

/* ============================================================
   创作 / Atelier — aligned with mockups/a-create.html
   ============================================================ */

interface StylePreset {
  id: string;
  zh: string;
  en?: string;
  suffix: string;
  /** true = user-saved; false/undefined = built-in. */
  custom?: boolean;
}

const BUILTIN_STYLES: StylePreset[] = [
  { id: 'ink',    zh: '水墨',   en: 'INK',    suffix: 'chinese ink painting, traditional brushwork, on rice paper' },
  { id: 'oil',    zh: '油画',   en: 'OIL',    suffix: 'oil painting, thick impasto, classical composition' },
  { id: 'photo',  zh: '照片',   en: 'PHOTO',  suffix: 'photorealistic, 35mm film, natural lighting' },
  { id: 'sketch', zh: '素描',   en: 'SKETCH', suffix: 'graphite sketch on paper, loose strokes' },
  { id: 'illo',   zh: '插画',   en: 'ILLO',   suffix: 'editorial illustration, flat shapes, muted palette' },
  { id: 'jp',     zh: '日式',   en: 'JP',     suffix: 'Japanese woodblock print style, ukiyo-e influence' },
];

const LS_CUSTOM_STYLES = 'chaya_style_presets';

function loadCustomStyles(): StylePreset[] {
  try {
    const raw = localStorage.getItem(LS_CUSTOM_STYLES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.id === 'string' && typeof x.zh === 'string' && typeof x.suffix === 'string')
      .map((x) => ({ ...x, custom: true as const }));
  } catch { return []; }
}

function saveCustomStyles(list: StylePreset[]): void {
  try {
    const plain = list.map(({ id, zh, en, suffix }) => ({ id, zh, en, suffix }));
    localStorage.setItem(LS_CUSTOM_STYLES, JSON.stringify(plain));
  } catch { /* ignore */ }
}


/**
 * Aspect ratios supported by Gemini image models (gemini-2.5-flash-image
 * aka "nano-banana" and friends). Passed as-is to the REST
 * `generationConfig.imageConfig.aspectRatio` field — the backend does no
 * translation.
 */
const SIZES: { id: string; label: string; kind: 'square' | 'landscape' | 'portrait' }[] = [
  { id: '1:1',  label: '1:1',  kind: 'square' },
  { id: '4:3',  label: '4:3',  kind: 'landscape' },
  { id: '3:4',  label: '3:4',  kind: 'portrait' },
  { id: '16:9', label: '16:9', kind: 'landscape' },
  { id: '9:16', label: '9:16', kind: 'portrait' },
  { id: '3:2',  label: '3:2',  kind: 'landscape' },
  { id: '2:3',  label: '2:3',  kind: 'portrait' },
  { id: '21:9', label: '21:9', kind: 'landscape' },
];

interface Batch {
  id: string;
  prompt: string;
  style: string;
  model: string;
  aspect: string;
  items: (MediaOutputItem | null)[]; // null = in-progress slot
  createdAt: number;
  pending: boolean;
}

interface RefImage {
  id: string;
  dataUrl: string;     // data:*;base64,... for previews
  data: string;        // raw base64 (no prefix) for API
  mimeType: string;
  name: string;
  source: 'upload' | 'paste' | 'gallery' | 'remix';
  /** Per-image directive. E.g. "#1: 用它的脸" */
  directive: string;
}

const MAX_REF_IMAGES = 6;
const MAX_REF_BYTES = 10 * 1024 * 1024;

const readAsDataUrl = (file: File | Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const CreatePage: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [styleId, setStyleId] = useState('');
  /** Editable free-form style suffix. Starts synced with the preset,
   *  but user can rewrite / extend. */
  const [styleText, setStyleText] = useState<string>('');
  const [customStyles, setCustomStyles] = useState<StylePreset[]>(() => loadCustomStyles());
  const [blurredIds, setBlurredIds] = useState<Set<string>>(() => loadBlurredSet());
  const toggleBlur = (outputId: string) => {
    setBlurredIds((prev) => {
      const next = new Set(prev);
      if (next.has(outputId)) next.delete(outputId);
      else next.add(outputId);
      saveBlurredSet(next);
      return next;
    });
  };
  const [styleSaveOpen, setStyleSaveOpen] = useState(false);
  const [styleSaveName, setStyleSaveName] = useState('');
  const [sizeId, setSizeId] = useState('1:1');
  const [count, setCount] = useState(4);
  /** Selected config id (= llm_configs.id). Empty = none selected yet. */
  const [selectedConfigId, setSelectedConfigId] = useState<string>('');
  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recentOutputs, setRecentOutputs] = useState<MediaOutputItem[]>([]);
  const [inflight, setInflight] = useState(0);
  const submitting = inflight > 0;

  const [refImages, setRefImages] = useState<RefImage[]>([]);
  const [lightbox, setLightbox] = useState<RefImage | null>(null);
  /** Preview dialog for plates in the result grid. */
  const [preview, setPreview] = useState<MediaOutputItem | null>(null);
  /** Which chip's drawer is currently expanded under the chip bar. */
  type DrawerKey = 'style' | 'size' | 'model' | 'count' | 'neg' | 'refs';
  const [openDrawer, setOpenDrawer] = useState<DrawerKey | null>(null);
  const toggleDrawer = (k: DrawerKey) => setOpenDrawer((cur) => (cur === k ? null : k));
  const refFileInput = useRef<HTMLInputElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const styleSectionRef = useRef<HTMLDivElement>(null);
  const refsSectionRef = useRef<HTMLDivElement>(null);

  const location = useLocation();
  const navigate = useNavigate();

  const loadConfigs = useCallback(async () => {
    try {
      const list = await getLLMConfigs();
      // Only Gemini providers support image gen right now, and only the ones
      // marked "创作可见" in ModelsPage should show up here.
      const usable = list.filter((c) => c.enabled && c.media_visible && c.provider === 'gemini');
      setConfigs(usable);
      // Auto-select first if nothing picked yet — or if the previously picked
      // one no longer qualifies (user removed media_visible).
      setSelectedConfigId((prev) => {
        if (prev && usable.some((c) => c.config_id === prev)) return prev;
        return usable[0]?.config_id || '';
      });
    } catch {/* */}
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const data = await mediaApi.listOutputs(20, 0);
      setRecentOutputs(data.items || []);
    } catch {/* */}
  }, []);

  /* ---------- reference images ---------- */

  /* ---------- style presets: custom + builtin ---------- */

  const allStyles: StylePreset[] = useMemo(
    () => [...BUILTIN_STYLES, ...customStyles],
    [customStyles],
  );

  const styleAlreadySaved = useMemo(() => {
    const t = styleText.trim();
    if (!t) return false;
    return allStyles.some((s) => s.suffix.trim() === t);
  }, [styleText, allStyles]);

  /** Short label for the style chip shown next to the prompt:
   *  prefer the saved preset's zh name, else first few English words, else "自定义"。 */
  const currentStyleLabel: string = useMemo(() => {
    const t = styleText.trim();
    if (!t) return '';
    const match = allStyles.find((s) => s.suffix.trim() === t);
    if (match) return match.zh;
    const firstWords = t.split(/[,，.。]/)[0].trim();
    return firstWords.length > 14 ? firstWords.slice(0, 14) + '…' : (firstWords || '自定义');
  }, [styleText, allStyles]);

  const openSaveStyle = () => {
    if (!styleText.trim()) {
      toast({ title: '写点风格先', description: '上面的 textarea 空着，存什么？', variant: 'destructive' });
      return;
    }
    if (styleAlreadySaved) {
      toast({ title: '这个已经存过了' });
      return;
    }
    setStyleSaveName('');
    setStyleSaveOpen(true);
  };

  const saveStyle = () => {
    const name = styleSaveName.trim();
    if (!name) { toast({ title: '给它起个名字', variant: 'destructive' }); return; }
    const suffix = styleText.trim();
    if (!suffix) { setStyleSaveOpen(false); return; }
    const id = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const next: StylePreset = { id, zh: name, suffix, custom: true };
    const list = [...customStyles, next];
    setCustomStyles(list);
    saveCustomStyles(list);
    setStyleId(id);
    setStyleSaveOpen(false);
    setStyleSaveName('');
    toast({ title: `存好了「${name}」`, variant: 'success' });
  };

  const removeCustomStyle = (id: string) => {
    const target = customStyles.find((s) => s.id === id);
    if (!target) return;
    if (!confirm(`删掉「${target.zh}」？`)) return;
    const list = customStyles.filter((s) => s.id !== id);
    setCustomStyles(list);
    saveCustomStyles(list);
    if (styleId === id) setStyleId('');
    toast({ title: '删了' });
  };

  const addRefBlob = useCallback(async (
    blob: Blob,
    name: string,
    source: RefImage['source'],
  ): Promise<boolean> => {
    if (refImages.length >= MAX_REF_IMAGES) {
      toast({ title: '最多 6 张参考图', variant: 'destructive' });
      return false;
    }
    if (blob.size > MAX_REF_BYTES) {
      toast({ title: `"${name}" 太大`, description: '单张不超过 10 MB', variant: 'destructive' });
      return false;
    }
    try {
      const dataUrl = await readAsDataUrl(blob);
      const base64 = dataUrl.split(',', 2)[1] || '';
      const mime = blob.type || 'image/png';
      setRefImages((prev) => [...prev, {
        id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        dataUrl,
        data: base64,
        mimeType: mime,
        name,
        source,
        directive: '',
      }]);
      return true;
    } catch {
      toast({ title: `读不了 "${name}"`, variant: 'destructive' });
      return false;
    }
  }, [refImages.length]);

  const pickRefFiles = () => refFileInput.current?.click();

  const handleRefFilesPicked = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = ev.target.files ? Array.from(ev.target.files) : [];
    ev.target.value = '';
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      const ok = await addRefBlob(f, f.name, 'upload');
      if (!ok) break;
    }
  };

  const removeRef = (id: string) => setRefImages((prev) => prev.filter((r) => r.id !== id));

  const setRefDirective = (id: string, directive: string) =>
    setRefImages((prev) => prev.map((r) => (r.id === id ? { ...r, directive } : r)));

  const moveRef = (id: string, dir: -1 | 1) => {
    setRefImages((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });
  };

  /** Paste from clipboard on the prompt textarea → attach as reference image. */
  const handlePromptPaste = async (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = ev.clipboardData?.items;
    if (!items) return;
    const blobs: Blob[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const b = it.getAsFile();
        if (b) blobs.push(b);
      }
    }
    if (blobs.length > 0) {
      ev.preventDefault();
      for (let i = 0; i < blobs.length; i += 1) {
        const b = blobs[i];
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const ext = (b.type.split('/')[1] || 'png').replace(/\W/g, '');
        const ok = await addRefBlob(b, `pasted-${ts}.${ext}`, 'paste');
        if (!ok) break;
      }
    }
  };

  /** Fetch a gallery item and attach as reference (used for remix + gallery picker). */
  const addRefFromGallery = async (item: MediaOutputItem): Promise<boolean> => {
    try {
      const url = mediaApi.getOutputFileUrl(item.output_id);
      const token = localStorage.getItem('chaya_token') || '';
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = (item.prompt || item.output_id).slice(0, 40) || `gallery-${item.output_id.slice(0, 6)}`;
      return addRefBlob(blob, name, 'gallery');
    } catch (e: any) {
      toast({ title: '拿不到这张', description: e?.message || '', variant: 'destructive' });
      return false;
    }
  };

  /* ---------- remix intake: from GalleryPage → /create with state ---------- */

  useEffect(() => {
    const st = location.state as { remix?: MediaOutputItem } | null;
    if (!st?.remix) return;
    const item = st.remix;
    // Clear state immediately so refresh doesn't re-add
    navigate(location.pathname, { replace: true, state: null });
    void (async () => {
      const ok = await addRefFromGallery(item);
      if (ok) {
        if (item.prompt) setPrompt(item.prompt);
        toast({ title: '已带入参考图', description: '改两句再寄出' });
        requestAnimationFrame(() => promptTextareaRef.current?.focus());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  useEffect(() => {
    void loadConfigs();
    void loadRecent();
  }, [loadConfigs, loadRecent]);

  /** The picked LLM config — real DB row, not a registry entry. */
  const selectedConfig = configs.find((c) => c.config_id === selectedConfigId) || null;
  /** Display label for meta (falls back to registry match if config not picked). */
  const selectedModelLabel = selectedConfig
    ? (selectedConfig.shortname || selectedConfig.model || selectedConfig.name)
    : '';

  const costEstimate = count * 0.2;

  /**
   * Compose the final prompt for display/preview (and as the batch's stored
   * "prompt" label). The actual submit path in handleSubmit does the same
   * composition but slips a (potentially rewritten) base in front of `base`,
   * so style/negative/refs always survive the rewriter intact.
   *
   * Order of equal-weight parts:
   *   1) user prompt (the base)
   *   2) style suffix (preset or free-form)
   *   3) (avoid: <negative>)         ← negative
   *   4) (refs: #1 / #2 / …)         ← which numbers refer to which image
   *   5) (refs usage — #1: …; #2: …) ← per-image directive
   *
   * Refs (4,5) only attach when refImages.length > 0; same when the
   * directive text exists.
   */
  const composePrompt = useCallback(
    (baseOverride?: string) => {
      const base = (baseOverride ?? prompt).trim();
      if (!base) return '';
      const parts: string[] = [base];
      const style = styleText.trim();
      if (style) parts.push(style);
      if (negative.trim()) parts.push(`(avoid: ${negative.trim()})`);
      if (refImages.length > 0) {
        const labels = refImages.map((_, i) => `#${i + 1}`).join(' / ');
        parts.push(`(refs: ${labels})`);
        const perRef = refImages
          .map((r, i) => {
            const d = r.directive.trim();
            return d ? `#${i + 1}: ${d}` : '';
          })
          .filter(Boolean);
        if (perRef.length > 0) parts.push(`(refs usage — ${perRef.join('; ')})`);
      }
      return parts.join('. ');
    },
    [prompt, styleText, negative, refImages],
  );

  const finalPromptForSubmit = useMemo(() => composePrompt(), [composePrompt]);

  const handleDelete = async (outputId: string) => {
    if (!outputId) return;
    if (!window.confirm('这张作品要撕掉吗？撕了就找不回来了。')) return;
    try {
      await mediaApi.deleteOutput(outputId);
      setRecentOutputs((prev) => prev.filter((o) => o.output_id !== outputId));
      setBlurredIds((prev) => {
        if (!prev.has(outputId)) return prev;
        const next = new Set(prev);
        next.delete(outputId);
        saveBlurredSet(next);
        return next;
      });
      setBatches((prev) =>
        prev
          .map((b) => ({
            ...b,
            items: b.items.map((it) => (it && it.output_id === outputId ? null : it)),
          }))
          .filter((b) => b.pending || b.items.some((it) => it !== null)),
      );
      toast({ title: '已撕掉', variant: 'success' });
    } catch (e: any) {
      toast({ title: '撕不掉', description: e?.message || String(e), variant: 'destructive' });
    }
  };

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      toast({ title: '写点东西', description: '左上"你想画什么"先写几句', variant: 'default' });
      return;
    }
    // Use the user's picked config (or auto-first gemini).
    const config = selectedConfig || configs[0];
    if (!config) {
      toast({
        title: '还没有创作可用的模型',
        description: '去「模型」里接一个 Gemini 配置，勾选「创作可见」。',
        variant: 'destructive',
      });
      return;
    }
    if (config.provider !== 'gemini') {
      toast({
        title: `"${config.provider}" 还不支持`,
        description: '目前只接了 Gemini 生图。',
        variant: 'destructive',
      });
      return;
    }

    const modelForSubmit = config.model || config.shortname || undefined;
    const isEdit = refImages.length > 0;
    /** Display label for the batch — full composed prompt for clarity. */
    const userPromptForSubmit = finalPromptForSubmit;
    const batchId = `b-${Date.now()}`;
    const newBatch: Batch = {
      id: batchId,
      prompt: userPromptForSubmit,
      style: styleId,
      model: modelForSubmit || 'gemini-image',
      aspect: sizeId,
      items: new Array(count).fill(null),
      createdAt: Date.now(),
      pending: true,
    };
    setBatches((prev) => [newBatch, ...prev]);
    setInflight((n) => n + 1);

    /**
     * Auto-rewrite the user's short idea into a nano-banana-friendly paragraph
     * via gemini-2.5-flash. CRITICAL: we send ONLY the bare user prompt to the
     * rewriter (not the composed string), because the rewriter is a generative
     * LLM that has historically silently dropped or warped (avoid: …) negatives
     * and embedded style suffixes. By rewriting just the base text and re-
     * attaching style / negative / per-ref directives after, every piece of
     * user input arrives at the image API with equal weight. Skip the rewrite
     * entirely on edits because the user's directive is relative to the ref
     * images and rewriting it would change meaning.
     */
    let basePromptOut = prompt.trim();
    if (!isEdit && basePromptOut) {
      try {
        const REWRITE_TIMEOUT_MS = 6000;
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS),
        );
        const rewrite = mediaApi
          .geminiRewritePrompt({
            prompt: basePromptOut,
            aspect_ratio: sizeId,
            config_id: config.config_id,
          })
          .then((r) => (r.error ? null : (r.prompt || '').trim() || null))
          .catch(() => null);
        const rewritten = await Promise.race([rewrite, timeout]);
        if (rewritten && rewritten.length > 20) {
          basePromptOut = rewritten;
        }
      } catch { /* fall back to user prompt */ }
    }
    // Reassemble with the (possibly rewritten) base; style/negative/refs
    // are guaranteed to survive intact.
    const promptForSubmit = composePrompt(basePromptOut);

    // Fire N parallel calls, but settle them ONE AT A TIME into the batch.
    // As each plate finishes we (a) immediately persist via saveOutput and
    // (b) drop it into its slot, so the user watches the result appear plate-
    // by-plate instead of waiting for the whole batch.
    type InlineMedia = { mimeType?: string; data?: string };
    const modelUsed = modelForSubmit || 'gemini-image';

    const oneCall = (idx: number) => (async () => {
      try {
        const res = await (isEdit
          ? mediaApi.geminiImageEdit({
              prompt: promptForSubmit,
              images_b64: refImages.map((r) => r.data),
              config_id: config.config_id,
              model: modelForSubmit,
              aspect_ratio: sizeId,
              count: 1,
            })
          : mediaApi.geminiImageGenerate({
              prompt: promptForSubmit,
              config_id: config.config_id,
              model: modelForSubmit,
              aspect_ratio: sizeId,
              count: 1,
            }));
        if (res.error) throw new Error(res.error);
        const media = Array.isArray(res.media) ? (res.media as InlineMedia[]) : [];
        const m = media[0];
        if (!m?.data) throw new Error('后端没返回图像（可能 provider 没配或模型不对）');
        const saved = await mediaApi.saveOutput({
          data: m.data,
          media_type: 'image',
          mime_type: m.mimeType || 'image/png',
          prompt: promptForSubmit,
          model: modelUsed,
          provider: 'gemini',
          source: isEdit ? 'edit' : 'generate',
          metadata: {
            aspect_ratio: sizeId,
            style_preset: styleId,
            style_text: styleText,
            ref_count: refImages.length,
          },
        });
        // Drop the freshly-saved plate into its slot. Other slots untouched.
        setBatches((prev) =>
          prev.map((b) =>
            b.id === batchId
              ? { ...b, items: b.items.map((it, i) => (i === idx ? saved : it)) }
              : b,
          ),
        );
        return { ok: true as const };
      } catch (e: any) {
        // Mark this slot as failed (we still leave it null but stop showing it
        // as pending in the UI by setting pending=false on the batch when the
        // last task completes).
        return { ok: false as const, err: e?.message || String(e) };
      }
    })();

    try {
      const outcomes = await Promise.all(Array.from({ length: count }, (_, i) => oneCall(i)));
      const okCount = outcomes.filter((o) => o.ok).length;
      // Close the pending state — any still-null slots become "didn't make it".
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, pending: false } : b)),
      );
      if (okCount === 0) {
        const firstErr = (outcomes.find((o) => !o.ok) as any)?.err || '都没画出来';
        toast({
          title: isEdit ? '改不出来' : '画不出来',
          description: firstErr,
          variant: 'destructive',
        });
      } else {
        toast({
          title: isEdit ? '改完了' : '画完了',
          description: `${okCount} / ${count} 张入库`,
          variant: okCount === count ? 'success' : 'default',
        });
      }
      void loadRecent();
    } finally {
      setInflight((n) => Math.max(0, n - 1));
    }
  };

  // Group recent outputs into "done" batches by prompt similarity + timestamp window.
  /**
   * Flatten everything into a single tile list for the dense 20-image grid:
   *   - in-flight pending slots first (so the user sees streaming progress)
   *   - then completed images from in-flight batches (newest first)
   *   - then recentOutputs from the server, skipping any already shown above
   * Capped at 20 tiles.
   */
  type Tile =
    | { kind: 'pending'; key: string; slot: number }
    | { kind: 'done'; key: string; item: MediaOutputItem };
  const recentTiles: Tile[] = useMemo(() => {
    const tiles: Tile[] = [];
    const seen = new Set<string>();
    for (const b of batches) {
      b.items.forEach((it, i) => {
        if (it === null) {
          if (b.pending) tiles.push({ kind: 'pending', key: `${b.id}-${i}`, slot: i + 1 });
        } else {
          if (!seen.has(it.output_id)) {
            seen.add(it.output_id);
            tiles.push({ kind: 'done', key: it.output_id, item: it });
          }
        }
      });
    }
    for (const o of recentOutputs) {
      if (seen.has(o.output_id)) continue;
      seen.add(o.output_id);
      tiles.push({ kind: 'done', key: o.output_id, item: o });
    }
    return tiles.slice(0, 20);
  }, [batches, recentOutputs]);

  const liveSlotsTotal = batches.reduce(
    (n, b) => n + (b.pending ? b.items.length : 0),
    0,
  );
  const liveSlotsDone = batches.reduce(
    (n, b) => n + (b.pending ? b.items.filter((it) => it !== null).length : 0),
    0,
  );
  const isStreaming = submitting && liveSlotsTotal > 0;

  const chipValStyle = currentStyleLabel || '（无）';
  const chipValModel = selectedModelLabel || (configs.length === 0 ? '未配' : '未选');
  const chipValNeg = negative.trim() ? '已写' : '（空）';

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Five · Atelier"
        title="画一张"
        subtitle="上面写词，下面挑工具。一张画好就贴出来一张。"
        meta={selectedConfig ? `${selectedModelLabel} · ${sizeId}` : '未选模型'}
      />

      <PaperContent noPad>
        <div style={s.v2Layout}>
          {/* ============ LEFT — COMPOSER ============ */}
          <section style={s.v2Composer}>
            {/* THE PAPER — fills available height with the writing surface */}
            <div style={s.v4Paper}>
              <div style={s.v4Folio}>
                <span style={s.v2EyebrowLbl}>你想画什么</span>
                <span style={s.v2EyebrowHint}>
                  {refImages.length > 0 ? '用 #1 #2 指代参考图 · 写得越具体越稳' : '写得越具体越稳'}
                </span>
                <span style={s.v4FolioNo}>— 第三页 —</span>
              </div>
              <div style={s.v4Surface}>
                <textarea
                  ref={promptTextareaRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onPaste={handlePromptPaste}
                  placeholder={
                    refImages.length > 0
                      ? '例：把 #1 的脸用 #2 的笔触画出来；#3 是参考的构图。'
                      : '例：一间藏在巷子里的小茶馆，门口挂着一块木牌写着「慢」。午后的光从窗帘缝里斜斜进来，老木头桌面上搁着一把紫砂壶和两只没喝完的茶杯。'
                  }
                  style={s.v4PromptText}
                />
              </div>
              <aside style={s.v4Marginalia}>
                <h5 style={s.v4MargH5}>— 旁注 —</h5>
                <p style={s.v4MargP}>写一句也行，写半页也行。<span style={s.v4MargEm}>具体的小东西</span>比形容词管用。</p>
                <span style={s.v4MargRule} />
                <p style={s.v4MargP}>想换风格？点底下的 <span style={s.v4MargKbd}>风格</span>。</p>
                <p style={s.v4MargP}>有图想做参考？拖进来，或按 <span style={s.v4MargKbd}>⌘V</span> 粘贴。</p>
                <span style={s.v4MargRule} />
                <p style={s.v4MargP}>觉得画出来不对？再写两句，或从作品集挑一张做<span style={s.v4MargEm}>二创</span>。</p>
                <svg style={{ marginTop: 18, opacity: 0.5 }} width="120" height="20" viewBox="0 0 120 20" fill="none">
                  <path d="M2 10 Q 30 2, 60 10 T 118 10" stroke="var(--accent-ink)" strokeWidth="0.8" fill="none"/>
                  <circle cx="60" cy="10" r="1.5" fill="var(--accent-ink)"/>
                </svg>
              </aside>
            </div>

            {/* ============ BOTTOM DOCK — refs + drawer + actions ============ */}
            <div style={s.v4Dock}>
              {/* REFS STRIP — always-visible directive pills */}
              <div style={s.v4Refs} ref={refsSectionRef}>
                <span style={s.v2RefsLbl}>
                  {refImages.length > 0 ? `参考 · ${refImages.length}` : '参考'}
                </span>
                <div style={s.v2RefsRow}>
                  {refImages.map((r, i) => (
                    <div
                      key={r.id}
                      style={{
                        ...s.v4RefPill,
                        ...(r.directive.trim() ? s.v4RefPillHasDir : null),
                      }}
                    >
                      <button
                        type="button"
                        style={s.v4RefPillThumb}
                        onClick={() => setLightbox(r)}
                        title={`${r.name}（点开看大图）`}
                      >
                        <img src={r.dataUrl} alt="" style={s.v2RefImg} />
                        <span style={s.v2RefHash}>#{i + 1}</span>
                      </button>
                      <div style={s.v4RefPillBody}>
                        <textarea
                          value={r.directive}
                          onChange={(e) => setRefDirective(r.id, e.target.value)}
                          placeholder={`#${i + 1} 怎么用：例「用它的脸」「只取背景」`}
                          rows={2}
                          style={s.v4RefPillInput}
                        />
                        <div style={s.v4RefPillFoot}>
                          <span style={s.v4RefPillSrc}>
                            {r.source === 'gallery' ? '作品集'
                             : r.source === 'paste' ? '粘贴'
                             : r.source === 'remix' ? '二创'
                             : '本地'}
                          </span>
                          <div style={s.v4RefPillActs}>
                            {i > 0 && (
                              <button type="button" style={s.v4RefPillBtn}
                                onClick={() => moveRef(r.id, -1)} title="往前">‹</button>
                            )}
                            {i < refImages.length - 1 && (
                              <button type="button" style={s.v4RefPillBtn}
                                onClick={() => moveRef(r.id, 1)} title="往后">›</button>
                            )}
                            <button type="button"
                              style={{ ...s.v4RefPillBtn, ...s.v4RefPillBtnDel }}
                              onClick={() => removeRef(r.id)} title="移除">×</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {refImages.length < MAX_REF_IMAGES && (
                    <button type="button" style={s.v4RefAdd} onClick={pickRefFiles}>
                      <span style={s.v2RefAddPlus}>＋</span>
                      <span style={s.v2RefAddT}>加参考</span>
                    </button>
                  )}
                </div>
                <input
                  ref={refFileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: 'none' }}
                  onChange={handleRefFilesPicked}
                />
              </div>

            {/* DRAWER — expands inline under chips when one is selected */}
            {openDrawer === 'style' && (
              <div style={s.v2Drawer} ref={styleSectionRef}>
                <div style={s.v2DrawerHead}>
                  <h4 style={s.v2DrawerH4}>风格 · 笔触</h4>
                  <span style={s.v2DrawerDesc}>点预设当起点；随便改；满意了存下来下次用。</span>
                </div>
                <div style={s.v2StyleGrid}>
                  <div>
                    <textarea
                      value={styleText}
                      onChange={(e) => { setStyleText(e.target.value); setStyleId(''); }}
                      rows={3}
                      placeholder="描述你想要的风格，例：watercolor, soft edges, muted palette"
                      style={s.v2StyleText}
                    />
                    <div style={s.v2StyleBtnRow}>
                      <button type="button" onClick={openSaveStyle}
                        disabled={!styleText.trim() || styleAlreadySaved}
                        style={{ ...s.v2StyleSave,
                          ...(!styleText.trim() || styleAlreadySaved ? s.v2StyleSaveDis : null) }}
                      >{styleAlreadySaved ? '已存' : '存为预设'}</button>
                      {(styleText || styleId) && (
                        <button type="button"
                          onClick={() => { setStyleId(''); setStyleText(''); }}
                          style={s.v2StyleClear}
                        >清空</button>
                      )}
                    </div>
                    {styleSaveOpen && (
                      <div style={s.v2StyleSaveForm}>
                        <input
                          type="text"
                          value={styleSaveName}
                          onChange={(e) => setStyleSaveName(e.target.value)}
                          placeholder="起名，例：我的水彩 / 80s 海报"
                          style={s.v2StyleSaveInput}
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveStyle(); } }}
                        />
                        <button type="button" onClick={saveStyle} style={s.v2StyleSaveOK}>存</button>
                        <button type="button" onClick={() => setStyleSaveOpen(false)} style={s.v2StyleSaveCancel}>取消</button>
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={s.v2PresetGroup}>内置</div>
                    <div style={s.v2PresetRow}>
                      {BUILTIN_STYLES.map((st) => {
                        const active = st.id === styleId;
                        return (
                          <button key={st.id} type="button"
                            onClick={() => { setStyleId(st.id); setStyleText(st.suffix); }}
                            style={{ ...s.v2Pill, ...(active ? s.v2PillOn : null) }}
                            title={st.suffix}>{st.zh}</button>
                        );
                      })}
                    </div>
                    {customStyles.length > 0 && (
                      <>
                        <div style={s.v2PresetGroup}>我的</div>
                        <div style={s.v2PresetRow}>
                          {customStyles.map((st) => {
                            const active = st.id === styleId;
                            return (
                              <div key={st.id} style={{ ...s.v2Pill, ...s.v2PillMine,
                                ...(active ? s.v2PillOn : null) }}>
                                <button type="button"
                                  onClick={() => { setStyleId(st.id); setStyleText(st.suffix); }}
                                  style={s.v2PillMinePick} title={st.suffix}>{st.zh}</button>
                                <button type="button"
                                  onClick={() => removeCustomStyle(st.id)}
                                  style={s.v2PillMineDel}
                                  aria-label="删掉这个预设" title="删">×</button>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {openDrawer === 'size' && (
              <div style={s.v2Drawer}>
                <div style={s.v2DrawerHead}>
                  <h4 style={s.v2DrawerH4}>尺寸</h4>
                  <span style={s.v2DrawerDesc}>Gemini 支持的画幅比例。</span>
                </div>
                <div style={s.v2SizeGrid}>
                  {SIZES.map((sz) => (
                    <button key={sz.id} type="button"
                      onClick={() => setSizeId(sz.id)}
                      style={{ ...s.v2SizeChip, ...(sz.id === sizeId ? s.v2SizeChipSel : null) }}>
                      <span style={{
                        ...s.v2SizePreview,
                        ...sizeDim(sz.kind),
                        ...(sz.id === sizeId ? { background: 'var(--paper)' } : null),
                      }} />
                      {sz.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {openDrawer === 'model' && (
              <div style={s.v2Drawer}>
                <div style={s.v2DrawerHead}>
                  <h4 style={s.v2DrawerH4}>模型</h4>
                  <span style={s.v2DrawerDesc}>
                    {configs.length === 0
                      ? '没有「创作可见」的 Gemini 配置。'
                      : `${configs.length} 个可选 · 只显示在「模型」勾选了「创作可见」的。`}
                  </span>
                </div>
                {configs.length === 0 ? (
                  <div style={s.v2ModelEmpty}>
                    <ol style={s.v2ModelSteps}>
                      <li>去「模型」章节，"+ 接一家" 接入 Gemini provider</li>
                      <li>在要用的模型上勾「✓ 创作」</li>
                      <li>回这里选它</li>
                    </ol>
                    <button type="button" style={s.v2ModelGoto} onClick={() => navigate('/models')}>
                      去模型 →
                    </button>
                  </div>
                ) : (
                  <div style={s.v2ModelRow}>
                    {configs.map((c) => {
                      const active = c.config_id === selectedConfigId;
                      const label = c.shortname || c.model || c.name;
                      return (
                        <button key={c.config_id} type="button"
                          onClick={() => setSelectedConfigId(c.config_id)}
                          style={{ ...s.v2Pill, ...(active ? s.v2PillOn : null) }}
                          title={`${c.name} · ${c.provider}${c.model ? ' · ' + c.model : ''}`}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {openDrawer === 'count' && (
              <div style={s.v2Drawer}>
                <div style={s.v2DrawerHead}>
                  <h4 style={s.v2DrawerH4}>每次画几张</h4>
                  <span style={s.v2DrawerDesc}>1 张最快 · 4 张最稳。多的会更挑模型脾气。</span>
                </div>
                <div style={s.v2CountRow}>
                  {[1, 2, 4, 8].map((n) => (
                    <button key={n} type="button"
                      onClick={() => setCount(n)}
                      style={{ ...s.v2CountChip, ...(count === n ? s.v2CountChipOn : null) }}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {openDrawer === 'neg' && (
              <div style={s.v2Drawer}>
                <div style={s.v2DrawerHead}>
                  <h4 style={s.v2DrawerH4}>不要</h4>
                  <span style={s.v2DrawerDesc}>可选。列几样不想出现的东西。</span>
                </div>
                <textarea
                  value={negative}
                  onChange={(e) => setNegative(e.target.value)}
                  rows={2}
                  placeholder="别的人、文字水印、漫画风…"
                  style={s.v2NegText}
                />
              </div>
            )}

            {/* ACTIONS ROW — chips + cost + send all on one line */}
            <div style={s.v4Actions}>
              <div style={s.v4ChipGroup}>
                <button type="button"
                  style={{ ...s.v2Chip, ...(openDrawer === 'style' ? s.v2ChipOpen : null),
                           ...(currentStyleLabel ? s.v2ChipActive : null) }}
                  onClick={() => toggleDrawer('style')}>
                  <span style={s.v2ChipK}>风格</span>
                  <span style={{ ...s.v2ChipV, ...(!currentStyleLabel ? s.v2ChipVEmpty : null) }}>
                    {chipValStyle}
                  </span>
                </button>
                <button type="button"
                  style={{ ...s.v2Chip, ...(openDrawer === 'size' ? s.v2ChipOpen : null) }}
                  onClick={() => toggleDrawer('size')}>
                  <span style={s.v2ChipK}>尺寸</span>
                  <span style={s.v2ChipV}>{sizeId}</span>
                </button>
                <button type="button"
                  title={chipValModel}
                  style={{ ...s.v2Chip, ...(openDrawer === 'model' ? s.v2ChipOpen : null),
                           ...(configs.length === 0 ? s.v2ChipErr : null) }}
                  onClick={() => toggleDrawer('model')}>
                  <span style={s.v2ChipK}>模型</span>
                  <span style={{ ...s.v2ChipV, ...(configs.length === 0 ? s.v2ChipVErr : null) }}>
                    {chipValModel}
                  </span>
                </button>
                <button type="button"
                  style={{ ...s.v2Chip, ...(openDrawer === 'count' ? s.v2ChipOpen : null) }}
                  onClick={() => toggleDrawer('count')}>
                  <span style={s.v2ChipK}>×</span>
                  <span style={s.v2ChipV}>{count}</span>
                </button>
                <button type="button"
                  style={{ ...s.v2Chip, ...(openDrawer === 'neg' ? s.v2ChipOpen : null) }}
                  onClick={() => toggleDrawer('neg')}>
                  <span style={s.v2ChipK}>不要</span>
                  <span style={{ ...s.v2ChipV, ...(!negative.trim() ? s.v2ChipVEmpty : null) }}>
                    {chipValNeg}
                  </span>
                </button>
              </div>
              <span style={s.v4CostPill}>
                {count} × ¥0.20 = <strong style={s.v4CostStrong}>¥{costEstimate.toFixed(2)}</strong>
                {submitting && <span style={s.v2CostDim}> · 画中 {inflight}</span>}
              </span>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!prompt.trim() || configs.length === 0}
                style={{
                  ...s.v4SendBtn,
                  ...(!prompt.trim() || configs.length === 0 ? s.v2SendBtnDis : null),
                }}
              >
                {refImages.length > 0 ? `按 ${refImages.length} 张改 →` : '寄出 →'}
              </button>
            </div>
            </div>{/* /v4Dock */}
          </section>

          {/* ============ RIGHT — COMPACT 2-COL GRID ============ */}
          <aside style={s.v4Results}>
            <div style={s.v4ResultsHead}>
              <h3 style={s.v2ResultsH3}>最近</h3>
              <span style={s.v2ResultsMeta}>auto-saved</span>
              <button type="button" style={s.v2ResultsRefresh} onClick={loadRecent}>刷新</button>
            </div>

            {isStreaming && (
              <div style={s.v2StreamBanner}>
                <span style={s.v2Pulse} />
                <span>正在画 · {liveSlotsDone} / {liveSlotsTotal} 已收到</span>
              </div>
            )}

            {recentTiles.length === 0 ? (
              <div style={s.v2Empty}>
                <p style={s.v2EmptyText}>
                  还没画过。左边写几句，按下
                  <em style={{ color: 'var(--accent-ink)', fontStyle: 'italic' }}>寄出</em>。
                </p>
              </div>
            ) : (
              <div style={s.v4PlateGrid}>
                {recentTiles.map((t) => (
                  <CompactPlate
                    key={t.key}
                    item={t.kind === 'done' ? t.item : null}
                    slot={t.kind === 'pending' ? t.slot : undefined}
                    onOpen={t.kind === 'done' ? () => setPreview(t.item) : undefined}
                    onDelete={t.kind === 'done' ? () => handleDelete(t.item.output_id) : undefined}
                    blurred={t.kind === 'done' ? blurredIds.has(t.item.output_id) : false}
                    onToggleBlur={t.kind === 'done' ? () => toggleBlur(t.item.output_id) : undefined}
                  />
                ))}
              </div>
            )}
          </aside>
        </div>
      </PaperContent>

      {/* :hover and keyframes don't work in inline styles — small global rules */}
      <style>{`
        .v2-ref-card-wrap:hover .v2-ref-pop,
        .v2-ref-card-wrap:focus-within .v2-ref-pop { display: block !important; }
        @keyframes chayaV2Pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes chayaV2Settle { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
      `}</style>

      {lightbox && (
        <RefLightbox
          item={lightbox}
          index={refImages.findIndex((r) => r.id === lightbox.id) + 1}
          total={refImages.length}
          onClose={() => setLightbox(null)}
        />
      )}

      {preview && (
        <ResultPreview
          item={preview}
          onClose={() => setPreview(null)}
          onRemix={async () => {
            const item = preview;
            setPreview(null);
            const ok = await addRefFromGallery(item);
            if (ok && item.prompt) setPrompt(item.prompt);
            if (ok) toast({ title: '已带入参考图', description: '改几句再寄出' });
          }}
        />
      )}
    </PaperPage>
  );
};

const ResultPreview: React.FC<{
  item: MediaOutputItem;
  onClose: () => void;
  onRemix: () => void | Promise<void>;
}> = ({ item, onClose, onRemix }) => {
  const url = mediaApi.getOutputFileUrl(item.output_id);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    setDownloading(true);
    try {
      const token = localStorage.getItem('chaya_token') || '';
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      const href = URL.createObjectURL(blob);
      const ext = (item.mime_type?.split('/')[1] || 'png').replace(/\W/g, '');
      a.href = href;
      a.download = `chaya-${item.output_id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
    } catch (e: any) {
      toast({ title: '下载失败', description: e?.message || '', variant: 'destructive' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div style={s.lightboxOverlay} onClick={onClose}>
      <div style={s.lightboxHead} onClick={(e) => e.stopPropagation()}>
        <span>
          原图 · {item.model || item.provider || '—'}
          {(item.metadata as any)?.aspect_ratio ? ` · ${(item.metadata as any).aspect_ratio}` : ''}
          {item.file_size ? ` · ${Math.round(item.file_size / 1024)} KB` : ''}
        </span>
        <button type="button" style={s.lightboxClose} onClick={onClose} aria-label="关闭">×</button>
      </div>
      <img src={url} alt={item.prompt || 'output'} style={s.lightboxImg} onClick={(e) => e.stopPropagation()} />
      {item.prompt && (
        <div style={s.lightboxPrompt} onClick={(e) => e.stopPropagation()}>
          「{item.prompt.length > 200 ? item.prompt.slice(0, 200) + '…' : item.prompt}」
        </div>
      )}
      <div style={s.previewActions} onClick={(e) => e.stopPropagation()}>
        <button type="button" style={s.previewBtn} onClick={download} disabled={downloading}>
          {downloading ? '下载…' : '下载'}
        </button>
        <button type="button" style={{ ...s.previewBtn, ...s.previewBtnPrimary }} onClick={() => void onRemix()}>
          二创 →
        </button>
      </div>
    </div>
  );
};

const RefLightbox: React.FC<{
  item: RefImage;
  index: number;
  total: number;
  onClose: () => void;
}> = ({ item, index, total, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={s.lightboxOverlay} onClick={onClose}>
      <div style={s.lightboxHead}>
        <span>参考图 {index} / {total} · {item.name}</span>
        <button type="button" style={s.lightboxClose} onClick={onClose} aria-label="关闭">×</button>
      </div>
      <img src={item.dataUrl} alt="" style={s.lightboxImg} onClick={(e) => e.stopPropagation()} />
      {item.directive && (
        <div style={s.lightboxDirective} onClick={(e) => e.stopPropagation()}>
          #{index}: {item.directive}
        </div>
      )}
    </div>
  );
};

/* ---------- compact batch (v4 results column) ---------- */

const CompactPlate: React.FC<{
  item: MediaOutputItem | null;
  slot?: number;
  onOpen?: () => void;
  onDelete?: () => void;
  blurred?: boolean;
  onToggleBlur?: () => void;
}> = ({ item, slot, onOpen, onDelete, blurred, onToggleBlur }) => {
  const [broken, setBroken] = useState(false);
  const [hover, setHover] = useState(false);
  const url = item ? mediaApi.getOutputFileUrl(item.output_id) : null;
  const clickable = !!item && !!onOpen && !broken && !blurred;
  if (!item) {
    return (
      <div style={{ ...s.v4Plate, ...s.v4PlatePending }}>
        <span style={s.v4PlatePendingMark}>{slot != null ? `#${slot} 画着…` : '画着…'}</span>
      </div>
    );
  }
  return (
    <div
      style={s.v4Plate}
      onClick={clickable ? onOpen : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen!(); } } : undefined}
    >
      {url && !broken ? (
        <img
          src={url}
          alt={item.prompt || 'output'}
          onError={() => setBroken(true)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', display: 'block',
            ...(blurred
              ? BLURRED_IMG_CSS
              : { filter: 'none', transform: 'none', transition: 'filter 200ms ease, transform 200ms ease' }),
          }}
        />
      ) : (
        <span style={s.v4PlatePendingMark}>{broken ? '找不到文件' : '正在画…'}</span>
      )}
      {blurred && <span style={s.v4PlateBlurBadge}>遮</span>}
      {(onDelete || onToggleBlur) && (
        <div style={{ ...s.v4PlateActs, opacity: hover ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
          {onToggleBlur && (
            <button
              type="button"
              aria-label={blurred ? '揭开' : '遮起来'}
              title={blurred ? '揭开' : '遮起来'}
              style={s.v4PlateActBtn}
              onClick={(e) => { e.stopPropagation(); onToggleBlur(); }}
            >{blurred ? '○' : '●'}</button>
          )}
          {onDelete && (
            <button
              type="button"
              aria-label="撕掉"
              title="撕掉"
              style={s.v4PlateActBtn}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >×</button>
          )}
        </div>
      )}
    </div>
  );
};

/* ---------- utils ---------- */

const sizeDim = (kind: 'square' | 'landscape' | 'portrait'): React.CSSProperties => {
  switch (kind) {
    case 'landscape': return { width: 16, height: 10 };
    case 'portrait':  return { width: 10, height: 16 };
    default:          return { width: 13, height: 13 };
  }
};


const s: Record<string, React.CSSProperties> = {
  layout: {
    display: 'grid',
    /* Give the creation controls plenty of room; thumbnails on the right
       stay compact so they don't fight the draft panel. Submit is in the
       topbar, so the left column just holds controls top-to-bottom. */
    gridTemplateColumns: 'minmax(420px, 1.2fr) minmax(280px, 1fr)',
    gridTemplateRows: '1fr',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  draft: {
    borderRight: '1px solid var(--rule)',
    overflowY: 'auto',
    padding: '20px 22px 18px',
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
    display: 'flex',
    flexDirection: 'column',
  },
  draftBottomHint: {
    marginTop: 'auto',
    paddingTop: 16,
    borderTop: '1px dotted var(--rule)',
    display: 'flex',
    alignItems: 'baseline',
    gap: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.04em',
    flexWrap: 'wrap',
  },
  draftBottomCost: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--ink-strong)',
    marginRight: 8,
  },
  draftBottomKbd: {
    marginLeft: 'auto',
    fontSize: 10,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.08em',
  },
  /* Topbar submit button */
  topSendBtn: {
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 13,
    padding: '8px 18px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.04em',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 6px oklch(0.18 0.02 310 / 0.12)',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  topSendBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
  costNote: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.06em',
    lineHeight: 1.3,
  },
  inkBtn: {
    flex: 1,
    padding: 14,
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 15,
    letterSpacing: '0.04em',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 6px oklch(0.18 0.02 310 / 0.12)',
  },
  inkBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  label: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 6,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  hint: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--marginalia-ink)',
    textTransform: 'none',
    letterSpacing: 0,
  },
  draftTextarea: {
    width: '100%',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '10px 14px',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 14.5,
    color: 'var(--ink)',
    lineHeight: 1.85,
    minHeight: 180,
    resize: 'vertical',
    outline: 'none',
    backgroundImage: 'repeating-linear-gradient(transparent, transparent 27px, var(--rule) 27px, var(--rule) 28px)',
    backgroundAttachment: 'local',
  },
  negTextarea: {
    width: '100%',
    background: 'transparent',
    border: '1px dashed var(--rule-strong)',
    borderRadius: 2,
    padding: '10px 12px',
    fontFamily: "'Commissioner', sans-serif",
    fontSize: 13,
    color: 'var(--ink)',
    lineHeight: 1.6,
    minHeight: 60,
    resize: 'vertical',
    outline: 'none',
  },
  /* Reference images — per-row layout */
  refList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  refRow: {
    display: 'grid',
    gridTemplateColumns: '56px 1fr',
    gap: 10,
    padding: 6,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    alignItems: 'stretch',
  },
  refThumbBtn: {
    position: 'relative',
    width: 56,
    height: 56,
    padding: 0,
    background: 'color-mix(in oklch, var(--ink) 5%, var(--page-elev))',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    overflow: 'hidden',
    cursor: 'zoom-in',
  },
  refThumbImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  refRowBadge: {
    position: 'absolute',
    top: 2, left: 2,
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 10,
    color: 'var(--paper)',
    background: 'var(--accent-ink)',
    padding: '0 5px',
    borderRadius: 1,
    letterSpacing: '0.04em',
    lineHeight: '14px',
  },
  refRowBody: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  refRowInput: {
    width: '100%',
    background: 'transparent',
    border: 0,
    padding: '4px 6px',
    fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif",
    fontSize: 12.5,
    color: 'var(--ink)',
    lineHeight: 1.5,
    outline: 'none',
    resize: 'vertical',
    minHeight: 32,
  },
  refRowFoot: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    padding: '0 6px 2px',
  },
  refRowSource: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
  },
  refRowActions: {
    display: 'flex',
    gap: 2,
  },
  refRowBtn: {
    width: 20, height: 20,
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: 0,
    fontSize: 11,
    lineHeight: 1,
    cursor: 'pointer',
    color: 'var(--pencil)',
  },
  refRowBtnDanger: {
    color: 'var(--status-error)',
  },
  refAddRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: 'transparent',
    border: '1.5px dashed var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--pencil)',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  refAddPlus: {
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 18,
    color: 'var(--accent-ink)',
    lineHeight: 1,
    minWidth: 18,
  },
  refAddT: {
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink)',
  },
  refAddS: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
    marginLeft: 'auto',
  },
  /* Lightbox for clicking a thumbnail */
  lightboxOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'color-mix(in oklch, var(--ink) 75%, transparent)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    zIndex: 60,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  lightboxHead: {
    position: 'absolute',
    top: 20, left: 0, right: 0,
    padding: '0 24px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'var(--paper)',
    letterSpacing: '0.08em',
  },
  lightboxClose: {
    background: 'transparent',
    border: '1px solid color-mix(in oklch, var(--paper) 40%, transparent)',
    color: 'var(--paper)',
    fontSize: 18,
    width: 32,
    height: 32,
    borderRadius: 2,
    cursor: 'pointer',
    lineHeight: 1,
  },
  lightboxImg: {
    maxWidth: '88vw',
    maxHeight: '78vh',
    objectFit: 'contain',
    display: 'block',
    borderRadius: 2,
    boxShadow: '0 20px 60px oklch(0 0 0 / 0.5)',
    cursor: 'default',
  },
  lightboxDirective: {
    maxWidth: '60ch',
    padding: '10px 16px',
    background: 'color-mix(in oklch, var(--marginalia) 35%, transparent)',
    borderLeft: '3px solid var(--marginalia-ink)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontStyle: 'italic',
    fontSize: 14,
    color: 'var(--paper)',
    lineHeight: 1.6,
  },
  lightboxPrompt: {
    maxWidth: '72ch',
    padding: '10px 18px',
    background: 'color-mix(in oklch, var(--paper) 12%, transparent)',
    borderLeft: '2px solid color-mix(in oklch, var(--paper) 40%, transparent)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'color-mix(in oklch, var(--paper) 85%, transparent)',
    lineHeight: 1.7,
    borderRadius: 2,
  },
  previewActions: {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
  },
  previewBtn: {
    padding: '8px 18px',
    background: 'transparent',
    color: 'var(--paper)',
    border: '1px solid color-mix(in oklch, var(--paper) 40%, transparent)',
    borderRadius: 2,
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 13,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  previewBtnPrimary: {
    background: 'var(--accent-ink)',
    borderColor: 'var(--accent-ink)',
    color: 'var(--paper)',
    boxShadow: '0 2px 8px oklch(0 0 0 / 0.35)',
  },
  plateClickable: {
    cursor: 'zoom-in',
  },
  /* Merge preview chips next to the prompt */
  mergeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
    marginTop: 8,
  },
  mergeLabel: {
    fontSize: 10,
    letterSpacing: '0.22em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    marginRight: 2,
    fontFamily: "'JetBrains Mono', monospace",
  },
  mergeChipStyle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 10px',
    background: 'var(--accent-soft)',
    border: '1px solid color-mix(in oklch, var(--accent-ink) 25%, transparent)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--accent-ink)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 11.5,
    letterSpacing: '0.02em',
  },
  mergeChipRefs: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 6px 3px 10px',
    background: 'color-mix(in oklch, var(--marginalia) 30%, transparent)',
    border: '1px solid color-mix(in oklch, var(--marginalia-ink) 25%, transparent)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--marginalia-ink)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 11.5,
  },
  mergeRefChipInner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    marginLeft: 4,
  },
  mergeRefThumb: {
    width: 14,
    height: 14,
    objectFit: 'cover',
    borderRadius: 1,
    border: '1px solid color-mix(in oklch, var(--marginalia-ink) 25%, transparent)',
    display: 'inline-block',
  },
  mergeRefHash: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    letterSpacing: '0.04em',
  },
  mergeRefTick: {
    fontSize: 10,
    opacity: 0.7,
  },
  styleRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'stretch',
    marginBottom: 8,
  },
  styleTextarea: {
    flex: 1,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '8px 12px',
    fontFamily: "'Commissioner', 'LXGW WenKai', sans-serif",
    fontSize: 13,
    color: 'var(--ink)',
    lineHeight: 1.6,
    resize: 'vertical',
    outline: 'none',
    minHeight: 60,
  },
  styleSaveBtn: {
    flexShrink: 0,
    padding: '0 12px',
    background: 'transparent',
    color: 'var(--accent-ink)',
    border: '1px solid var(--accent-ink)',
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    cursor: 'pointer',
    minWidth: 44,
  },
  styleSaveBtnDisabled: {
    color: 'var(--pencil-soft)',
    borderColor: 'var(--rule-strong)',
    cursor: 'not-allowed',
  },
  styleSaveForm: {
    display: 'flex',
    gap: 6,
    marginBottom: 8,
    padding: '8px 10px',
    background: 'var(--accent-soft)',
    border: '1px solid color-mix(in oklch, var(--accent-ink) 20%, transparent)',
    borderRadius: 2,
  },
  styleSaveInput: {
    flex: 1,
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid color-mix(in oklch, var(--accent-ink) 30%, transparent)',
    padding: '4px 0',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 13,
    color: 'var(--ink)',
    outline: 'none',
  },
  styleSaveOK: {
    padding: '4px 12px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    cursor: 'pointer',
  },
  styleSaveCancel: {
    padding: '4px 10px',
    background: 'transparent',
    color: 'var(--pencil)',
    border: 0,
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    cursor: 'pointer',
  },
  stylePresets: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    alignItems: 'center',
  },
  stylePresetsLabel: {
    fontSize: 10,
    letterSpacing: '0.22em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    marginRight: 4,
    fontFamily: "'JetBrains Mono', monospace",
  },
  stylePresetChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 12,
  },
  stylePresetChipOn: {
    background: 'var(--accent-ink)',
    borderColor: 'var(--accent-ink)',
    color: 'var(--paper)',
  },
  stylePresetChipTag: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.08em',
  },
  stylePresetChipTagOn: {
    color: 'color-mix(in oklch, var(--paper) 75%, transparent)',
  },
  stylePresetCustom: {
    padding: 0,
    overflow: 'hidden',
  },
  stylePresetCustomPick: {
    background: 'transparent',
    border: 0,
    color: 'inherit',
    padding: '4px 4px 4px 10px',
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  },
  stylePresetCustomDel: {
    background: 'transparent',
    border: 0,
    borderLeft: '1px solid color-mix(in oklch, var(--pencil) 20%, transparent)',
    color: 'var(--pencil-soft)',
    padding: '2px 8px',
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
  },
  stylePresetClear: {
    color: 'var(--pencil-soft)',
    borderStyle: 'dashed',
  },
  sizeGrid: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-start' },
  sizeChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'var(--pencil)',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  sizeChipSel: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  sizePreview: {
    display: 'inline-block',
    background: 'var(--pencil-soft)',
    borderRadius: 1,
  },
  /* Model picker chips */
  modelChipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  modelChip: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 1,
    padding: '6px 12px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--ink)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 13,
    letterSpacing: '0.01em',
    textAlign: 'left',
  },
  modelChipOn: {
    background: 'var(--accent-ink)',
    borderColor: 'var(--accent-ink)',
    color: 'var(--paper)',
    boxShadow: '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent)',
  },
  modelChipSub: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  modelChipSubOn: {
    color: 'color-mix(in oklch, var(--paper) 70%, transparent)',
  },
  /* Count chips */
  countRow: {
    display: 'flex',
    gap: 6,
  },
  countChip: {
    minWidth: 40,
    padding: '6px 12px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--ink)',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 13,
    textAlign: 'center',
  },
  countChipOn: {
    background: 'var(--accent-ink)',
    borderColor: 'var(--accent-ink)',
    color: 'var(--paper)',
  },
  /* Empty config state */
  configEmpty: {
    padding: '14px 16px',
    background: 'var(--status-error-bg)',
    border: '1px dashed color-mix(in oklch, var(--status-error) 25%, transparent)',
    borderRadius: 2,
  },
  configEmptyText: {
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'oklch(0.40 0.100 25)',
    margin: 0,
    lineHeight: 1.6,
  },
  configEmptyEm: {
    color: 'var(--accent-ink)',
    fontStyle: 'italic',
  },
  configEmptySteps: {
    margin: '8px 0 0 18px',
    padding: 0,
    fontFamily: "'Young Serif', serif",
    fontSize: 12.5,
    color: 'var(--pencil)',
    lineHeight: 1.8,
  },
  gotoModelsBtn: {
    padding: '6px 14px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 12.5,
    letterSpacing: '0.02em',
  },
  paramRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 14,
    padding: '10px 0',
    borderBottom: '1px dotted var(--rule)',
    alignItems: 'center',
  },
  paramTitle: { fontSize: 12.5, color: 'var(--ink)', fontFamily: "'Young Serif', serif" },
  paramDesc: { fontSize: 11, color: 'var(--pencil)', marginTop: 2 },
  paramCtrl: {},
  paramSelect: {
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: 'var(--ink)',
    textAlign: 'right',
    padding: '3px 2px',
    minWidth: 140,
    outline: 'none',
    cursor: 'pointer',
  },
  paramInput: {
    background: 'transparent',
    border: 0,
    borderBottom: '1px solid var(--rule-strong)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: 'var(--ink)',
    textAlign: 'right',
    padding: '3px 2px',
    minWidth: 120,
    outline: 'none',
  },
  results: {
    overflowY: 'auto',
    padding: '22px 24px 40px',
    borderLeft: '1px solid var(--rule)',
    background: 'color-mix(in oklch, var(--paper) 70%, var(--page))',
    minHeight: 0,
  },
  resultsHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 14,
    paddingBottom: 8,
    borderBottom: '1px solid var(--rule)',
  },
  resultsH2: {
    fontFamily: "'Young Serif', serif",
    fontSize: 15,
    color: 'var(--ink-strong)',
    fontWeight: 400,
    margin: 0,
    letterSpacing: '0.01em',
  },
  resultsCap: {
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    fontFamily: "'JetBrains Mono', monospace",
  },
  resultsActions: { marginLeft: 'auto', display: 'flex', gap: 8 },
  ghostBtn: {
    background: 'transparent',
    color: 'var(--ink)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '6px 12px',
    fontSize: 12,
    fontFamily: "'Young Serif', serif",
    cursor: 'pointer',
  },
  emptyResults: {
    padding: '64px 32px',
    textAlign: 'center',
    border: '2px dashed var(--rule-strong)',
    borderRadius: 4,
  },
  emptyText: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 14,
    color: 'var(--pencil)',
  },
  batchMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil)',
    marginBottom: 8,
    letterSpacing: '0.06em',
  },
  batchPromptSnip: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--ink)',
    fontSize: 11.5,
    maxWidth: '34ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: 0,
    flex: 1,
    minWidth: 0,
  },
  imgGrid: {
    display: 'grid',
    /* Compact contact-sheet layout — small tiles, tight gutters. */
    gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
    gap: 4,
  },
  plate: {
    position: 'relative',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.05)',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'transform 200ms cubic-bezier(0.22,1,0.36,1), box-shadow 200ms',
  },
  plateImg: {
    aspectRatio: '1 / 1',
    position: 'relative',
    overflow: 'hidden',
    background: 'var(--page-elev)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  plateImgPending: {
    background: 'repeating-linear-gradient(90deg, var(--page-elev) 0, var(--page-elev) 8px, var(--rule) 8px, var(--rule) 9px)',
  },
  plateActions: {
    position: 'absolute',
    top: 4,
    right: 4,
    display: 'flex',
    gap: 3,
    transition: 'opacity 160ms ease',
  },
  plateAction: {
    width: 18,
    height: 18,
    padding: 0,
    lineHeight: '16px',
    textAlign: 'center',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    color: 'var(--ink)',
    background: 'color-mix(in oklch, var(--page-elev) 90%, transparent)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.12)',
  },
  plateBlurBadge: {
    position: 'absolute',
    left: 4,
    top: 4,
    fontFamily: "'Young Serif', serif",
    fontSize: 10,
    letterSpacing: '0.08em',
    color: 'var(--ink)',
    background: 'color-mix(in oklch, var(--page-elev) 85%, transparent)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '1px 5px',
    pointerEvents: 'none',
  },
  plateProgressText: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11,
    color: 'var(--pencil)',
    background: 'var(--page-elev)',
    padding: '2px 7px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
  },
  plateCaption: {
    padding: '5px 7px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    color: 'var(--pencil)',
    letterSpacing: '0.04em',
  },
  plateSeed: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  plateTagF: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 10,
    color: 'var(--accent-ink)',
    letterSpacing: 0,
    whiteSpace: 'nowrap',
  },

  /* ====================================================================
     v2 — Two Stage layout (Atelier redesign 2026-05)
     ==================================================================== */
  v2Layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(520px, 1fr) minmax(320px, 400px)',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  v2Composer: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  /* prompt area */
  v2PromptArea: {
    padding: '24px 40px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  v2Eyebrow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  v2EyebrowLbl: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  v2EyebrowHint: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--marginalia-ink)',
    fontSize: 12,
  },
  v2PromptText: {
    width: '100%',
    background: 'transparent',
    border: 0,
    outline: 'none',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 18,
    lineHeight: '34px',
    color: 'var(--ink-strong)',
    resize: 'none',
    minHeight: 170,
    backgroundImage:
      'repeating-linear-gradient(transparent, transparent 33px, color-mix(in oklch, var(--rule) 60%, transparent) 33px, color-mix(in oklch, var(--rule) 60%, transparent) 34px)',
    backgroundPosition: '0 2px',
    padding: 0,
  },
  /* refs strip */
  v2Refs: {
    borderTop: '1px solid var(--rule)',
    padding: '12px 40px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
  },
  v2RefsLbl: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  v2RefsRow: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    flex: 1,
    padding: '2px 0',
  },
  v2RefCardWrap: { position: 'relative', flex: '0 0 auto' },
  v2RefCard: {
    position: 'relative',
    width: 64,
    height: 64,
    borderRadius: 2,
    overflow: 'hidden',
    border: '1px solid var(--rule-strong)',
    cursor: 'pointer',
    padding: 0,
    background: 'var(--page-elev)',
  },
  v2RefCardHasDir: { boxShadow: 'inset 0 0 0 1px var(--accent-ink)' },
  v2RefImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  v2RefHash: {
    position: 'absolute',
    top: 3,
    left: 3,
    background: 'color-mix(in oklch, var(--ink) 75%, transparent)',
    color: 'var(--paper)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    padding: '1px 5px',
    borderRadius: 1,
  },
  v2RefTick: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--status-success)',
  },
  v2RefX: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--page-elev)',
    color: 'var(--pencil)',
    borderRadius: 1,
    fontSize: 11,
    border: '1px solid var(--rule)',
    cursor: 'pointer',
  },
  v2RefPop: {
    display: 'none',
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    minWidth: 240,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '8px 10px',
    boxShadow: '0 6px 20px oklch(0.18 0.02 310 / 0.12)',
    zIndex: 5,
  },
  v2RefPopInput: {
    width: '100%',
    background: 'transparent',
    border: 0,
    borderBottom: '1px dashed var(--rule-strong)',
    padding: '2px 0 4px',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 12.5,
    color: 'var(--ink)',
    resize: 'none',
    outline: 'none',
    minHeight: 32,
  },
  v2RefPopFoot: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 6,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
  },
  v2RefPopSource: {},
  v2RefPopActions: { display: 'flex', gap: 4 },
  v2RefPopBtn: {
    width: 18,
    height: 18,
    padding: 0,
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 1,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'var(--pencil)',
    cursor: 'pointer',
    lineHeight: '14px',
  },
  v2RefAdd: {
    flex: '0 0 auto',
    width: 64,
    height: 64,
    borderRadius: 2,
    border: '1px dashed var(--rule-strong)',
    background: 'transparent',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 11,
    color: 'var(--pencil)',
    lineHeight: 1.2,
    textAlign: 'center' as const,
    padding: 0,
  },
  v2RefAddPlus: {
    fontSize: 16,
    lineHeight: 1,
    display: 'block',
    marginBottom: 2,
    color: 'var(--pencil-soft)',
  },
  v2RefAddT: { display: 'block' },

  /* chips bar */
  v2ChipsBar: {
    borderTop: '1px solid var(--rule)',
    background: 'var(--page)',
    padding: '10px 40px',
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const,
    alignItems: 'center',
  },
  v2Chip: {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 7,
    padding: '6px 11px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    background: 'var(--page-elev)',
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink)',
    transition: 'border-color 180ms cubic-bezier(0.22,1,0.36,1), background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  v2ChipOpen: {
    borderColor: 'var(--accent-ink)',
    background: 'color-mix(in oklch, var(--accent-ink) 8%, var(--page-elev))',
  },
  v2ChipActive: { borderColor: 'var(--accent-ink)' },
  v2ChipDim: {},
  v2ChipErr: { borderColor: 'var(--status-error)' },
  v2ChipK: {
    fontSize: 9.5,
    letterSpacing: '0.18em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    fontFamily: "'Commissioner', system-ui, sans-serif",
  },
  v2ChipV: {
    color: 'var(--ink-strong)',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'inline-block',
    verticalAlign: 'bottom',
  },
  v2ChipVEmpty: { color: 'var(--pencil-soft)', fontStyle: 'italic' },
  v2ChipVErr: { color: 'var(--status-error)' },

  /* drawer */
  v2Drawer: {
    borderTop: '1px solid var(--rule)',
    background: 'color-mix(in oklch, var(--accent-soft) 45%, var(--page))',
    padding: '16px 40px 18px',
  },
  v2DrawerHead: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 },
  v2DrawerH4: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--ink-strong)',
    fontWeight: 400,
  },
  v2DrawerDesc: {
    fontSize: 12,
    color: 'var(--pencil)',
    fontStyle: 'italic',
    fontFamily: "'Young Serif', serif",
  },
  /* drawer · style */
  v2StyleGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 24px' },
  v2StyleText: {
    width: '100%',
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '8px 10px',
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--ink)',
    minHeight: 70,
    resize: 'vertical',
    outline: 'none',
  },
  v2StyleBtnRow: { display: 'flex', gap: 6, marginTop: 8 },
  v2StyleSave: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '5px 12px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
  },
  v2StyleSaveDis: { opacity: 0.4, cursor: 'not-allowed' },
  v2StyleClear: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '5px 12px',
    background: 'transparent',
    color: 'var(--pencil)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  v2StyleSaveForm: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' },
  v2StyleSaveInput: {
    flex: 1,
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '5px 8px',
    fontFamily: "'Young Serif', serif",
    fontSize: 12.5,
    outline: 'none',
  },
  v2StyleSaveOK: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '5px 11px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
  },
  v2StyleSaveCancel: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '5px 11px',
    background: 'transparent',
    color: 'var(--pencil)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  v2PresetGroup: {
    fontSize: 10,
    letterSpacing: '0.18em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    marginBottom: 4,
    fontFamily: "'Commissioner', system-ui, sans-serif",
  },
  v2PresetRow: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 },
  v2Pill: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '4px 10px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    background: 'var(--paper)',
    cursor: 'pointer',
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  },
  v2PillOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  v2PillMine: { borderStyle: 'dashed', padding: '2px 2px 2px 10px' },
  v2PillMinePick: {
    background: 'transparent',
    border: 0,
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    padding: 0,
  },
  v2PillMineDel: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil-soft)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    cursor: 'pointer',
    padding: '0 6px',
    marginLeft: 2,
  },
  /* drawer · size */
  v2SizeGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  v2SizeChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: 'var(--pencil)',
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  },
  v2SizeChipSel: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  v2SizePreview: {
    width: 13,
    height: 13,
    background: 'var(--pencil-soft)',
    borderRadius: 1,
  },
  /* drawer · model */
  v2ModelRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  v2ModelEmpty: {
    padding: '6px 0',
    fontFamily: "'Young Serif', serif",
    fontSize: 12.5,
    color: 'var(--pencil)',
  },
  v2ModelSteps: { paddingLeft: 18, margin: '4px 0', lineHeight: 1.7 },
  v2ModelGoto: {
    marginTop: 8,
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    padding: '5px 12px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
  },
  /* drawer · count */
  v2CountRow: { display: 'flex', gap: 5 },
  v2CountChip: {
    width: 46,
    padding: '6px 0',
    textAlign: 'center' as const,
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    color: 'var(--ink)',
  },
  v2CountChipOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  /* drawer · neg */
  v2NegText: {
    width: '100%',
    background: 'var(--paper)',
    border: '1px dashed var(--rule-strong)',
    borderRadius: 2,
    padding: '8px 10px',
    fontFamily: "'Commissioner', system-ui, sans-serif",
    fontSize: 12.5,
    color: 'var(--pencil)',
    minHeight: 50,
    resize: 'vertical',
    outline: 'none',
  },

  /* send foot — pinned to bottom of composer via marginTop: auto */
  v2SendFoot: {
    marginTop: 'auto',
    borderTop: '1px solid var(--rule)',
    padding: '12px 40px 14px',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 20,
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
    position: 'sticky',
    bottom: 0,
    zIndex: 2,
  },
  v2CostLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    flexWrap: 'wrap' as const,
    fontSize: 12,
    color: 'var(--pencil)',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.04em',
  },
  v2CostStrong: {
    fontFamily: "'Young Serif', serif",
    fontSize: 16,
    color: 'var(--accent-ink)',
    fontWeight: 400,
  },
  v2CostDim: { color: 'var(--pencil-soft)' },
  v2SendBtn: {
    padding: '11px 26px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 14.5,
    letterSpacing: '0.02em',
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 6px oklch(0.18 0.02 310 / 0.12)',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  v2SendBtnDis: { opacity: 0.45, cursor: 'not-allowed', boxShadow: 'none' },

  /* results column */
  v2Results: {
    borderLeft: '1px solid var(--rule)',
    overflowY: 'auto',
    padding: '20px 22px 32px',
    background: 'var(--page)',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    minHeight: 0,
  },
  v2ResultsHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingBottom: 8,
    borderBottom: '1px solid var(--rule)',
    gap: 10,
  },
  v2ResultsH3: {
    fontFamily: "'Young Serif', serif",
    fontSize: 15,
    color: 'var(--ink-strong)',
    fontWeight: 400,
  },
  v2ResultsMeta: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginRight: 'auto',
    marginLeft: 8,
  },
  v2ResultsRefresh: {
    fontFamily: "'Young Serif', serif",
    fontSize: 11.5,
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '3px 9px',
    color: 'var(--pencil)',
    cursor: 'pointer',
  },
  v2StreamBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11.5,
    color: 'var(--pencil)',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.06em',
    padding: '2px 0',
  },
  v2Pulse: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--accent-ink)',
    animation: 'chayaV2Pulse 1.4s cubic-bezier(0.22,1,0.36,1) infinite',
    display: 'inline-block',
  },
  v2Empty: {
    padding: '32px 8px',
    textAlign: 'center' as const,
  },
  v2EmptyText: {
    fontFamily: "'Young Serif', serif",
    fontSize: 13,
    color: 'var(--pencil)',
    fontStyle: 'italic',
    lineHeight: 1.7,
  },

  /* ====================================================================
     v4 — Big Paper (composer paper + bottom dock + compact results)
     ==================================================================== */
  v4Paper: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '28px 56px 8px',
    display: 'grid',
    gridTemplateColumns: '1fr 200px',
    columnGap: 36,
    background:
      'radial-gradient(80% 60% at 30% 0%, color-mix(in oklch, var(--marginalia) 5%, transparent), transparent 60%), var(--paper)',
  },
  v4Folio: {
    gridColumn: '1 / -1',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingBottom: 14,
    marginBottom: 18,
    borderBottom: '1px solid var(--rule)',
    gap: 12,
    flexWrap: 'wrap',
  },
  v4FolioNo: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
    marginLeft: 'auto',
  },
  v4Surface: { gridColumn: 1, position: 'relative', minHeight: '100%' },
  v4PromptText: {
    width: '100%',
    minHeight: 480,
    background:
      'repeating-linear-gradient(transparent, transparent 33px, color-mix(in oklch, var(--rule) 60%, transparent) 33px, color-mix(in oklch, var(--rule) 60%, transparent) 34px)',
    backgroundPosition: '0 2px',
    border: 0,
    outline: 'none',
    fontFamily: "'Young Serif', 'LXGW WenKai', serif",
    fontSize: 18,
    lineHeight: '34px',
    color: 'var(--ink-strong)',
    resize: 'none',
    padding: 0,
    paddingTop: 2,
  },
  v4Marginalia: {
    gridColumn: 2,
    alignSelf: 'start',
    paddingTop: 2,
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    lineHeight: 1.75,
    borderLeft: '1px dotted var(--rule-strong)',
    paddingLeft: 18,
  },
  v4MargH5: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'normal',
    fontSize: 11,
    letterSpacing: '0.22em',
    color: 'var(--pencil-soft)',
    textTransform: 'uppercase',
    marginBottom: 8,
    fontWeight: 400,
  },
  v4MargP: { marginBottom: 14 },
  v4MargEm: { color: 'var(--accent-ink)', fontStyle: 'italic' },
  v4MargKbd: {
    display: 'inline-block',
    padding: '1px 6px',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    fontStyle: 'normal',
    color: 'var(--ink)',
    letterSpacing: '0.04em',
    margin: '0 1px',
  },
  v4MargRule: {
    display: 'block',
    height: 1,
    background: 'var(--rule-strong)',
    width: '70%',
    margin: '14px 0 14px auto',
  },

  /* dock */
  v4Dock: {
    borderTop: '1px solid var(--rule)',
    background: 'color-mix(in oklch, var(--paper) 55%, var(--page))',
    display: 'flex',
    flexDirection: 'column',
    position: 'sticky',
    bottom: 0,
    zIndex: 2,
  },
  v4Refs: {
    padding: '12px 56px',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    borderBottom: '1px dotted var(--rule)',
  },
  /* ref pill */
  v4RefPill: {
    position: 'relative',
    flex: '0 0 auto',
    display: 'grid',
    gridTemplateColumns: '56px 1fr',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    overflow: 'hidden',
    transition: 'border-color 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  v4RefPillHasDir: {
    borderColor: 'var(--accent-ink)',
    boxShadow: 'inset 3px 0 0 var(--accent-ink)',
  },
  v4RefPillThumb: {
    position: 'relative',
    width: 56,
    height: 56,
    cursor: 'pointer',
    border: 0,
    padding: 0,
    background: 'var(--paper)',
    overflow: 'hidden',
  },
  v4RefPillBody: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 210,
    maxWidth: 240,
    padding: '6px 8px 4px 10px',
  },
  v4RefPillInput: {
    width: '100%',
    border: 0,
    background: 'transparent',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 12.5,
    color: 'var(--ink)',
    resize: 'none',
    outline: 'none',
    lineHeight: 1.45,
    padding: 0,
    minHeight: 30,
  },
  v4RefPillFoot: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
  },
  v4RefPillSrc: { color: 'var(--pencil-soft)', textTransform: 'uppercase' },
  v4RefPillActs: { display: 'flex', gap: 3 },
  v4RefPillBtn: {
    width: 16,
    height: 16,
    padding: 0,
    lineHeight: '14px',
    background: 'transparent',
    border: '1px solid var(--rule)',
    borderRadius: 1,
    cursor: 'pointer',
    color: 'var(--pencil-soft)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
  },
  v4RefPillBtnDel: {},
  v4RefAdd: {
    flex: '0 0 auto',
    width: 64,
    height: 56,
    borderRadius: 2,
    border: '1px dashed var(--rule-strong)',
    background: 'transparent',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 11,
    color: 'var(--pencil)',
    lineHeight: 1.2,
    textAlign: 'center' as const,
    padding: 0,
  },

  /* actions row — chips + cost + send */
  v4Actions: {
    padding: '12px 56px',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  v4ChipGroup: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    flex: 1,
    minWidth: 0,
  },
  v4CostPill: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11.5,
    color: 'var(--pencil)',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap' as const,
    marginRight: 4,
  },
  v4CostStrong: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    color: 'var(--accent-ink)',
    fontWeight: 400,
    marginLeft: 4,
  },
  v4SendBtn: {
    padding: '10px 22px',
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    border: 0,
    borderRadius: 2,
    cursor: 'pointer',
    fontFamily: "'Young Serif', serif",
    fontSize: 14,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap' as const,
    boxShadow:
      '0 1px 0 color-mix(in oklch, var(--ink) 25%, transparent), 0 2px 6px oklch(0.18 0.02 310 / 0.12)',
    transition: 'background 180ms cubic-bezier(0.22,1,0.36,1)',
  },

  /* compact results column */
  v4Results: {
    borderLeft: '1px solid var(--rule)',
    overflowY: 'auto',
    padding: '18px 16px 32px',
    background: 'var(--page)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minHeight: 0,
  },
  v4ResultsHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingBottom: 6,
    borderBottom: '1px solid var(--rule)',
    gap: 8,
  },
  v4Group: { display: 'flex', flexDirection: 'column', gap: 8 },
  v4Strap: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  v4StrapAgo: { color: 'var(--pencil)' },
  v4StrapDot: {
    flex: 1,
    height: 0,
    borderTop: '1px dotted var(--rule-strong)',
  },
  v4StrapTag: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--pencil)',
    fontSize: 11,
    letterSpacing: 0,
    textTransform: 'none',
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  v4PlateGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 3,
  },
  v4Plate: {
    position: 'relative',
    borderRadius: 1,
    overflow: 'hidden',
    background: 'var(--paper)',
    aspectRatio: '1 / 1',
    cursor: 'pointer',
    animation: 'chayaV2Settle 320ms cubic-bezier(0.22,1,0.36,1)',
    transition: 'transform 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  v4PlatePending: {
    background:
      'repeating-linear-gradient(135deg, color-mix(in oklch, var(--rule) 60%, transparent), color-mix(in oklch, var(--rule) 60%, transparent) 6px, transparent 6px, transparent 12px)',
    display: 'grid',
    placeItems: 'center',
    cursor: 'default',
  },
  v4PlatePendingMark: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--pencil)',
    fontSize: 11,
  },
  v4PlateStamp: {
    position: 'absolute',
    top: 4,
    left: 4,
    background: 'color-mix(in oklch, var(--ink) 75%, transparent)',
    color: 'var(--paper)',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    letterSpacing: '0.04em',
    padding: '1px 5px',
    borderRadius: 1,
  },
  v4PlateBlurBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    fontFamily: "'Young Serif', serif",
    fontSize: 9.5,
    color: 'var(--ink)',
    background: 'color-mix(in oklch, var(--page-elev) 85%, transparent)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '1px 5px',
  },
  v4PlateActs: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    display: 'flex',
    gap: 2,
    transition: 'opacity 160ms ease',
  },
  v4PlateActBtn: {
    width: 18,
    height: 18,
    padding: 0,
    lineHeight: '16px',
    textAlign: 'center' as const,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    color: 'var(--ink)',
    background: 'color-mix(in oklch, var(--page-elev) 90%, transparent)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
};

export default CreatePage;
