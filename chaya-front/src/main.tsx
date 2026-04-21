import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import { Toaster } from './components/ui/Toaster.tsx'
import './index.css'

// Electron 使用 file:// 加载时 BrowserRouter 无法工作，改用 HashRouter；后端仍走 HTTP
const Router = import.meta.env.VITE_ELECTRON === 'true' ? HashRouter : BrowserRouter

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Router>
        <App />
        <Toaster />
      </Router>
    </ErrorBoundary>
  </React.StrictMode>,
)
