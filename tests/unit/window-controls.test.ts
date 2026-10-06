import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guards the frameless window's controls.
 *
 * The window has no native title bar, so the app draws minimise/maximise/close
 * itself and Electron's own overlay is gone — which is what a dark block in the
 * corner of a light window was. Two things can break quietly here: a channel that
 * is declared but never wired (the button then does nothing), and the overlay
 * coming back (a themed caption with an unthemed strip beside it).
 */
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const SHARED_IPC = read('src/shared/ipc.ts')
const PRELOAD = read('src/preload/index.ts')
const HANDLERS = read('src/main/ipc/handlers.ts')
const WINDOW = read('src/main/window.ts')

/** Every request channel the window-controls API is built from. */
const channels = [...SHARED_IPC.matchAll(/^\s{2}(window[A-Z]\w*):\s*'([^']+)'/gm)].map((match) => ({
  key: match[1]!,
  channel: match[2]!
}))

describe('window controls', () => {
  it('declares the whole set of channels', () => {
    expect(channels.map((entry) => entry.channel).sort()).toEqual([
      'window:close',
      'window:isMaximised',
      'window:minimise',
      'window:toggleMaximise'
    ])
  })

  it('wires every one of them through the preload bridge', () => {
    const missing = channels.filter((entry) => !PRELOAD.includes(`IPC.${entry.key}`))
    expect(missing.map((entry) => entry.channel)).toEqual([])
  })

  it('handles every one of them in the main process', () => {
    const missing = channels.filter((entry) => !HANDLERS.includes(`IPC.${entry.key}`))
    expect(missing.map((entry) => entry.channel)).toEqual([])
  })

  it('reports the maximised state back, so the middle button shows the right icon', () => {
    expect(SHARED_IPC).toContain("eventWindowState: 'event:windowState'")
    expect(PRELOAD).toContain('subscribe(IPC.eventWindowState, handler)')
  })

  it('draws its own window buttons instead of the native overlay', () => {
    // The overlay is painted by Electron in one fixed colour per call, which is
    // exactly the thing that cannot follow the theme.
    expect(WINDOW).not.toMatch(/titleBarOverlay/)
    expect(WINDOW).toMatch(/titleBarStyle:\s*'hidden'/)
  })
})
