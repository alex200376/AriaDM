import React from 'react'
import { createRoot } from 'react-dom/client'

import type { AriaDmApi } from '@shared/ipc'

import App from './App'
import './styles/globals.css'

async function start(): Promise<void> {
  // Under Electron the preload has already installed window.api. In a plain
  // browser we fall back to the mock so the UI can be iterated on and reviewed
  // without booting the engine; the mock is loaded lazily so it never ships in
  // the packaged renderer bundle.
  if (typeof window.api === 'undefined') {
    const { createMockApi } = await import('./lib/mock-bridge')
    ;(window as unknown as { api: AriaDmApi }).api = createMockApi()
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('找不到 #root 容器')

  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void start()
