import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mediaApi, type MediaOutputItem, type ModelRegistryEntry } from '../services/mediaApi';
import { getLLMConfigs, type LLMConfigFromDB } from '../services/llmApi';
import { toast } from './ui/use-toast';
import { PaperPage, PaperTopbar, PaperContent } from './paper';

/* ============================================================
   创作 / Atelier — aligned with mockups/a-create.html
   ============================================================ */

const STYLES: { id: string; zh: string; en: string; suffix: string }[] = [
  { id: 'ink',    zh: '水墨',   en: 'INK',    suffix: 'chinese ink painting, traditional brushwork, on rice paper' },
  { id: 'oil',    zh: '油画',   en: 'OIL',    suffix: 'oil painting, thick impasto, classical composition' },
  { id: 'photo',  zh: '照片',   en: 'PHOTO',  suffix: 'photorealistic, 35mm film, natural lighting' },
  { id: 'sketch', zh: '素描',   en: 'SKETCH', suffix: 'graphite sketch on paper, loose strokes' },
  { id: 'illo',   zh: '插画',   en: 'ILLO',   suffix: 'editorial illustration, flat shapes, muted palette' },
  { id: 'jp',     zh: '日式',   en: 'JP',     suffix: 'Japanese woodblock print style, ukiyo-e influence' },
];

