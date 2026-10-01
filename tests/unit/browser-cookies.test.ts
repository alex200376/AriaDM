import { describe, expect, it } from 'vitest'

import {
  detectCookieSource,
  resolveCookieArgs,
  type CookieEnvironment
} from '../../src/main/media/browser-cookies'

/**
 * Picking the wrong browser is what makes a video fail with "could not find
 * cookies" even though the user is signed in and the browser plays the video
 * fine, so the choice of browser is worth pinning down.
 */

// The candidates are Windows paths with backslashes, and only the leading
// %LOCALAPPDATA% is rewritten, so the separators have to match exactly.
const CHROME = 'C:/lad\\Google\\Chrome\\User Data\\Default\\Network\\Cookies'
const EDGE = 'C:/lad\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies'

function environment(files: Record<string, number>): CookieEnvironment {
  return {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/lad', APPDATA: 'C:/ad', HOME: 'C:/home' },
    exists: (file) => file in files,
    stat: (file) => (file in files ? { mtimeMs: files[file]! } : null)
  }
}

describe('detectCookieSource', () => {
  it('finds the only installed browser', () => {
    expect(detectCookieSource(environment({ [CHROME]: 1_000 }))?.source).toBe('chrome')
  })

  it('returns null when no browser has a cookie store', () => {
    expect(detectCookieSource(environment({}))).toBeNull()
  })

  it('prefers the most recently used browser over list order', () => {
    // Chrome is listed first, but its store is months older than Edge's: the
    // user is signed in to Edge.
    const detected = detectCookieSource(environment({ [CHROME]: 1_000, [EDGE]: 9_000 }))
    expect(detected?.source).toBe('edge')
  })

  it('still picks Chrome when it is the one in use', () => {
    expect(detectCookieSource(environment({ [CHROME]: 9_000, [EDGE]: 1_000 }))?.source).toBe('chrome')
  })

  it('keeps list order when the timestamps are equal', () => {
    expect(detectCookieSource(environment({ [CHROME]: 5_000, [EDGE]: 5_000 }))?.source).toBe('chrome')
  })

  it('falls back to an existing browser when timestamps cannot be read', () => {
    const noStat: CookieEnvironment = {
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:/lad' },
      exists: (file) => file === EDGE
    }
    expect(detectCookieSource(noStat)?.source).toBe('edge')
  })
})

describe('resolveCookieArgs', () => {
  it('uses the detected browser for auto', () => {
    const args = resolveCookieArgs('auto', environment({ [CHROME]: 1_000, [EDGE]: 9_000 }))
    expect(args).toEqual({ args: ['--cookies-from-browser', 'edge'], browser: 'Edge' })
  })

  it('passes nothing when auto finds no browser', () => {
    expect(resolveCookieArgs('auto', environment({}))).toEqual({ args: [], browser: '' })
  })

  it('honours an explicit browser even when it was not detected', () => {
    // The user may have a profile in an unusual place, so the choice is trusted.
    expect(resolveCookieArgs('firefox', environment({}))).toEqual({
      args: ['--cookies-from-browser', 'firefox'],
      browser: 'Firefox'
    })
  })

  it('asks for no cookies when cookies are switched off', () => {
    expect(resolveCookieArgs('none', environment({ [CHROME]: 1_000 }))).toEqual({ args: [], browser: '' })
  })
})
