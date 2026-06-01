/**
 * App-wide language preference — runtime core (framework-agnostic).
 *
 * Mirrors the `theme.ts` pattern: persists in localStorage, applies to
 * <html lang>, and broadcasts a `chaya:lang` CustomEvent so non-React code
 * (utils, services) and React (via i18n/react.tsx) can both react.
 *
 * Design: semantic keys + two dictionaries (en / zh). Default is English.
 * Lookup order in translate(): active-lang dict → zh dict → the key itself,
 * so a missing entry degrades to Chinese (then the raw key) instead of blank.
 *
 * NOTE: literal Chinese strings that haven't been migrated to t() yet simply
 * stay Chinese in the JSX — they're unaffected by language switching. Coverage
 * grows as surfaces are migrated; nothing ever renders empty.
 */
import { DICT, type Lang } from './dictionaries';

export type { Lang };

export const LANGS: ReadonlyArray<{ key: Lang; label: string; native: string }> = [
  { key: 'en', label: 'English',            native: 'English' },
  { key: 'zh', label: 'Simplified Chinese', native: '简体中文' },
];

const LS_LANG = 'chaya_lang';
const VALID: ReadonlyArray<Lang> = ['en', 'zh'];
const DEFAULT_LANG: Lang = 'en';

/** Module-level mirror of the active language for non-React `t()` callers. */
let currentLang: Lang = DEFAULT_LANG;

export function getLang(): Lang {
  if (typeof window === 'undefined') return currentLang;
  const v = window.localStorage.getItem(LS_LANG) as Lang | null;
  return v && VALID.includes(v) ? v : DEFAULT_LANG;
}

export function setLang(l: Lang): void {
  if (!VALID.includes(l)) return;
  currentLang = l;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LS_LANG, l);
    applyLang(l);
    window.dispatchEvent(new CustomEvent<Lang>('chaya:lang', { detail: l }));
  }
}

export function applyLang(l: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('lang', l === 'zh' ? 'zh-CN' : 'en');
}

/** Call once at app boot, before first paint. */
export function initLangFromStorage(): void {
  currentLang = getLang();
  applyLang(currentLang);
}

/**
 * Translate a key for an explicit language (defaults to the active one).
 * Supports `{name}` placeholder interpolation via `vars`.
 */
export function translate(
  key: string,
  lang: Lang = currentLang,
  vars?: Record<string, string | number>,
): string {
  const raw = DICT[lang]?.[key] ?? DICT.zh[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    name in vars ? String(vars[name]) : m,
  );
}

/** Non-React shorthand for the currently active language. */
export function t(key: string, vars?: Record<string, string | number>): string {
  return translate(key, currentLang, vars);
}
