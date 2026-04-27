import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mediaApi, type MediaOutputItem } from '../services/mediaApi';
import { toast } from './ui/use-toast';
import { PaperPage, PaperTopbar, PaperContent, PaperButton } from './paper';
import { loadBlurredSet, saveBlurredSet, BLURRED_IMG_CSS } from '../utils/blurred';

/* ============================================================
   作品集 / Portfolio — aligned with mockups/a-gallery.html
   ============================================================ */

type MediaFilter = 'all' | 'image' | 'video' | 'favorite';

const GalleryPage: React.FC = () => {
  const [items, setItems] = useState<MediaOutputItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MediaFilter>('all');
  const [preview, setPreview] = useState<MediaOutputItem | null>(null);
  const [blurredIds, setBlurredIds] = useState<Set<string>>(() => loadBlurredSet());
  const toggleBlur = useCallback((outputId: string) => {
    setBlurredIds((prev) => {
      const next = new Set(prev);
      if (next.has(outputId)) next.delete(outputId); else next.add(outputId);
      saveBlurredSet(next);
      return next;
    });
  }, []);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await mediaApi.listOutputs(100, 0);
      setItems(data.items || []);
    } catch (e: any) {
      setErr(e?.message || '取作品集时出错');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (filter === 'image' && it.media_type !== 'image') return false;
      if (filter === 'video' && it.media_type !== 'video') return false;
      if (filter === 'favorite' && !(it.metadata as any)?.favorite) return false;
      const q = query.trim().toLowerCase();
      if (q && !(it.prompt || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filter, query]);

  const grouped = useMemo(() => {
    const today: MediaOutputItem[] = [];
    const yesterday: MediaOutputItem[] = [];
    const week: MediaOutputItem[] = [];
    const earlier: MediaOutputItem[] = [];
    const now = Date.now();
    for (const it of filtered) {
      const t = it.created_at ? new Date(it.created_at).getTime() : 0;
      const d = now - t;
      if (!t) earlier.push(it);
      else if (d < 24 * 60 * 60 * 1000) today.push(it);
      else if (d < 2 * 24 * 60 * 60 * 1000) yesterday.push(it);
      else if (d < 8 * 24 * 60 * 60 * 1000) week.push(it);
      else earlier.push(it);
    }
    return { today, yesterday, week, earlier };
  }, [filtered]);

  const stats = useMemo(() => {
    const thisMonth = items.filter((i) => {
      if (!i.created_at) return false;
      const d = new Date(i.created_at);
      const n = new Date();
      return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
    });
    const faveCount = items.filter((i) => (i.metadata as any)?.favorite).length;
    // Style frequency — detect from prompt keywords
    const styleCount: Record<string, number> = {};
    for (const it of items) {
      const p = (it.prompt || '').toLowerCase();
      const matched = ['水墨', '油画', '照片', '素描', '插画', '日式'].find((s) => p.includes(s));
      if (matched) styleCount[matched] = (styleCount[matched] || 0) + 1;
    }
    const topStyle = Object.entries(styleCount).sort((a, b) => b[1] - a[1])[0];
    // Total cost estimate: ¥0.2 each
    const totalCost = items.length * 0.2;
    return {
      thisMonthCount: thisMonth.length,
      topStyleName: topStyle?.[0] || '—',
      topStyleCount: topStyle?.[1] || 0,
      totalCost,
      faveCount,
    };
  }, [items]);

  const handleDelete = async (item: MediaOutputItem) => {
    if (!confirm(`删掉这张「${(item.prompt || '').slice(0, 20) || '无名'}」吗？`)) return;
    try {
      await mediaApi.deleteOutput(item.output_id);
      setPreview(null);
      await load();
      toast({ title: '删了' });
    } catch (e: any) {
      toast({ title: '删不掉', description: e?.message || '', variant: 'destructive' });
    }
  };

  return (
    <PaperPage>
      <PaperTopbar
        crumb="Chapter Six · Portfolio"
        title="作品集"
        subtitle="画过的、做过的、留下来的。每一张都带着当时写的那几句话。"
        meta={loading ? '正在取…' : `${items.length} 件 · 本月 ${stats.thisMonthCount}`}
        actions={
          <>
            <PaperButton variant="ghost" size="small" onClick={load} disabled={loading}>刷新</PaperButton>
            <PaperButton onClick={() => navigate('/create')}>+ 再画一张</PaperButton>
          </>
        }
      />

      <PaperContent>
        {err && <div style={s.errBox}>{err}</div>}

        {/* Stats strip */}
        <div style={s.stats}>
          <StatCell k="这个月画了" v={String(stats.thisMonthCount)} d={stats.thisMonthCount >= items.length / 2 ? '最近在状态' : '比上个月少些'} />
          <StatCell
            k="最爱的风格"
            v={stats.topStyleName}
            d={stats.topStyleCount > 0 ? `— ${stats.topStyleCount} 张` : '还没画过'}
          />
          <StatCell k="总共花了" v={`¥ ${stats.totalCost.toFixed(2)}`} d="一杯咖啡的钱" />
          <StatCell k="收藏" v={String(stats.faveCount)} d={stats.faveCount > 0 ? '值得留下来的' : '还没收藏过'} />
        </div>

        {/* Toolbar */}
        <div style={s.tools}>
          <div style={s.search}>
            <span style={s.searchIcon}>找</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="按 prompt 找…"
              style={s.searchInput}
            />
          </div>
          <div style={s.filterChips}>
            {([
              { id: 'all', label: '全部' },
              { id: 'image', label: '图' },
              { id: 'video', label: '视频' },
              { id: 'favorite', label: '收藏' },
            ] as { id: MediaFilter; label: string }[]).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                style={{ ...s.filterChip, ...(filter === f.id ? s.filterChipOn : null) }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {loading && items.length === 0 ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <Empty hasAny={items.length > 0} onCreate={() => navigate('/create')} />
        ) : (
          <>
            {grouped.today.length > 0 && <Shelf label="今天" count={grouped.today.length}>{grouped.today.map((it) => <Piece key={it.output_id} item={it} blurred={blurredIds.has(it.output_id)} onToggleBlur={() => toggleBlur(it.output_id)} onClick={() => setPreview(it)} />)}</Shelf>}
            {grouped.yesterday.length > 0 && <Shelf label="昨天" count={grouped.yesterday.length}>{grouped.yesterday.map((it) => <Piece key={it.output_id} item={it} blurred={blurredIds.has(it.output_id)} onToggleBlur={() => toggleBlur(it.output_id)} onClick={() => setPreview(it)} />)}</Shelf>}
            {grouped.week.length > 0 && <Shelf label="这周早些时候" count={grouped.week.length}>{grouped.week.map((it) => <Piece key={it.output_id} item={it} blurred={blurredIds.has(it.output_id)} onToggleBlur={() => toggleBlur(it.output_id)} onClick={() => setPreview(it)} />)}</Shelf>}
            {grouped.earlier.length > 0 && <Shelf label="早些时候" count={grouped.earlier.length}>{grouped.earlier.map((it) => <Piece key={it.output_id} item={it} blurred={blurredIds.has(it.output_id)} onToggleBlur={() => toggleBlur(it.output_id)} onClick={() => setPreview(it)} />)}</Shelf>}
          </>
        )}
      </PaperContent>

      {preview && (
        <PreviewModal
          item={preview}
          blurred={blurredIds.has(preview.output_id)}
          onToggleBlur={() => toggleBlur(preview.output_id)}
          onClose={() => setPreview(null)}
          onDelete={() => handleDelete(preview)}
          onRemix={() => {
            const item = preview;
            setPreview(null);
            navigate('/create', { state: { remix: item } });
          }}
        />
      )}
    </PaperPage>
  );
};

/* ---------- pieces ---------- */

const StatCell: React.FC<{ k: string; v: string; d: string }> = ({ k, v, d }) => (
  <div style={s.statCell}>
    <div style={s.statK}>{k}</div>
    <div style={s.statV}>{v}</div>
    <div style={s.statD}>{d}</div>
  </div>
);

const Shelf: React.FC<{ label: string; count: number; children: React.ReactNode }> = ({ label, count, children }) => (
  <div style={{ marginBottom: 40 }}>
    <div style={s.shelfLabel}>
      <span>{label}</span>
      <span style={s.shelfCount}>{count} 张</span>
      <span style={s.shelfLine} />
    </div>
    <div style={s.mosaic}>{children}</div>
  </div>
);

const Piece: React.FC<{
  item: MediaOutputItem;
  onClick: () => void;
  blurred: boolean;
  onToggleBlur: () => void;
}> = ({ item, onClick, blurred, onToggleBlur }) => {
  const url = mediaApi.getOutputFileUrl(item.output_id);
  const [broken, setBroken] = useState(false);
  // Only set aspect-ratio when we actually know the image dimensions —
  // otherwise the previous "random pretty fraction" fallback combined with
  // object-fit: cover cropped real content (the user's complaint). Unknown
  // size → let the image's natural aspect dictate height (true masonry).
  const knownAspect = aspectOf(item);
  const isFave = (item.metadata as any)?.favorite;
  const title = (item.prompt || '').split(/[.。\n]/)[0].slice(0, 40) || '无名';
  return (
    <div style={{ ...s.piece, cursor: blurred ? 'default' : 'pointer' }}>
      <button
        type="button"
        style={s.pieceClick}
        onClick={() => { if (!blurred) onClick(); }}
        disabled={blurred}
        aria-label={blurred ? '已遮起来' : '打开'}
      >
        {item.media_type === 'video' && (
          <span style={{ ...s.badge, ...s.badgeVideo }}>VIDEO</span>
        )}
        {isFave && (
          <span style={{ ...s.badge, ...s.badgeFave }}>♡</span>
        )}
        <div style={{ ...s.pieceImg, ...(knownAspect ? { aspectRatio: knownAspect } : null) }}>
          {!broken ? (
            <img
              src={url}
              alt={item.prompt || 'output'}
              onError={() => setBroken(true)}
              loading="lazy"
              style={{
                width: '100%', display: 'block',
                // contain — never crop; let the actual image be visible
                // in full. With the surrounding column-width masonry the
                // tiles size themselves to the image's natural aspect.
                height: knownAspect ? '100%' : 'auto',
                objectFit: knownAspect ? 'contain' : undefined,
                background: 'color-mix(in oklch, var(--rule) 60%, var(--page-elev))',
                ...(blurred
                  ? BLURRED_IMG_CSS
                  : { filter: 'none', transform: 'none', transition: 'filter 200ms ease, transform 200ms ease' }),
              }}
            />
          ) : (
            <span style={s.pieceBroken}>—</span>
          )}
          {blurred && !broken && <span style={s.pieceBlurBadge}>遮</span>}
        </div>
        <div style={s.pieceCaption}>
          <span style={s.pieceTitle}>{blurred ? '已遮起来' : title}</span>
          <span style={s.pieceDate}>{relDate(item.created_at)}</span>
        </div>
      </button>
      <button
        type="button"
        aria-label={blurred ? '揭开' : '遮起来'}
        title={blurred ? '揭开' : '遮起来'}
        style={s.pieceBlurBtn}
        onClick={(e) => { e.stopPropagation(); onToggleBlur(); }}
      >
        {blurred ? '○' : '●'}
      </button>
    </div>
  );
};

const PreviewModal: React.FC<{
  item: MediaOutputItem;
  blurred: boolean;
  onToggleBlur: () => void;
  onClose: () => void;
  onDelete: () => void;
  onRemix: () => void;
}> = ({ item, blurred, onToggleBlur, onClose, onDelete, onRemix }) => {
  const url = mediaApi.getOutputFileUrl(item.output_id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalImgWrap}>
          <img
            src={url}
            alt={item.prompt || 'output'}
            style={{
              ...s.modalImg,
              ...(blurred
                ? BLURRED_IMG_CSS
                : { filter: 'none', transform: 'none', transition: 'filter 200ms ease, transform 200ms ease' }),
            }}
          />
        </div>
        <div style={s.modalInfo}>
          <div style={s.modalHead}>
            <div style={s.modalCrumb}>作品 · {relDate(item.created_at)}</div>
            <button type="button" onClick={onClose} style={s.modalClose}>×</button>
          </div>
          {item.prompt && <p style={s.modalPrompt}>「{item.prompt}」</p>}
          <dl style={s.modalMeta}>
            <MetaRow k="Model" v={item.model || '—'} />
            <MetaRow k="Provider" v={item.provider || '—'} />
            <MetaRow k="Type" v={item.media_type} />
            <MetaRow k="Size" v={item.file_size ? `${Math.round((item.file_size || 0) / 1024)} KB` : '—'} />
          </dl>
          <div style={{ ...s.modalFoot, flexWrap: 'wrap', gap: 8 }}>
            <PaperButton variant="ghost" size="small" onClick={onToggleBlur}>{blurred ? '揭开' : '遮起来'}</PaperButton>
            <PaperButton variant="ghost" size="small" onClick={() => window.open(url, '_blank')}>原图</PaperButton>
            <PaperButton size="small" onClick={onRemix} title="把这张当参考，去创作页改">二创 →</PaperButton>
            <span style={{ flex: 1 }} />
            <PaperButton variant="link" danger onClick={onDelete}>删</PaperButton>
          </div>
        </div>
      </div>
    </div>
  );
};

