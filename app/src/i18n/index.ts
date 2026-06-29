/** Public surface for the app-wide language preference system. */
export {
  LANGS,
  getLang,
  setLang,
  applyLang,
  initLangFromStorage,
  translate,
  t,
  type Lang,
} from './core';
export { I18nProvider, useI18n } from './react';
