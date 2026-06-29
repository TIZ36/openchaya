import React from 'react'
import ReactDOM from 'react-dom/client'
import ClientShell from './v2/ClientShell'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { Toaster } from './components/ui/Toaster.tsx'
import './index.css'
import { initThemeFromStorage } from './utils/theme'
import { initLangFromStorage, I18nProvider } from './i18n'
import { migrateLegacyCreds } from './services/configStore'

initThemeFromStorage()
initLangFromStorage()
// 一次性把旧 localStorage 凭证迁进本地 SQLite（幂等；非 Electron 环境跳过）。
migrateLegacyCreds()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <ClientShell />
        <Toaster />
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>,
)