const MetaRow: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div style={s.metaRow}>
    <dt style={s.metaK}>{k}</dt>
    <dd style={s.metaV}>{v}</dd>
  </div>
);

const Loading: React.FC = () => (
  <div style={{ textAlign: 'center', padding: '48px 0', fontFamily: "'Young Serif', serif", fontStyle: 'italic', color: 'var(--pencil)' }}>
    正在翻画册…
  </div>
);

const Empty: React.FC<{ hasAny: boolean; onCreate: () => void }> = ({ hasAny, onCreate }) => (
  <div style={s.empty}>
    <div style={{ fontFamily: "'Young Serif', serif", fontSize: 40, color: 'var(--accent-ink)', lineHeight: 1, marginBottom: 12 }}>📖</div>
    <h3 style={s.emptyTitle}>{hasAny ? '没有符合的' : '画册空着'}</h3>
    <p style={s.emptyHint}>
      {hasAny ? '换个筛选试试。' : '在「创作」里画一张，这里会自动收进来。'}
    </p>
    {!hasAny && (
      <div style={{ marginTop: 20 }}>
        <PaperButton onClick={onCreate}>去画第一张 →</PaperButton>
      </div>
    )}
  </div>
);

/* ---------- utils ---------- */

// Returns an aspect-ratio string only when we genuinely know the dimensions.
// Empty string ⇒ caller doesn't pin aspect-ratio and the image renders at
// its natural size (height: auto), so the user always sees the full picture.
const aspectOf = (item: MediaOutputItem): string => {
  const m = item.metadata as any;
  if (m?.aspect_ratio) return String(m.aspect_ratio).replace(':', ' / ');
  if (m?.width && m?.height) return `${m.width} / ${m.height}`;
  return '';
};

