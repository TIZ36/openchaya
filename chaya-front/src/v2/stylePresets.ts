/** v2 custom style presets — backend-only via primary agent's ext.style_presets.
 *  No localStorage. Reads/writes go through /api/agents/{primary_id}/profile. */
import { getAgents, type Session } from '../services/chat';
import { updateRoleProfile } from '../services/roleApi';

export interface StylePreset {
  id: string;
  zh: string;
  en?: string;
  suffix: string;
  custom?: boolean;
}

export const BUILTIN_STYLES: StylePreset[] = [
  { id: 'ink',    zh: '水墨',   en: 'INK',    suffix: 'chinese ink painting, traditional brushwork, on rice paper' },
  { id: 'oil',    zh: '油画',   en: 'OIL',    suffix: 'oil painting, thick impasto, classical composition' },
  { id: 'photo',  zh: '照片',   en: 'PHOTO',  suffix: 'photorealistic, 35mm film, natural lighting' },
  { id: 'sketch', zh: '素描',   en: 'SKETCH', suffix: 'graphite sketch on paper, loose strokes' },
  { id: 'illo',   zh: '插画',   en: 'ILLO',   suffix: 'editorial illustration, flat shapes, muted palette' },
  { id: 'jp',     zh: '日式',   en: 'JP',     suffix: 'Japanese woodblock print style, ukiyo-e influence' },
];

/* ============ in-memory cache (this session only) ============ */

let cache: StylePreset[] | null = null;
let primary: Session | null = null;
const subs = new Set<() => void>();
function notify() { for (const s of subs) s(); }

export function subscribeStyleChanges(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/* ============ load / refresh from backend ============ */

async function fetchPrimary(): Promise<Session | null> {
  try {
    const agents = await getAgents();
    return (agents || []).find((a) => a.is_primary) || (agents || [])[0] || null;
  } catch (e) {
    console.warn('[stylePresets] getAgents failed', e);
    return null;
  }
}

function extractStylesFromAgent(a: Session | null): StylePreset[] {
  if (!a) return [];
  const raw = (a.ext as any)?.style_presets;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x: any) => x && typeof x.id === 'string' && typeof x.zh === 'string' && typeof x.suffix === 'string')
    .map((x: any) => ({ id: x.id, zh: x.zh, en: x.en, suffix: x.suffix, custom: true }));
}

export interface SyncReport {
  ok: boolean;
  fromBackend: number;
  merged: number;
  error?: string;
}

/* ---- v1 → v2 migration -----------------------------------------------
 * v1 stored custom styles in localStorage under `chaya_style_presets`.
 * v2 lives entirely on the primary agent's ext.style_presets. On the first
 * sync we silently merge any v1 entries that aren't already on the backend
 * (matched by suffix), push the union, then clear the legacy LS key so we
 * don't keep re-migrating. */
const LS_V1_STYLES = 'chaya_style_presets';

function readV1LocalStyles(): StylePreset[] {
  try {
    const raw = localStorage.getItem(LS_V1_STYLES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x: any) => x && typeof x.id === 'string' && typeof x.zh === 'string' && typeof x.suffix === 'string')
      .map((x: any) => ({ id: x.id, zh: x.zh, en: x.en, suffix: x.suffix, custom: true as const }));
  } catch { return []; }
}

function clearV1LocalStyles() {
  try { localStorage.removeItem(LS_V1_STYLES); } catch { /* ignore */ }
}

/** Pull custom styles from the primary agent's ext.style_presets.
 *  On first run, also imports anything still sitting in v1 localStorage. */
export async function syncCustomStylesFromBackend(): Promise<{ list: StylePreset[]; report: SyncReport }> {
  try {
    primary = await fetchPrimary();
    if (!primary) {
      // Still expose v1 LS locally so the user doesn't lose visibility while
      // we're agent-less; just don't push anything.
      const fallback = readV1LocalStyles();
      cache = fallback;
      notify();
      return {
        list: fallback,
        report: { ok: false, fromBackend: 0, merged: fallback.length, error: '找不到 primary agent' },
      };
    }
    const fromBackend = extractStylesFromAgent(primary);
    const v1 = readV1LocalStyles();
    // Merge: keep backend entries as-is; append v1 entries whose suffix is
    // not already present. This is order-stable for the user.
    const seen = new Set(fromBackend.map((s) => s.suffix.trim()));
    const v1New = v1.filter((s) => !seen.has(s.suffix.trim()));
    const merged = [...fromBackend, ...v1New];

    if (v1.length > 0) {
      if (v1New.length > 0) {
        // Push the union back so future sessions get them from the backend.
        const report = await writeBackend(merged);
        if (report.ok) clearV1LocalStyles();
        // writeBackend already updated cache + notified.
        return { list: merged, report: { ok: true, fromBackend: fromBackend.length, merged: merged.length } };
      }
      // All v1 entries already on backend → safe to drop the LS key.
      clearV1LocalStyles();
    }

    cache = merged;
    notify();
    return { list: merged, report: { ok: true, fromBackend: fromBackend.length, merged: merged.length } };
  } catch (e: any) {
    return {
      list: cache || [],
      report: { ok: false, fromBackend: 0, merged: (cache || []).length, error: e?.message || String(e) },
    };
  }
}

