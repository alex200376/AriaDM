import path from 'node:path'

import { BrowserWindow, shell } from 'electron'

import type { WindowBounds } from '@shared/settings'

export interface CreateWindowOptions {
  bounds: WindowBounds
  /** App icon used for the taskbar and window frame while running unpackaged. */
  iconPath: string
  onBoundsChange(bounds: Partial<WindowBounds>): void
  onCloseRequested(): boolean
  onReadyToShow?(): void
}

/** Matches the renderer's dark background so launch does not flash white. */
export const BACKGROUND = '#0b0d12'



export function resolvePreloadPath(): string {
  // electron-vite emits the preload as CommonJS (.cjs) so it stays loadable under
  // a sandboxed renderer even though the package itself is ESM.
  return path.join(__dirname, '../preload/index.cjs')
}

/**
 * Locate one of the renderer's HTML entries.
 *
 * The renderer is a multi-page build: `index.html` is the main window and
 * `catcher.html` is the small catch popup, which has to be a separate document
 * because it runs in its own BrowserWindow.
 */
export function resolveRendererPage(page: 'index' | 'catcher' = 'index'): { url: string | null; file: string | null } {
  // electron-vite injects ELECTRON_RENDERER_URL while running the dev server.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  // The dev server serves index.html at its root, so only the extra pages get a
  // filename appended. Keeping the main entry byte-identical to before also
  // keeps the `will-navigate` allow-list below matching.
  if (devUrl) return { url: page === 'index' ? devUrl : `${devUrl}/${page}.html`, file: null }
  return { url: null, file: path.join(__dirname, `../renderer/${page}.html`) }
}

export function resolveRendererEntry(): { url: string | null; file: string | null } {
  return resolveRendererPage('index')
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const { bounds } = options

  const window = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x ?? undefined,
    y: bounds.y ?? undefined,
    // IDM-sized: small enough to leave the rest of the screen usable while the
    // queue runs, but not so small that the table's remaining columns start
    // squeezing into each other.
    minWidth: 720,
    minHeight: 460,
    show: false,
    backgroundColor: BACKGROUND,
    // A packaged build takes its icon from the executable, so this only matters
    // in development, but it is what makes the real mark show up in the taskbar.
    icon: options.iconPath,
    autoHideMenuBar: true,
    // The title bar is hidden and the app draws the whole caption row itself,
    // minimise/maximise/close included. That is what lets the caption share a
    // single strip with the queue toolbar — and why the buttons follow the theme,
    // which a native overlay painted by Electron in one fixed colour cannot.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: resolvePreloadPath(),
      // The renderer is untrusted UI: it reaches the main process only through
      // the narrow, explicitly enumerated preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // No remote content is ever loaded, so leaving this off is safe.
      allowRunningInsecureContent: false
    }
  })

  if (bounds.maximised) window.maximize()

  window.once('ready-to-show', () => {
    options.onReadyToShow?.()
    window.show()
  })

  // Never let the app navigate away from its own UI; external links go to the
  // system browser instead of loading inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    const entry = resolveRendererEntry()
    const allowed = entry.url ? url.startsWith(entry.url) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  const persistBounds = (): void => {
    const maximised = window.isMaximized()
    const current = window.getNormalBounds()
    options.onBoundsChange({
      width: current.width,
      height: current.height,
      x: current.x,
      y: current.y,
      maximised
    })
  }

  window.on('resized', persistBounds)
  window.on('moved', persistBounds)
  window.on('maximize', persistBounds)
  window.on('unmaximize', persistBounds)

  // Closing is intercepted so "minimise to tray" can swallow the event.
  window.on('close', (event) => {
    if (!options.onCloseRequested()) {
      event.preventDefault()
    } else {
      persistBounds()
    }
  })

  const entry = resolveRendererEntry()
  if (entry.url) {
    void window.loadURL(entry.url)
    window.webContents.openDevTools({ mode: 'detach' })
  } else if (entry.file) {
    void window.loadFile(entry.file)
  }

  return window
}
