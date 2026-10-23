import { describe, expect, it } from 'vitest'

import { revealWindow, type RevealableWindow } from '../../src/main/window-reveal'

/**
 * The reveal sequence is the difference between "the download started" and "the
 * download started and I can see it". Its failure modes are all invisible in a
 * normal run — a minimised window that is shown but never restored, a window
 * that only flashes its taskbar button because another app has the foreground,
 * or an always-on-top flag left on so the app sits over everything until it is
 * closed. So the order of the calls, and the flag ending up off, are pinned here
 * against a recording fake rather than against Electron.
 */

interface FakeWindow extends RevealableWindow {
  readonly calls: string[]
}

function fakeWindow(state: { minimised?: boolean; destroyed?: boolean; focusThrows?: boolean } = {}): FakeWindow {
  const calls: string[] = []
  const destroyed = state.destroyed === true
  let minimised = state.minimised === true

  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimised,
    restore: () => {
      calls.push('restore')
      minimised = false
    },
    show: () => {
      calls.push('show')
    },
    focus: () => {
      calls.push('focus')
      if (state.focusThrows) throw new Error('focus refused')
    },
    setAlwaysOnTop: (flag: boolean) => {
      calls.push(`alwaysOnTop:${flag}`)
    }
  }
}

describe('revealWindow', () => {
  it('restores a minimised window before showing it', () => {
    const window = fakeWindow({ minimised: true })
    revealWindow(window)

    // `show()` on a still-minimised window leaves it in the taskbar, so the
    // restore has to be the first thing that happens.
    expect(window.calls.slice(0, 2)).toEqual(['restore', 'show'])
  })

  it('shows a hidden window without restoring or focusing it', () => {
    const window = fakeWindow()
    revealWindow(window)

    expect(window.calls).toEqual(['show'])
  })

  it('takes the foreground by raising the window before focusing it', () => {
    const window = fakeWindow()
    revealWindow(window, { focus: true })

    expect(window.calls).toEqual(['show', 'alwaysOnTop:true', 'focus', 'alwaysOnTop:false'])
  })

  it('lowers the always-on-top flag again when focus throws', () => {
    const window = fakeWindow({ focusThrows: true })

    expect(() => revealWindow(window, { focus: true })).toThrow('focus refused')

    // A window left pinned above every other app is worse than one that failed
    // to come forward, so the flag is cleared on the way out.
    expect(window.calls.at(-1)).toBe('alwaysOnTop:false')
  })

  it('never touches a window that has already been destroyed', () => {
    const window = fakeWindow({ destroyed: true })
    revealWindow(window, { focus: true })

    expect(window.calls).toEqual([])
  })

  it('does not raise a window it is not focusing', () => {
    const window = fakeWindow({ minimised: true })
    revealWindow(window, { focus: false })

    expect(window.calls).toEqual(['restore', 'show'])
  })
})