/** Synchronous getter for the in-memory cache (whatever the latest pull saw). */
export function getCustomStylesCached(): StylePreset[] {
  return cache ? cache.slice() : [];
}

/** Backward-compat alias used elsewhere in the codebase — reads cache only. */
export function loadCustomStyles(): StylePreset[] {
  return getCustomStylesCached();
}

export function findPresetBySuffix(text: string): StylePreset | undefined {
  const t = text.trim();
  if (!t) return undefined;
  return [...BUILTIN_STYLES, ...getCustomStylesCached()].find((p) => p.suffix.trim() === t);
}

/* ============ mutation (always via backend) ============ */

export interface PushReport {
  ok: boolean;
  saved: number;
  error?: string;
}

async function writeBackend(list: StylePreset[]): Promise<PushReport> {
  if (!primary) {
    // Late-bind: try to pick up the primary now.
    primary = await fetchPrimary();
    if (!primary) return { ok: false, saved: 0, error: '没有 primary agent，无法持久化风格' };
  }
  const apiId = (primary as any).id || primary.session_id;
  const plain = list.map(({ id, zh, en, suffix }) => ({ id, zh, en, suffix }));
  try {
    await updateRoleProfile(apiId, {
      ext: { ...(primary.ext || {}), style_presets: plain },
    });
    // mirror locally so cache stays consistent
    (primary as any).ext = { ...((primary.ext as any) || {}), style_presets: plain };
    cache = list.slice();
    notify();
    return { ok: true, saved: plain.length };
  } catch (e: any) {
    return { ok: false, saved: 0, error: e?.message || String(e) };
  }
}

/** Optimistic: add to in-memory cache immediately so the UI applies the style
 *  even before the backend round-trip. Backend write is awaited (async) and
 *  the report is returned; callers can surface a warning if it failed. */
export async function addCustomStyle(zh: string, suffix: string): Promise<{ preset: StylePreset; report: PushReport }> {
  const next: StylePreset = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    zh: (zh || '').trim() || (suffix.trim().slice(0, 8) || '自定义'),
    suffix: suffix.trim(),
    custom: true,
  };
  // optimistic — update cache first so the chip / picker / findPresetBySuffix
  // sees it immediately.
  const list = [...getCustomStylesCached(), next];
  cache = list.slice();
  notify();
  const report = await writeBackend(list);
  // writeBackend rewrites the cache on success; on failure we keep the
  // optimistic value (user can keep working; we surface the error to caller).
  if (!report.ok) {
    // keep optimistic cache
    cache = list.slice();
    notify();
  }
  return { preset: next, report };
}

export async function deleteCustomStyle(id: string): Promise<PushReport> {
  const before = getCustomStylesCached();
  const list = before.filter((s) => s.id !== id);
  // optimistic
  cache = list.slice();
  notify();
  const report = await writeBackend(list);
  if (!report.ok) {
    // roll back so the entry doesn't disappear without persistence
    cache = before;
    notify();
  }
  return report;
}

/** Force a manual push of the in-memory cache (rare; used by 「↑ 推送」). */
export async function pushCustomStylesToBackend(): Promise<PushReport> {
  return writeBackend(getCustomStylesCached());
}

/* ============ hidden built-ins (user-deleted defaults) ============
 * Persisted alongside style_presets on the primary agent's ext so that
 * "deleting" a built-in is durable across sessions and machines. We keep
 * this as just an array of ids on the agent record — no schema change. */

export function getHiddenBuiltinIds(): string[] {
  if (!primary) return [];
  const raw = (primary.ext as any)?.style_presets_hidden;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

export async function setHiddenBuiltinIds(ids: string[]): Promise<PushReport> {
  if (!primary) {
    primary = await fetchPrimary();
    if (!primary) return { ok: false, saved: 0, error: '没有 primary agent' };
  }
  const apiId = (primary as any).id || primary.session_id;
  try {
    await updateRoleProfile(apiId, {
      ext: { ...(primary.ext || {}), style_presets_hidden: ids },
    });
    (primary as any).ext = { ...((primary.ext as any) || {}), style_presets_hidden: ids };
    notify();
    return { ok: true, saved: ids.length };
  } catch (e: any) {
    return { ok: false, saved: 0, error: e?.message || String(e) };
  }
}
