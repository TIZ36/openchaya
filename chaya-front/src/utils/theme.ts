/**
 * Theme switcher — mode (light/dark) × tone (color family).
 *
 * Both axes persist in localStorage and apply via data-attributes on <html>:
 *   data-theme="dark"            when not light
 *   data-tone="indigo|sage|..."  when not the default aubergine
 *
 * Dark mode is gated to Pro+ in the UI (the CSS works for anyone — gating
 * is purely UX). Tone is free for everyone: it's just a hue shift.
 */

export type ThemeName = 'light' | 'dark';

export type ToneName = 'aubergine' | 'indigo' | 'sage' | 'terracotta';

export const TONES: ReadonlyArray<{ key: ToneName; label: string; swatch: string }> = [
  { key: 'aubergine',  label: '紫墨', swatch: 'oklch(0.38 0.120 310)' },
  { key: 'indigo',     label: '黛蓝', swatch: 'oklch(0.40 0.115 250)' },
  { key: 'sage',       label: '苔青', swatch: 'oklch(0.42 0.075 145)' },
  { key: 'terracotta', label: '赭红', swatch: 'oklch(0.42 0.115 35)'  },
];

const LS_THEME = 'chaya_theme';
const LS_TONE = 'chaya_tone';

const VALID_TONES: ReadonlyArray<ToneName> = TONES.map((t) => t.key);

export function getTheme(): ThemeName {
  if (typeof window === 'undefined') return 'light';
  const v = window.localStorage.getItem(LS_THEME);
  return v === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: ThemeName): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_THEME, t);
  applyTheme(t);
  window.dispatchEvent(new CustomEvent('chaya:theme', { detail: t }));
}

export function applyTheme(t: ThemeName): void {
  if (typeof document === 'undefined') return;
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

export function getTone(): ToneName {
  if (typeof window === 'undefined') return 'aubergine';
  const v = window.localStorage.getItem(LS_TONE) as ToneName | null;
  return v && VALID_TONES.includes(v) ? v : 'aubergine';
}

export function setTone(t: ToneName): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_TONE, t);
  applyTone(t);
  window.dispatchEvent(new CustomEvent('chaya:tone', { detail: t }));
}

export function applyTone(t: ToneName): void {
  if (typeof document === 'undefined') return;
  // Default tone has no override block; omit the attribute so CSS
  // specificity stays minimal.
  if (t === 'aubergine') delete document.documentElement.dataset.tone;
  else document.documentElement.dataset.tone = t;
}

/** Call once at app boot before first paint to avoid the light-mode flash. */
export function initThemeFromStorage(): void {
  applyTheme(getTheme());
  applyTone(getTone());
}
