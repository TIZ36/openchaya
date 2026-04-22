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
      const data = await mediaApi.listOutputs(24, 0);
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

  /** Compose the final prompt: user text + style suffix + per-ref directives. */
  const finalPromptForSubmit = useMemo(() => {
    const base = prompt.trim();
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
  }, [prompt, styleText, negative, refImages]);

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

    // Auto-rewrite the user's short idea into a nano-banana-friendly paragraph
    // via gemini-2.5-flash (Google's recommended pattern). Racing against a
    // short timeout keeps this invisible: if the rewrite is slow, broken, or
    // refused, we silently fall back to the original prompt. Skip on edits,
    // because the user's directive is relative to the ref images and rewriting
    // it would change meaning.
    let promptForSubmit = userPromptForSubmit;
    if (!isEdit) {
      try {
        const REWRITE_TIMEOUT_MS = 6000;
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), REWRITE_TIMEOUT_MS),
        );
        const rewrite = mediaApi
          .geminiRewritePrompt({
            prompt: userPromptForSubmit,
            aspect_ratio: sizeId,
            config_id: config.config_id,
          })
          .then((r) => (r.error ? null : (r.prompt || '').trim() || null))
          .catch(() => null);
        const rewritten = await Promise.race([rewrite, timeout]);
        if (rewritten && rewritten.length > 20) {
          promptForSubmit = rewritten;
        }
      } catch { /* fall back to user prompt */ }
    }

    try {
      // Gemini endpoints return media INLINE ({media: [{mimeType, data}], content})
      // but do NOT persist, and the backend ignores `count` — it always calls
      // Gemini once. To honor the user's count, we fire N parallel calls and
      // take the first media item from each response (Gemini sometimes returns
      // multiple candidates; taking just the first prevents count=1 → 2 images).
      type InlineMedia = { mimeType?: string; data?: string };
      const callOnce = () =>
        isEdit
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
            });

      const results = await Promise.all(Array.from({ length: count }, callOnce));
      const inline: InlineMedia[] = [];
      for (const res of results) {
        if (res.error) throw new Error(res.error);
        const media = Array.isArray(res.media) ? (res.media as InlineMedia[]) : [];
        if (media[0]?.data) inline.push(media[0]);
      }
      if (inline.length === 0) {
        throw new Error('后端没返回图像（可能 provider 没配或模型不对）');
      }

      const savedItems: MediaOutputItem[] = [];
      const modelUsed = modelForSubmit || 'gemini-image';
      for (const m of inline) {
        if (!m.data) continue;
        try {
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
          savedItems.push(saved);
        } catch (persistErr: any) {
          console.warn('[CreatePage] saveOutput failed:', persistErr?.message || persistErr);
        }
      }

      await loadRecent();
      setBatches((prev) =>
        prev.map((b) =>
          b.id === batchId
            ? {
                ...b,
                pending: false,
                items: savedItems.length > 0 ? savedItems : new Array(inline.length).fill(null),
              }
            : b,
        ),
      );
      toast({
        title: isEdit ? '改完了' : '画完了',
        description: `${savedItems.length} 张已入库`,
        variant: 'success',
      });
    } catch (e: any) {
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, pending: false, items: [] } : b)),
      );
      toast({
        title: isEdit ? '改不出来' : '画不出来',
        description: e?.message || String(e),
        variant: 'destructive',
      });
    } finally {
      setInflight((n) => Math.max(0, n - 1));
    }
  };

  // Group recent outputs into "done" batches by prompt similarity + timestamp window.
  // Exclude items already shown in the live `batches` list to prevent the just-
  // generated frames from appearing twice after loadRecent() refreshes.
  const doneBatches = useMemo<Batch[]>(() => {
    const liveIds = new Set<string>();
    for (const b of batches) {
      for (const it of b.items) if (it?.output_id) liveIds.add(it.output_id);
    }
    const groups: Record<string, MediaOutputItem[]> = {};
    for (const o of recentOutputs) {
      if (liveIds.has(o.output_id)) continue;
      const key = `${(o.prompt || '').slice(0, 30)}|${o.model || ''}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(o);
    }
    return Object.entries(groups).slice(0, 3).map(([key, items], i) => ({
      id: `d-${i}-${key}`,
      prompt: items[0]?.prompt || '',
      style: '',
      model: items[0]?.model || '',
      aspect: (items[0]?.metadata?.aspect_ratio as string) || '',
      items,
      createdAt: items[0]?.created_at ? new Date(items[0].created_at).getTime() : 0,
      pending: false,
    }));
  }, [recentOutputs, batches]);

  const allBatches = [...batches, ...doneBatches];

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Five · Atelier"
        title="创作"
        subtitle="写几句你想要的画面，按下寄出。画完的会自动收进作品集。"
        meta={selectedConfig ? `${selectedModelLabel} · ${sizeId}` : '未选模型'}
        actions={
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!prompt.trim()}
            style={{
              ...s.topSendBtn,
              ...(!prompt.trim() ? s.topSendBtnDisabled : null),
            }}
          >
            {refImages.length > 0
              ? `按 ${refImages.length} 张参考改${submitting ? `（画中 ${inflight}）` : ''} →`
              : `寄出 · ¥${costEstimate.toFixed(2)}${submitting ? `（画中 ${inflight}）` : ''} →`}
          </button>
        }
      />

      <PaperContent noPad>
        <div style={s.layout}>
          {/* LEFT — DRAFT */}
          <aside style={s.draft}>
            <Block>
              <Label
                title="你想画什么"
                hint={refImages.length > 0 ? '用 #1 #2 指代参考图' : '写得越具体越稳'}
              />
              <textarea
                ref={promptTextareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={handlePromptPaste}
                rows={6}
                placeholder={
                  refImages.length > 0
                    ? '例：把 #1 的脸用 #2 的笔触画出来；#3 是参考的构图。'
                    : '例：一间藏在巷子里的小茶馆，门口挂着一块木牌写着「慢」。午后的光从窗帘缝里斜斜进来，老木头桌面上搁着一把紫砂壶和两只没喝完的茶杯。'
                }
                style={s.draftTextarea}
              />

              {/* Merge preview — show what's being auto-appended to the final prompt */}
              {(currentStyleLabel || refImages.length > 0) && (
                <div style={s.mergeRow}>
                  <span style={s.mergeLabel}>寄出时会带上</span>
                  {currentStyleLabel && (
                    <button
                      type="button"
                      style={s.mergeChipStyle}
                      onClick={() => styleSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      title={styleText}
                    >
                      风格 · {currentStyleLabel}
                    </button>
                  )}
                  {refImages.length > 0 && (
                    <button
                      type="button"
                      style={s.mergeChipRefs}
                      onClick={() => refsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      title={refImages.map((r, i) => `#${i + 1}${r.directive ? ': ' + r.directive : ''}`).join('\n')}
                    >
                      参考图 ·
                      {refImages.map((r, i) => (
                        <span key={r.id} style={s.mergeRefChipInner} title={r.directive || '（无指示语）'}>
                          <img src={r.dataUrl} alt="" style={s.mergeRefThumb} />
                          <span style={s.mergeRefHash}>#{i + 1}</span>
                          {r.directive && <span style={s.mergeRefTick}>·</span>}
                        </span>
                      ))}
                    </button>
                  )}
                </div>
              )}
            </Block>

            {/* 参考图 — 每张一行：小缩略 + 各自的指示语 */}
            <Block refNode={refsSectionRef}>
              <Label
                title={refImages.length > 0 ? `参考图 · ${refImages.length} 张` : '参考图'}
                hint={refImages.length === 0 ? '粘贴 / 上传 / 从作品集挑' : '点图看大图 · 每张旁边写用法'}
              />
              <div style={s.refList}>
                {refImages.map((r, i) => (
                  <div key={r.id} style={s.refRow}>
                    <button
                      type="button"
                      style={s.refThumbBtn}
                      onClick={() => setLightbox(r)}
                      title={`${r.name}（点开看大图）`}
                    >
                      <img src={r.dataUrl} alt="" style={s.refThumbImg} />
                      <span style={s.refRowBadge}>#{i + 1}</span>
                    </button>
                    <div style={s.refRowBody}>
                      <textarea
                        value={r.directive}
                        onChange={(e) => setRefDirective(r.id, e.target.value)}
                        placeholder={`#${i + 1} 怎么用：例「用它的脸」「只取背景」「参考色调」`}
                        rows={2}
                        style={s.refRowInput}
                      />
                      <div style={s.refRowFoot}>
                        <span style={s.refRowSource}>
                          {r.source === 'gallery' ? '作品集'
                           : r.source === 'paste' ? '粘贴'
                           : r.source === 'remix' ? '二创'
                           : '本地'}
                        </span>
                        <div style={s.refRowActions}>
                          {i > 0 && (
                            <button type="button" style={s.refRowBtn} onClick={() => moveRef(r.id, -1)} title="往前">‹</button>
                          )}
                          {i < refImages.length - 1 && (
                            <button type="button" style={s.refRowBtn} onClick={() => moveRef(r.id, 1)} title="往后">›</button>
                          )}
                          <button
                            type="button"
                            style={{ ...s.refRowBtn, ...s.refRowBtnDanger }}
                            onClick={() => removeRef(r.id)}
                            title="移除"
                          >×</button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
                {refImages.length < MAX_REF_IMAGES && (
                  <button type="button" style={s.refAddRow} onClick={pickRefFiles}>
                    <span style={s.refAddPlus}>＋</span>
                    <span style={s.refAddT}>加参考图</span>
                    <span style={s.refAddS}>本地 · 粘贴 · 从作品集</span>
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
            </Block>

            <Block>
              <Label title="不要什么" hint="可选" />
              <textarea
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                rows={2}
                placeholder="别的人、文字水印、漫画风…"
                style={s.negTextarea}
              />
            </Block>

            <Block refNode={styleSectionRef}>
              <Label
                title="风格 · 笔触"
                hint="点预设当起点；随便改；满意了存下来下次用"
              />
              <div style={s.styleRow}>
                <textarea
                  value={styleText}
                  onChange={(e) => { setStyleText(e.target.value); setStyleId(''); }}
                  rows={3}
                  placeholder="描述你想要的风格，例：watercolor, soft edges, muted palette"
                  style={s.styleTextarea}
                />
                <button
                  type="button"
                  onClick={openSaveStyle}
                  style={{
                    ...s.styleSaveBtn,
                    ...(!styleText.trim() || styleAlreadySaved ? s.styleSaveBtnDisabled : null),
                  }}
                  disabled={!styleText.trim() || styleAlreadySaved}
                  title={
                    !styleText.trim() ? '还没写风格'
                    : styleAlreadySaved ? '这个已经存过了'
                    : '存为预设，下次还能用'
                  }
                >
                  {styleAlreadySaved ? '已存' : '存'}
                </button>
              </div>

              {styleSaveOpen && (
                <div style={s.styleSaveForm}>
                  <input
                    type="text"
                    value={styleSaveName}
                    onChange={(e) => setStyleSaveName(e.target.value)}
                    placeholder="给它起个名字，例：我的水彩 / 80s 海报"
                    style={s.styleSaveInput}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveStyle(); } }}
                  />
                  <button type="button" onClick={saveStyle} style={s.styleSaveOK}>存</button>
                  <button type="button" onClick={() => setStyleSaveOpen(false)} style={s.styleSaveCancel}>取消</button>
                </div>
              )}

              <div style={s.stylePresets}>
                <span style={s.stylePresetsLabel}>内置</span>
                {BUILTIN_STYLES.map((st) => {
                  const active = st.id === styleId;
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => { setStyleId(st.id); setStyleText(st.suffix); }}
                      style={{ ...s.stylePresetChip, ...(active ? s.stylePresetChipOn : null) }}
                      title={st.suffix}
                    >
                      <span>{st.zh}</span>
                      {st.en && <span style={{ ...s.stylePresetChipTag, ...(active ? s.stylePresetChipTagOn : null) }}>{st.en}</span>}
                    </button>
                  );
                })}
              </div>

              {customStyles.length > 0 && (
                <div style={{ ...s.stylePresets, marginTop: 6 }}>
                  <span style={s.stylePresetsLabel}>我的</span>
                  {customStyles.map((st) => {
                    const active = st.id === styleId;
                    return (
                      <div key={st.id} style={{ ...s.stylePresetChip, ...s.stylePresetCustom, ...(active ? s.stylePresetChipOn : null) }}>
                        <button
                          type="button"
                          onClick={() => { setStyleId(st.id); setStyleText(st.suffix); }}
                          style={s.stylePresetCustomPick}
                          title={st.suffix}
                        >
                          {st.zh}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeCustomStyle(st.id)}
                          style={{ ...s.stylePresetCustomDel, ...(active ? { color: 'color-mix(in oklch, var(--paper) 70%, transparent)' } : null) }}
                          title="删"
                          aria-label="删掉这个预设"
                        >×</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {(styleText || styleId) && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => { setStyleId(''); setStyleText(''); }}
                    style={{ ...s.stylePresetChip, ...s.stylePresetClear }}
                    title="清空风格"
                  >清空</button>
                </div>
              )}
            </Block>

            <Block>
              <Label title="尺寸" />
              <div style={s.sizeGrid}>
                {SIZES.map((sz) => (
                  <button
                    key={sz.id}
                    type="button"
                    onClick={() => setSizeId(sz.id)}
                    style={{ ...s.sizeChip, ...(sz.id === sizeId ? s.sizeChipSel : null) }}
                  >
                    <span style={{
                      ...s.sizePreview,
                      ...sizeDim(sz.kind),
                      ...(sz.id === sizeId ? { background: 'var(--paper)' } : null),
                    }} />
                    {sz.label}
                  </button>
                ))}
              </div>
            </Block>

            <Block>
              <Label
                title="模型"
                hint={
                  configs.length === 0
                    ? <span style={{ color: 'var(--status-error)' }}>没有「创作可见」的 Gemini 配置</span>
                    : `${configs.length} 个可选`
                }
              />
              {configs.length === 0 ? (
                <div style={s.configEmpty}>
                  <p style={s.configEmptyText}>
                    还没有配置可用模型。去 <em style={s.configEmptyEm}>模型</em> 章节：
                  </p>
                  <ol style={s.configEmptySteps}>
                    <li>"+ 接一家" 接入 Gemini provider 并拉取可用模型</li>
                    <li>在要用的模型上勾选 "✓ 创作" 让它创作可见</li>
                    <li>回这里选它</li>
                  </ol>
                  <div style={{ marginTop: 10 }}>
                    <button type="button" style={s.gotoModelsBtn} onClick={() => navigate('/models')}>
                      去模型 →
                    </button>
                  </div>
                </div>
              ) : (
                <div style={s.modelChipRow}>
                  {configs.map((c) => {
                    const active = c.config_id === selectedConfigId;
                    const label = c.shortname || c.model || c.name;
                    return (
                      <button
                        key={c.config_id}
                        type="button"
                        onClick={() => setSelectedConfigId(c.config_id)}
                        style={{ ...s.modelChip, ...(active ? s.modelChipOn : null) }}
                        title={`${c.name} · ${c.provider}${c.model ? ' · ' + c.model : ''}`}
                      >
                        <span>{label}</span>
                        <span style={{ ...s.modelChipSub, ...(active ? s.modelChipSubOn : null) }}>
                          {c.provider}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Block>

            <Block>
              <Label title="每次画几张" hint="1 张最快 · 4 张最稳" />
              <div style={s.countRow}>
                {[1, 2, 4, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCount(n)}
                    style={{ ...s.countChip, ...(count === n ? s.countChipOn : null) }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </Block>

            {/* Cost + hint at the bottom — submit button itself moved to topbar */}
            <div style={s.draftBottomHint}>
              {refImages.length > 0 ? (
                <><span>{refImages.length} 张参考</span><span> · </span></>
              ) : null}
              <span>{count} × ¥0.20 = </span>
              <strong style={s.draftBottomCost}>¥{costEstimate.toFixed(2)}</strong>
              <span style={s.draftBottomKbd}>右上角寄出 →</span>
            </div>
          </aside>

          {/* RIGHT — RESULTS */}
          <section style={s.results}>
            <div style={s.resultsHead}>
              <h2 style={s.resultsH2}>最近几张</h2>
              <span style={s.resultsCap}>—— AUTO-SAVED TO 作品集</span>
              <div style={s.resultsActions}>
                <button type="button" style={s.ghostBtn} onClick={loadRecent}>刷新</button>
              </div>
            </div>

            {allBatches.length === 0 ? (
              <div style={s.emptyResults}>
                <p style={s.emptyText}>
                  还没画过。左边写几句，按下<em style={{ color: 'var(--accent-ink)', fontStyle: 'italic' }}>寄出</em>。
                </p>
              </div>
            ) : allBatches.map((b) => (
              <BatchView
                key={b.id}
                batch={b}
                onOpen={(item) => setPreview(item)}
                onDelete={handleDelete}
                blurredIds={blurredIds}
                onToggleBlur={toggleBlur}
              />
            ))}
          </section>
        </div>
      </PaperContent>

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

/* ---------- pieces ---------- */

const Block: React.FC<{ children: React.ReactNode; refNode?: React.RefObject<HTMLDivElement | null> }> = ({ children, refNode }) => (
  <div ref={refNode} style={{ marginBottom: 18 }}>{children}</div>
);

const Label: React.FC<{ title: React.ReactNode; hint?: React.ReactNode }> = ({ title, hint }) => (
  <div style={s.label}>
    <span>{title}</span>
    {hint && <span style={s.hint}>{hint}</span>}
  </div>
);

const BatchView: React.FC<{
  batch: Batch;
  onOpen: (item: MediaOutputItem) => void;
  onDelete: (outputId: string) => void | Promise<void>;
  blurredIds: Set<string>;
  onToggleBlur: (outputId: string) => void;
}> = ({ batch, onOpen, onDelete, blurredIds, onToggleBlur }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={s.batchMeta}>
      <span style={s.batchPromptSnip}>
        {batch.prompt.length > 56 ? batch.prompt.slice(0, 56) + '…' : batch.prompt || '（未标）'}
      </span>
      <span>{batch.pending ? '正在画' : timeAgo(batch.createdAt)} · {batch.model}{batch.aspect ? ` · ${batch.aspect}` : ''}</span>
    </div>
    <div style={s.imgGrid}>
      {batch.items.map((item, i) => (
        <Plate
          key={item?.output_id || `p-${i}`}
          item={item}
          seed={`${batch.id.slice(-4)}·${String(i + 1).padStart(2, '0')}`}
          onOpen={item ? () => onOpen(item) : undefined}
          onDelete={item ? () => onDelete(item.output_id) : undefined}
          blurred={item ? blurredIds.has(item.output_id) : false}
          onToggleBlur={item ? () => onToggleBlur(item.output_id) : undefined}
        />
      ))}
    </div>
  </div>
);

const Plate: React.FC<{
  item: MediaOutputItem | null;
  seed: string;
  onOpen?: () => void;
  onDelete?: () => void;
  blurred?: boolean;
  onToggleBlur?: () => void;
}> = ({ item, seed, onOpen, onDelete, blurred, onToggleBlur }) => {
  const [broken, setBroken] = useState(false);
  const [hover, setHover] = useState(false);
  const url = item ? mediaApi.getOutputFileUrl(item.output_id) : null;
  const clickable = !!item && !!onOpen && !broken && !blurred;
  return (
    <div
      style={{ ...s.plate, ...(clickable ? s.plateClickable : null) }}
      onClick={clickable ? onOpen : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen!(); } } : undefined}
    >
      <div style={{ ...s.plateImg, ...(item && !broken ? {} : s.plateImgPending) }}>
        {item && url && !broken ? (
          <img
            src={url}
            alt={item.prompt || 'output'}
            onError={() => setBroken(true)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              ...(blurred
                ? BLURRED_IMG_CSS
                : { filter: 'none', transform: 'none', transition: 'filter 200ms ease, transform 200ms ease' }),
            }}
          />
        ) : (
          <span style={s.plateProgressText}>{item && broken ? '找不到文件' : '正在画…'}</span>
        )}
        {blurred && item && url && !broken && (
          <span style={s.plateBlurBadge}>遮</span>
        )}
      </div>
      {item && (onDelete || onToggleBlur) && (
        <div style={{ ...s.plateActions, opacity: hover ? 1 : 0 }} onClick={(e) => e.stopPropagation()}>
          {onToggleBlur && (
            <button
              type="button"
              aria-label={blurred ? '揭开' : '遮起来'}
              title={blurred ? '揭开' : '遮起来'}
              style={s.plateAction}
              onClick={(e) => { e.stopPropagation(); onToggleBlur(); }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {blurred ? '○' : '●'}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              aria-label="撕掉"
              title="撕掉"
              style={s.plateAction}
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              ×
            </button>
          )}
        </div>
      )}
      <div style={s.plateCaption}>
        <span style={s.plateSeed}>#{seed}</span>
        <span style={s.plateTagF}>{item?.provider || '—'}</span>
      </div>
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

const timeAgo = (t: number): string => {
  if (!t) return '刚刚';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
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
};

export default CreatePage;
