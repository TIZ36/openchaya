/**
 * Theme switcher — light / dark.
 *
 * Persists choice in localStorage, applies via `data-theme` attribute on
 * <html>. Dark mode is gated to Pro+ in the UI but the CSS works for
 * anyone — gating is purely UX, not a hard block (so Free users see the
 * toggle but with an upsell tooltip).
 */

export type ThemeName = 'light' | 'dark';

const LS_KEY = 'chaya_theme';

export function getTheme(): ThemeName {
  if (typeof window === 'undefined') return 'light';
  const v = window.localStorage.getItem(LS_KEY);
  return v === 'dark' ? 'dark' : 'light';
}

export function setTheme(t: ThemeName): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, t);
  applyTheme(t);
  // Notify listeners so multi-mount components can react without polling.
  window.dispatchEvent(new CustomEvent('chaya:theme', { detail: t }));
}

export function applyTheme(t: ThemeName): void {
  if (typeof document === 'undefined') return;
  if (t === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

/** Call once at app boot before first paint to avoid the light-mode flash. */
export function initThemeFromStorage(): void {
  applyTheme(getTheme());
}