const SIZES: { id: string; label: string; kind: 'square' | 'landscape' | 'portrait'; aspect: string }[] = [
  { id: '1:1',  label: '1:1',  kind: 'square',    aspect: '1:1' },
  { id: '3:2',  label: '3:2',  kind: 'landscape', aspect: '3:2' },
  { id: '2:3',  label: '2:3',  kind: 'portrait',  aspect: '2:3' },
  { id: '16:9', label: '16:9', kind: 'landscape', aspect: '16:9' },
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
  const [styleId, setStyleId] = useState('ink');
  const [sizeId, setSizeId] = useState('1:1');
  const [count, setCount] = useState(4);
  const [seed, setSeed] = useState('');
  const [modelId, setModelId] = useState<string>('');
  const [providers, setProviders] = useState<ModelRegistryEntry[]>([]);
  const [configs, setConfigs] = useState<LLMConfigFromDB[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recentOutputs, setRecentOutputs] = useState<MediaOutputItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [refImages, setRefImages] = useState<RefImage[]>([]);
  const [refDirective, setRefDirective] = useState('');
  const refFileInput = useRef<HTMLInputElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const location = useLocation();
  const navigate = useNavigate();

  const loadProviders = useCallback(async () => {
    try {
      const data = await mediaApi.getProviders();
      const models = (data.model_registry || []).filter((m) => m.image);
      setProviders(models);
      if (!modelId && models.length > 0) {
        const rec = models.find((m) => m.recommended) || models[0];
        setModelId(rec.label);
      }
    } catch {/* */}
  }, [modelId]);

  const loadConfigs = useCallback(async () => {
    try {
      const list = await getLLMConfigs();
      setConfigs(list.filter((c) => c.enabled && c.media_visible));
    } catch {/* */}
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const data = await mediaApi.listOutputs(24, 0);
      setRecentOutputs(data.items || []);
    } catch {/* */}
  }, []);

  /* ---------- reference images ---------- */

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
    void loadProviders();
    void loadConfigs();
    void loadRecent();
  }, [loadProviders, loadConfigs, loadRecent]);

  const selectedModel = providers.find((m) => m.label === modelId);

  const costEstimate = count * 0.2;

  /** Compose the final prompt: user text + style suffix + ref directive + ref-numbering hint. */
  const finalPromptForSubmit = useMemo(() => {
    const base = prompt.trim();
    if (!base) return '';
    const parts: string[] = [base];
    const style = STYLES.find((s) => s.id === styleId);
    if (style) parts.push(style.suffix);
    if (negative.trim()) parts.push(`(avoid: ${negative.trim()})`);
    if (refImages.length > 0) {
      const labels = refImages.map((_, i) => `#${i + 1}`).join(' / ');
      parts.push(`(refs: ${labels})`);
      if (refDirective.trim()) parts.push(`(how to use refs: ${refDirective.trim()})`);
    }
    return parts.join('. ');
  }, [prompt, styleId, negative, refImages, refDirective]);

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      toast({ title: '写点东西', description: '左上"你想画什么"先写几句', variant: 'default' });
      return;
    }
    const config = configs[0]; // first media-capable config
    if (!config && !selectedModel) {
      toast({ title: '还没配 provider', description: '去「模型」里开启一个支持图像的 provider', variant: 'destructive' });
      return;
    }

    const isEdit = refImages.length > 0;
    const promptForSubmit = finalPromptForSubmit;
    const batchId = `b-${Date.now()}`;
    const newBatch: Batch = {
      id: batchId,
      prompt: promptForSubmit,
      style: styleId,
      model: modelId || selectedModel?.label || 'gemini-image',
      aspect: sizeId,
      items: new Array(count).fill(null),
      createdAt: Date.now(),
      pending: true,
    };
    setBatches((prev) => [newBatch, ...prev]);
    setSubmitting(true);

    try {
      const res = isEdit
        ? await mediaApi.geminiImageEdit({
            prompt: promptForSubmit,
            images_b64: refImages.map((r) => r.data),
            config_id: config?.config_id,
            model: modelId || undefined,
            aspect_ratio: sizeId,
            count,
          })
        : await mediaApi.geminiImageGenerate({
            prompt: promptForSubmit,
            config_id: config?.config_id,
            model: modelId || undefined,
            aspect_ratio: sizeId,
            count,
          });
      if (res.error) throw new Error(res.error);
      await loadRecent();
      setBatches((prev) =>
        prev.map((b) => (b.id === batchId ? { ...b, pending: false } : b)),
      );
      toast({ title: isEdit ? '改完了' : '画完了', variant: 'success' });
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
      setSubmitting(false);
    }
  };

  // Group recent outputs into "done" batches by prompt similarity + timestamp window.
  const doneBatches = useMemo<Batch[]>(() => {
    const groups: Record<string, MediaOutputItem[]> = {};
    for (const o of recentOutputs) {
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
  }, [recentOutputs]);

  const allBatches = [...batches, ...doneBatches];

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Five · Atelier"
        title="创作"
        subtitle="写几句你想要的画面，按下寄出。画完的会自动收进作品集。"
        meta={selectedModel ? `${selectedModel.label} · ${sizeId}` : '未选模型'}
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
            </Block>

            {/* 参考图 */}
            <Block>
              <Label
                title={refImages.length > 0 ? `参考图 · #1 到 #${refImages.length}` : '参考图'}
                hint={refImages.length === 0 ? '粘贴 / 上传 / 从作品集挑' : '可拖移调整顺序'}
              />
              <div style={s.refGrid}>
                {refImages.map((r, i) => (
                  <div key={r.id} style={s.refCard} title={r.name}>
                    <img src={r.dataUrl} alt="" style={s.refThumb} />
                    <span style={s.refBadge}>#{i + 1}</span>
                    <div style={s.refCardOverlay}>
                      {i > 0 && (
                        <button type="button" style={s.refOverlayBtn} onClick={() => moveRef(r.id, -1)} title="往前">‹</button>
                      )}
                      {i < refImages.length - 1 && (
                        <button type="button" style={s.refOverlayBtn} onClick={() => moveRef(r.id, 1)} title="往后">›</button>
                      )}
                      <button type="button" style={{ ...s.refOverlayBtn, ...s.refOverlayBtnDanger }} onClick={() => removeRef(r.id)} title="移除">×</button>
                    </div>
                    <span style={s.refSource}>
                      {r.source === 'gallery' ? '作品集' : r.source === 'paste' ? '粘贴' : r.source === 'remix' ? '二创' : '本地'}
                    </span>
                  </div>
                ))}
                {refImages.length < MAX_REF_IMAGES && (
                  <button type="button" style={s.refAddCard} onClick={pickRefFiles}>
                    <span style={s.refAddPlus}>＋</span>
                    <span style={s.refAddT}>加一张</span>
                    <span style={s.refAddS}>本地 · 或粘贴到上面</span>
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
              {refImages.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={s.refDirectiveLabel}>怎么用这些参考</div>
                  <textarea
                    value={refDirective}
                    onChange={(e) => setRefDirective(e.target.value)}
                    rows={2}
                    placeholder="例：主体用 #1 的人物，但换成 #2 的服装。背景参考 #3 的光线。"
                    style={s.negTextarea}
                  />
                </div>
              )}
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

            <Block>
              <Label title="风格 · 笔触" />
              <div style={s.styleGrid}>
                {STYLES.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    onClick={() => setStyleId(st.id)}
                    style={{ ...s.styleChip, ...(st.id === styleId ? s.styleChipSel : null) }}
                  >
                    <div style={s.styleT}>{st.zh}</div>
                    <div style={{ ...s.styleS, ...(st.id === styleId ? s.styleSSel : null) }}>{st.en}</div>
                  </button>
                ))}
              </div>
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
              <Label title="参数" />
              <ParamRow
                title="模型"
                desc="画什么样的画用什么笔"
                control={
                  <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={s.paramSelect}>
                    {providers.length === 0 && <option value="">(无可用)</option>}
                    {providers.map((m) => (
                      <option key={m.label} value={m.label}>{m.label}{m.recommended ? ' ★' : ''}</option>
                    ))}
                  </select>
                }
              />
              <ParamRow
                title="每次画几张"
                desc="1 张最快 · 4 张最稳"
                control={
                  <select value={count} onChange={(e) => setCount(Number(e.target.value))} style={s.paramSelect}>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={4}>4</option>
                    <option value={8}>8</option>
                  </select>
                }
              />
              <ParamRow
                title="种子"
                desc="给同一个 seed 会画出相似的"
                control={
                  <input
                    type="text"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    placeholder="留空 · 随机"
                    style={s.paramInput}
                  />
                }
                last
              />
            </Block>
          </aside>

          {/* LEFT FOOT sticky — submit */}
          <div style={s.draftFoot}>
            <span style={s.costNote}>
              {refImages.length > 0
                ? (<><span>{refImages.length} 参考 · {count} 张</span><br /><span>¥ {costEstimate.toFixed(2)}</span></>)
                : (<>{count} × ¥0.20<br />= ¥{costEstimate.toFixed(2)}</>)}
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !prompt.trim()}
              style={{
                ...s.inkBtn,
                ...(submitting || !prompt.trim() ? s.inkBtnDisabled : null),
              }}
            >
              {submitting
                ? (refImages.length > 0 ? '正在改…' : '正在画…')
                : (refImages.length > 0 ? '按参考改 →' : '寄出 →')}
            </button>
          </div>

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
              <BatchView key={b.id} batch={b} />
            ))}
          </section>
        </div>
      </PaperContent>
    </PaperPage>
  );
};

