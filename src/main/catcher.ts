import { BrowserWindow, screen } from 'electron'

import { IPC, type CatcherAction, type CatcherInfo } from '@shared/ipc'

/**
 * The IDM-style "download caught" popup.
 *
 * A browser extension intercepting a download gives the user no chance to say no:
 * the link is taken out of the browser's hands and lands in the queue. This is
 * the small always-on-top window that gives that decision back — it shows what
 * was caught and waits.
 *
 * The downloads are added *paused* before the popup appears, so the popup never
 * has to hold a request open and nothing is lost if the app quits while it is on
 * screen. Every exit path therefore has to be deliberate:
 *  - Start download -> resume them
 *  - Download later -> leave them paused
 *  - Cancel         -> remove them
 *  - closing the window, or pressing Escape, counts as "later", never as cancel.
 */

const WIDTH = 404
const HEIGHT = 176
/** Gap from the screen edge; IDM parks its popup in the same corner. */
const MARGIN = 18

export interface CatcherDeps {
  /** Which document the popup window should load. */
  page(): { url: string | null; file: string | null }
  preloadPath: string
  iconPath: string
  backgroundColor: string
  /** Act on the capture once the user has chosen. */
  onResolve(info: CatcherInfo, action: CatcherAction): void
  log(line: string): void
}

export class DownloadCatcher {
  private window: BrowserWindow | null = null
  private info: CatcherInfo | null = null
  private readonly deps: CatcherDeps

  constructor(deps: CatcherDeps) {
    this.deps = deps
  }

  /** The capture currently on screen, or null when the popup is not open. */
  get pending(): CatcherInfo | null {
    return this.info
  }

  /**
   * Show the popup for a capture.
   *
   * A second capture arriving while the popup is open is merged into it rather
   * than replacing it: the first one has already been added, so discarding the
   * popup would leave those downloads silently parked forever.
   */
  show(info: CatcherInfo): void {
    const existing = this.info
    const window = this.window

    if (existing && window && !window.isDestroyed()) {
      this.info = {
        ...info,
        gids: [...existing.gids, ...info.gids],
        count: existing.count + info.count
      }
      window.webContents.send(IPC.eventCatcher, this.info)
      window.show()
      window.focus()
      return
    }

    this.info = info
    this.window = this.createWindow()
  }

  /** Act on the pending capture and take the popup down. */
  resolve(action: CatcherAction): void {
    const info = this.info
    if (!info) return

    // Cleared first so the window's own `close` handler does not resolve it too.
    this.info = null
    try {
      this.deps.onResolve(info, action)
    } catch (error) {
      this.deps.log(`catcher resolve failed: ${(error as Error).message}`)
    }
    this.teardown()
  }

  /** Take the popup down without acting, leaving the downloads paused. */
  dismiss(): void {
    if (!this.info) return
    this.info = null
    this.teardown()
  }

  destroy(): void {
    this.info = null
    this.teardown()
  }

  private teardown(): void {
    const window = this.window
    this.window = null
    // `destroy` rather than `close`: close would re-enter the `close` handler
    // that resolves an unanswered capture, and the answer is already decided.
    if (window && !window.isDestroyed()) window.destroy()
  }

  private createWindow(): BrowserWindow {
    const { workArea } = screen.getPrimaryDisplay()

    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: workArea.x + workArea.width - WIDTH - MARGIN,
      y: workArea.y + workArea.height - HEIGHT - MARGIN,
      show: false,
      // Frameless: the popup draws its own rounded card, so a native title bar
      // would only add a second, redundant header.
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // It sits over the browser and must not claim a taskbar slot of its own.
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: this.deps.backgroundColor,
      icon: this.deps.iconPath,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })

    window.once('ready-to-show', () => {
      window.show()
      window.focus()
    })

    // The only way the user can close this is the window controls we draw, so
    // this covers a programmatic close (session end, for instance). Treat it as
    // "later" so the capture is never thrown away by accident.
    window.on('close', () => {
      const info = this.info
      if (!info) return
      this.info = null
      try {
        this.deps.onResolve(info, 'later')
      } catch (error) {
        this.deps.log(`catcher close failed: ${(error as Error).message}`)
      }
    })

    const page = this.deps.page()
    if (page.url) void window.loadURL(page.url)
    else if (page.file) void window.loadFile(page.file)

    return window
  }
}
