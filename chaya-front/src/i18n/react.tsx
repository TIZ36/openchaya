/**
 * React bindings for the language preference.
 *
 * <I18nProvider> holds the active language in state and re-renders the whole
 * tree when it changes (unlike theme, which is pure CSS and needs no re-render).
 * It also listens for the `chaya:lang` event so a setLang() from non-React code
 * keeps the UI in sync.
 *
 * Usage:
 *   const { t, lang, setLang } = useI18n();
 *   <span>{t('common.save')}</span>
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getLang, setLang as coreSetLang, translate, type Lang } from './core';

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(getLang);

  // Reflect external setLang() calls (non-React code) back into state.
  useEffect(() => {
    const onLang = (e: Event) => {
      const next = (e as CustomEvent<Lang>).detail;
      if (next) setLangState(next);
    };
    window.addEventListener('chaya:lang', onLang);
    return () => window.removeEventListener('chaya:lang', onLang);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);     // immediate re-render
    coreSetLang(l);      // persist + apply + broadcast
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(key, lang, vars),
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Defensive fallback so a stray consumer outside the provider still works.
    return {
      lang: getLang(),
      setLang: coreSetLang,
      t: (key, vars) => translate(key, getLang(), vars),
    };
  }
  return ctx;
}
