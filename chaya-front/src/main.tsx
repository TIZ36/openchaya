import React from 'react'
import ReactDOM from 'react-dom/client'
import ClientShell from './v2/ClientShell'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { Toaster } from './components/ui/Toaster.tsx'
import './index.css'
import { initThemeFromStorage } from './utils/theme'

initThemeFromStorage()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ClientShell />
      <Toaster />
    </ErrorBoundary>
  </React.StrictMode>,
)
