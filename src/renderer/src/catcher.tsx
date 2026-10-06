import React from 'react'
import { createRoot } from 'react-dom/client'

import { resolveLocale, setLocale } from '@shared/i18n'
import type { AriaDmApi, CatcherInfo } from '@shared/ipc'

import { CatchPopup } from './components/catcher/CatchPopup'
import { applyAppearance } from './lib/appearance'
import './styles/globals.css'

/**
 * Entry point for the catch popup window.
 *
 * It is a separate document rather than a route in the main window, so it does
 * not inherit anything the main renderer sets up: not the locale, not the theme,
 * not the accent colour. The main process resolves those once and hands them
 * over with the capture, so the popup looks like part of the same app.
 */
function applyLook(info: CatcherInfo): void {
  setLocale(info.locale)

  // No wallpaper here: the popup is a small floating card, and a picture behind
  // a 460px window would be noise. The accent still follows the main window, so
  // a custom colour does not look like a different app.
  applyAppearance(document.documentElement, {
    theme: info.theme,
    accent: info.accent,
    customAccent: info.customAccent,
    density: 'comfortable',
    wallpaper: '',
    blur: 0,
    dim: 0,
    opacity: 100,
    zoom: 100,
    positionX: 50,
    positionY: 50
  })
}

async function start(): Promise<void> {
  // Same fallback as the main renderer: in a plain browser (the UI dev server)
  // there is no preload, so the mock stands in.
  if (typeof window.api === 'undefined') {
    const { createMockApi } = await import('./lib/mock-bridge')
    ;(window as unknown as { api: AriaDmApi }).api = createMockApi()
  }

  const info = await window.api.catcher.get().catch(() => null)
  if (info) applyLook(info)
  else setLocale(resolveLocale(navigator.language))

  const container = document.getElementById('root')
  if (!container) throw new Error('找不到 #root 容器')

  createRoot(container).render(
    <React.StrictMode>
      <CatchPopup initial={info} />
    </React.StrictMode>
  )
}

void start()