const relDate = (iso?: string): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const d = Date.now() - t;
  if (d < 60 * 1000) return '刚';
  if (d < 60 * 60 * 1000) return `${Math.floor(d / 60000)}m`;
  if (d < 24 * 60 * 60 * 1000) return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor(d / 86400000);
  if (days === 1) return '昨';
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

const s: Record<string, React.CSSProperties> = {
  errBox: {
    padding: '12px 14px',
    background: 'var(--status-error-bg)',
    border: '1px solid color-mix(in oklch, var(--status-error) 30%, transparent)',
    color: 'oklch(0.40 0.130 25)',
    fontSize: 13,
    borderRadius: 2,
    marginBottom: 20,
    fontFamily: "'Young Serif', serif",
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 0,
    border: '1px solid var(--rule)',
    background: 'var(--rule)',
    marginBottom: 28,
    borderRadius: 3,
    overflow: 'hidden',
  },
  statCell: {
    background: 'var(--page-elev)',
    padding: '14px 20px',
  },
  statK: {
    fontSize: 10.5,
    letterSpacing: '0.2em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
  },
  statV: {
    fontFamily: "'Young Serif', serif",
    fontSize: 26,
    color: 'var(--ink-strong)',
    lineHeight: 1.1,
    marginTop: 4,
  },
  statD: {
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    fontSize: 11.5,
    color: 'var(--marginalia-ink)',
    marginTop: 2,
  },
  tools: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    flexWrap: 'wrap',
    marginBottom: 24,
  },
  search: { flex: 1, minWidth: 220, position: 'relative' },
  searchIcon: {
    position: 'absolute',
    left: 13, top: '50%', transform: 'translateY(-50%)',
    fontFamily: "'Young Serif', serif",
    fontSize: 13, color: 'var(--accent-ink)',
  },
  searchInput: {
    width: '100%',
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    padding: '10px 14px 10px 36px',
    fontFamily: "'Commissioner', sans-serif",
    fontSize: 14, color: 'var(--ink)', outline: 'none',
  },
  filterChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  filterChip: {
    padding: '3px 10px',
    fontSize: 11.5,
    fontFamily: "'Young Serif', serif",
    color: 'var(--pencil)',
    background: 'transparent',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    cursor: 'pointer',
  },
  filterChipOn: {
    background: 'var(--accent-ink)',
    color: 'var(--paper)',
    borderColor: 'var(--accent-ink)',
  },
  shelfLabel: {
    fontFamily: "'Young Serif', serif",
    fontSize: 16,
    color: 'var(--ink-strong)',
    marginBottom: 14,
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    paddingBottom: 6,
    borderBottom: '1px solid var(--rule)',
  },
  shelfCount: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, color: 'var(--pencil)',
    letterSpacing: '0.08em',
  },
  shelfLine: { flex: 1 },
  mosaic: {
    // Switch from a fixed 4 columns to a target column-width — denser and
    // responsive. ~190px gives ~6 columns on a 1280-wide canvas, ~8 on
    // a 1600-wide one. User sees more variety per screen instead of 4
    // big tiles.
    columnWidth: 190,
    columnGap: 12,
  },
  piece: {
    breakInside: 'avoid',
    marginBottom: 12,
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 2,
    overflow: 'hidden',
    transition: 'transform 200ms cubic-bezier(0.22,1,0.36,1), box-shadow 200ms',
    boxShadow: '0 1px 2px oklch(0.18 0.02 310 / 0.04)',
    position: 'relative',
    display: 'block',
    width: '100%',
  },
  pieceClick: {
    display: 'block',
    width: '100%',
    background: 'transparent',
    border: 0,
    padding: 0,
    textAlign: 'left',
    cursor: 'inherit',
    color: 'inherit',
    font: 'inherit',
  },
  pieceBlurBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    fontFamily: "'Young Serif', serif",
    fontSize: 11,
    color: 'var(--paper)',
    background: 'color-mix(in oklch, var(--ink) 70%, transparent)',
    padding: '2px 8px',
    borderRadius: 1,
    letterSpacing: '0.08em',
    zIndex: 2,
  },
  pieceBlurBtn: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 22,
    height: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in oklch, var(--page-elev) 85%, transparent)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 999,
    color: 'var(--pencil)',
    fontSize: 10,
    cursor: 'pointer',
    padding: 0,
    zIndex: 3,
  },
  badge: {
    position: 'absolute',
    top: 8, right: 8,
    fontFamily: "'Young Serif', serif",
    fontSize: 10,
    color: 'var(--paper)',
    padding: '2px 7px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    borderRadius: 1,
    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
    zIndex: 2,
  },
  badgeFave: {
    background: 'var(--marginalia-ink)',
    textTransform: 'none',
    fontSize: 12,
    padding: '2px 6px',
  },
  badgeVideo: { background: 'oklch(0.42 0.100 25)' },
  pieceImg: {
    width: '100%',
    display: 'block',
    overflow: 'hidden',
    background: 'color-mix(in oklch, var(--rule) 50%, var(--page-elev))',
  },
  pieceBroken: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: 18,
    color: 'var(--pencil-soft)',
  },
  pieceCaption: {
    padding: '6px 9px 7px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 6,
  },
  pieceTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 12,
    color: 'var(--ink)',
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  pieceDate: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 9.5,
    color: 'var(--pencil-soft)',
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap',
  },
  empty: {
    padding: '64px 32px',
    textAlign: 'center',
    border: '2px dashed var(--rule-strong)',
    borderRadius: 4,
    color: 'var(--pencil)',
  },
  emptyTitle: {
    fontFamily: "'Young Serif', serif",
    fontSize: 18,
    color: 'var(--ink-strong)',
    margin: 0,
  },
  emptyHint: {
    marginTop: 10,
    fontSize: 13,
    color: 'var(--pencil)',
    fontFamily: "'Young Serif', serif",
    fontStyle: 'italic',
    maxWidth: '44ch',
    margin: '10px auto 0',
  },
  /* Modal */
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'color-mix(in oklch, var(--ink) 55%, transparent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
    padding: 40,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  modal: {
    background: 'var(--page-elev)',
    border: '1px solid var(--rule-strong)',
    borderRadius: 3,
    boxShadow: '0 20px 60px oklch(0.18 0.02 310 / 0.40)',
    display: 'grid',
    gridTemplateColumns: '1fr 320px',
    gap: 0,
    width: '100%',
    maxWidth: 1100,
    maxHeight: '85vh',
    overflow: 'hidden',
  },
  modalImgWrap: {
    background: 'color-mix(in oklch, var(--ink) 20%, var(--paper))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    minHeight: 400,
  },
  modalImg: {
    maxWidth: '100%',
    maxHeight: '75vh',
    objectFit: 'contain',
  },
  modalInfo: {
    padding: '28px 28px 22px',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid var(--rule)',
    overflowY: 'auto',
  },
  modalHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 14,
  },
  modalCrumb: {
    fontSize: 10.5,
    color: 'var(--pencil)',
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
  },
  modalClose: {
    background: 'transparent',
    border: 0,
    color: 'var(--pencil)',
    fontSize: 22,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 0,
  },
  modalPrompt: {
    fontFamily: "'Young Serif', serif",
    fontSize: 14.5,
    lineHeight: 1.7,
    color: 'var(--ink)',
    margin: 0,
    paddingBottom: 18,
    borderBottom: '1px dotted var(--rule)',
  },
  modalMeta: {
    margin: '18px 0 0',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    flex: 1,
  },
  metaRow: {
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    gap: 8,
    padding: '8px 0',
    borderBottom: '1px dotted var(--rule)',
    alignItems: 'baseline',
    margin: 0,
  },
  metaK: {
    fontSize: 10.5,
    letterSpacing: '0.18em',
    color: 'var(--pencil)',
    textTransform: 'uppercase',
    margin: 0,
  },
  metaV: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: 'var(--ink)',
    margin: 0,
    wordBreak: 'break-all',
  },
  modalFoot: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: '1px solid var(--rule)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
};

export default GalleryPage;