/* ---------- pieces ---------- */

const Block: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ marginBottom: 24 }}>{children}</div>
);

const Label: React.FC<{ title: React.ReactNode; hint?: React.ReactNode }> = ({ title, hint }) => (
  <div style={s.label}>
    <span>{title}</span>
    {hint && <span style={s.hint}>{hint}</span>}
  </div>
);

const ParamRow: React.FC<{ title: string; desc: string; control: React.ReactNode; last?: boolean }> = ({ title, desc, control, last }) => (
  <div style={{ ...s.paramRow, ...(last ? { borderBottom: 0 } : null) }}>
    <div>
      <div style={s.paramTitle}>{title}</div>
      <div style={s.paramDesc}>{desc}</div>
    </div>
    <div style={s.paramCtrl}>{control}</div>
  </div>
);

const BatchView: React.FC<{ batch: Batch }> = ({ batch }) => (
  <div style={{ marginBottom: 40 }}>
    <div style={s.batchMeta}>
      <span style={s.batchPromptSnip}>
        {batch.prompt.length > 56 ? batch.prompt.slice(0, 56) + '…' : batch.prompt || '（未标）'}
      </span>
      <span>{batch.pending ? '正在画' : timeAgo(batch.createdAt)} · {batch.model}{batch.aspect ? ` · ${batch.aspect}` : ''}</span>
    </div>
    <div style={s.imgGrid}>
      {batch.items.map((item, i) => (
        <Plate key={item?.output_id || `p-${i}`} item={item} seed={`${batch.id.slice(-4)}·${String(i + 1).padStart(2, '0')}`} />
      ))}
    </div>
  </div>
);

