/**
 * Bringing a window that is already open back into view.
 *
 * A download manager spends most of its life behind the browser, or hidden in
 * the tray. When something the user just asked for starts, the window has to
 * come forward — but "show and focus" is not enough on Windows: `focus()` on a
 * window that another application is covering often only flashes the taskbar
 * entry, leaving the app running out of sight. Briefly raising it to the top is
 * what actually moves it to the foreground, and the flag has to be cleared
 * again afterwards or the window stays pinned above everything else.
 *
 * The window is described by the handful of methods used here rather than by
 * Electron's `BrowserWindow` type, so the sequence can be tested without
 * starting Electron at all.
 */
export interface RevealableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  setAlwaysOnTop(flag: boolean): void
}

export interface RevealOptions {
  /** Give the window the keyboard focus, not just a place on screen. */
  focus?: boolean
}

/**
 * Put a window back on screen, optionally taking the foreground.
 *
 * Every step is guarded: a reveal can race a window that the user closed a
 * moment ago, and a destroyed window throws on `show()`.
 */
export function revealWindow(window: RevealableWindow, options: RevealOptions = {}): void {
  if (window.isDestroyed()) return

  // `show()` on a minimised window leaves it minimised on Windows, so the
  // restore has to come first.
  if (window.isMinimized()) window.restore()
  window.show()

  if (!options.focus) return

  // Raising and immediately lowering is the documented way to take the
  // foreground on Windows; the trailing call is in a `finally` so a window that
  // refuses focus does not keep the always-on-top flag.
  try {
    window.setAlwaysOnTop(true)
    window.focus()
  } finally {
    if (!window.isDestroyed()) window.setAlwaysOnTop(false)
  }
}