const Plate: React.FC<{ item: MediaOutputItem | null; seed: string }> = ({ item, seed }) => {
  const [broken, setBroken] = useState(false);
  const url = item ? mediaApi.getOutputFileUrl(item.output_id) : null;
  return (
    <div style={s.plate}>
      <div style={{ ...s.plateImg, ...(item && !broken ? {} : s.plateImgPending) }}>
        {item && url && !broken ? (
          <img
            src={url}
            alt={item.prompt || 'output'}
            onError={() => setBroken(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span style={s.plateProgressText}>{item && broken ? '找不到文件' : '正在画…'}</span>
        )}
      </div>
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
    gridTemplateColumns: '360px 1fr',
    gridTemplateRows: '1fr auto',
    gridTemplateAreas: `"draft results" "foot results"`,
    height: '100%',
    minHeight: 0,
    overflow: 'hidden',
  },
  draft: {
    gridArea: 'draft',
    borderRight: '1px solid var(--rule)',
    overflowY: 'auto',
    padding: '28px 28px 8px',
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
    display: 'flex',
    flexDirection: 'column',
  },
  draftFoot: {
    gridArea: 'foot',
    borderRight: '1px solid var(--rule)',
    borderTop: '1px solid var(--rule)',
    padding: '14px 28px 18px',
    background: 'color-mix(in oklch, var(--paper) 50%, var(--page))',
    display: 'flex',
    gap: 12,
    alignItems: 'center',
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
    marginBottom: 8,
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
  /* Reference images */
  refGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  refCard: {
    position: 'relative',
    aspectRatio: '1 / 1',
    background: 'color-mix(in oklch, var(--ink) 5%, var(--page-elev))',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  refThumb: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  refBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 12,
    color: 'var(--paper)',
    background: 'var(--accent-ink)',
    padding: '1px 7px',
    borderRadius: 1,
    letterSpacing: '0.05em',
    boxShadow: '0 1px 2px oklch(0 0 0 / 0.25)',
  },
  refSource: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--paper)',
    background: 'color-mix(in oklch, var(--ink) 75%, transparent)',
    padding: '1px 6px',
    borderRadius: 1,
    letterSpacing: '0.06em',
  },
  refCardOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    padding: 4,
    display: 'flex',
    gap: 2,
    opacity: 0.9,
    background: 'linear-gradient(220deg, oklch(0 0 0 / 0.35), transparent 60%)',
    pointerEvents: 'auto',
  },
  refOverlayBtn: {
    width: 22, height: 22,
    background: 'var(--paper)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  refOverlayBtnDanger: {
    color: 'var(--status-error)',
  },
  refAddCard: {
    aspectRatio: '1 / 1',
    background: 'transparent',
    border: '1.5px dashed var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: 6,
    transition: 'border-color 180ms cubic-bezier(0.22,1,0.36,1), color 180ms',
    color: 'var(--pencil)',
  },
  refAddPlus: {
    fontFamily: "'Young Serif', 'LXGW WenKai', ui-serif, serif",
    fontSize: 22,
    color: 'var(--accent-ink)',
    lineHeight: 1,
  },
  refAddT: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    color: 'var(--ink)',
  },
  refAddS: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
    textAlign: 'center',
  },
  refDirectiveLabel: {
    fontSize: 10.5,
    letterSpacing: '0.22em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  styleGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 },
  styleChip: {
    padding: '10px 8px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    textAlign: 'center',
    cursor: 'pointer',
    background: 'var(--page-elev)',
    transition: 'all 180ms cubic-bezier(0.22,1,0.36,1)',
  },
  styleChipSel: {
    borderColor: 'var(--accent-ink)',
    background: 'var(--accent-soft)',
  },
  styleT: { fontFamily: "'Young Serif', 'LXGW WenKai', serif", fontSize: 12.5, color: 'var(--ink)' },
  styleS: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil)',
    letterSpacing: '0.08em',
    marginTop: 2,
  },
  styleSSel: { color: 'var(--accent-ink)' },
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
    gridArea: 'results',
    overflowY: 'auto',
    padding: '28px 40px 60px',
    gridRow: '1 / span 2',
  },
  resultsHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 14,
    marginBottom: 18,
    paddingBottom: 10,
    borderBottom: '1px solid var(--rule)',
  },
  resultsH2: {
    fontFamily: "'Young Serif', serif",
    fontSize: 20,
    color: 'var(--ink-strong)',
    fontWeight: 400,
    margin: 0,
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
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10.5,
    color: 'var(--pencil)',
    marginBottom: 10,
    letterSpacing: '0.06em',
  },
  batchPromptSnip: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    color: 'var(--ink)',
    fontSize: 12.5,
    maxWidth: '56ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: 0,
  },
  imgGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 14,
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
  plateProgressText: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: 'var(--pencil)',
    background: 'var(--page-elev)',
    padding: '4px 10px',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
  },
  plateCaption: {
    padding: '8px 10px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: 'var(--pencil)',
    letterSpacing: '0.06em',
  },
  plateSeed: {},
  plateTagF: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11,
    color: 'var(--accent-ink)',
    letterSpacing: 0,
  },
};

export default CreatePage;
