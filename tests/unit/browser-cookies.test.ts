import { describe, expect, it } from 'vitest'

import {
  COOKIE_CANDIDATES,
  detectCookieSource,
  resolveCookieArgs,
  type CookieEnvironment
} from '../../src/main/media/browser-cookies'

/**
 * Picking the wrong browser is what makes a video fail with "could not find
 * cookies" even though the user is signed in and the browser plays the video
 * fine, so the choice of browser is worth pinning down. So is the profile: a
 * session in "Profile 2" rather than "Default" used to look like a browser that
 * was not installed at all.
 */

// The candidates are Windows paths with backslashes, and only the leading
// %LOCALAPPDATA% is rewritten, so the separators have to match exactly.
const CHROME = 'C:/lad\\Google\\Chrome\\User Data\\Default\\Network\\Cookies'
const CHROME_PROFILE_TWO = 'C:/lad\\Google\\Chrome\\User Data\\Profile 2\\Network\\Cookies'
const EDGE = 'C:/lad\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies'
// Perplexity's browser: Chromium, its own data directory, unknown to yt-dlp.
const COMET = 'C:/lad\\Perplexity\\Comet\\User Data\\Default\\Network\\Cookies'
const FIREFOX = 'C:/ad\\Mozilla\\Firefox\\Profiles\\abc.default-release\\cookies.sqlite'

/** What the `*` expansion sees when it lists a directory. */
const DIRECTORIES: Record<string, string[]> = {
  'C:/lad\\Google\\Chrome\\User Data': ['Default', 'Profile 2'],
  'C:/lad\\Microsoft\\Edge\\User Data': ['Default'],
  'C:/lad\\Perplexity\\Comet\\User Data': ['Default'],
  'C:/ad\\Mozilla\\Firefox\\Profiles': ['abc.default-release']
}

function environment(files: Record<string, number>): CookieEnvironment {
  return {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:/lad', APPDATA: 'C:/ad', HOME: 'C:/home' },
    exists: (file) => file in files,
    stat: (file) => (file in files ? { mtimeMs: files[file]! } : null),
    readdir: (dir) => DIRECTORIES[dir] ?? []
  }
}

describe('detectCookieSource', () => {
  it('finds the only installed browser', () => {
    expect(detectCookieSource(environment({ [CHROME]: 1_000 }))?.candidate.source).toBe('chrome')
  })

  it('returns null when no browser has a cookie store', () => {
    expect(detectCookieSource(environment({}))).toBeNull()
  })

  it('prefers the most recently used browser over list order', () => {
    // Chrome is listed first, but its store is months older than Edge's: the
    // user is signed in to Edge.
    const detected = detectCookieSource(environment({ [CHROME]: 1_000, [EDGE]: 9_000 }))
    expect(detected?.candidate.source).toBe('edge')
  })

  it('still picks Chrome when it is the one in use', () => {
    expect(detectCookieSource(environment({ [CHROME]: 9_000, [EDGE]: 1_000 }))?.candidate.source).toBe(
      'chrome'
    )
  })

  it('keeps list order when the timestamps are equal', () => {
    expect(detectCookieSource(environment({ [CHROME]: 5_000, [EDGE]: 5_000 }))?.candidate.source).toBe(
      'chrome'
    )
  })

  it('finds the profile the session is actually in, not just Default', () => {
    // Default exists but is stale; the user has been using Profile 2.
    const detected = detectCookieSource(environment({ [CHROME]: 1_000, [CHROME_PROFILE_TWO]: 9_000 }))

    expect(detected?.candidate.source).toBe('chrome')
    expect(detected?.file).toBe(CHROME_PROFILE_TWO)
    expect(detected?.profile).toBe('C:/lad\\Google\\Chrome\\User Data\\Profile 2')
  })

  it('detects Perplexity Comet, which yt-dlp has no name for', () => {
    const detected = detectCookieSource(environment({ [COMET]: 1_000 }))

    expect(detected?.candidate.source).toBe('comet')
    expect(detected?.candidate.impersonate).toBe('chrome')
  })

  it('finds Firefox profiles, whose cookie database is per profile', () => {
    const detected = detectCookieSource(environment({ [FIREFOX]: 1_000 }))

    expect(detected?.candidate.source).toBe('firefox')
    expect(detected?.profile).toBe('C:/ad\\Mozilla\\Firefox\\Profiles\\abc.default-release')
  })

  it('falls back to an existing browser when timestamps cannot be read', () => {
    const noStat: CookieEnvironment = {
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:/lad' },
      exists: (file) => file === EDGE,
      readdir: (dir) => DIRECTORIES[dir] ?? []
    }
    expect(detectCookieSource(noStat)?.candidate.source).toBe('edge')
  })

  it('can be restricted to one browser, which an explicit choice needs', () => {
    const comet = COOKIE_CANDIDATES.find((entry) => entry.source === 'comet')!
    // Edge is the newest store, but the question was only about Comet.
    const detected = detectCookieSource(environment({ [EDGE]: 9_000, [COMET]: 1_000 }), comet)

    expect(detected?.candidate.source).toBe('comet')
  })
})

describe('resolveCookieArgs', () => {
  it('uses the detected browser and names its profile', () => {
    const args = resolveCookieArgs('auto', environment({ [CHROME]: 1_000, [EDGE]: 9_000 }))

    expect(args).toEqual({
      args: ['--cookies-from-browser', 'edge:C:/lad\\Microsoft\\Edge\\User Data\\Default'],
      browser: 'Edge'
    })
  })

  it('reads Comet as Chrome pointed at Comet own profile directory', () => {
    // yt-dlp then looks for `Local State` beside that profile — Comet's own copy,
    // which is what holds the key its cookies were encrypted with.
    expect(resolveCookieArgs('auto', environment({ [COMET]: 1_000 }))).toEqual({
      args: ['--cookies-from-browser', 'chrome:C:/lad\\Perplexity\\Comet\\User Data\\Default'],
      browser: 'Perplexity Comet'
    })

    expect(resolveCookieArgs('comet', environment({ [COMET]: 1_000 }))).toEqual({
      args: ['--cookies-from-browser', 'chrome:C:/lad\\Perplexity\\Comet\\User Data\\Default'],
      browser: 'Perplexity Comet'
    })
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

  it('names the profile for an explicit choice too', () => {
    expect(resolveCookieArgs('chrome', environment({ [CHROME_PROFILE_TWO]: 1_000 }))).toEqual({
      args: ['--cookies-from-browser', 'chrome:C:/lad\\Google\\Chrome\\User Data\\Profile 2'],
      browser: 'Chrome'
    })
  })

  it('asks for no cookies when cookies are switched off', () => {
    expect(resolveCookieArgs('none', environment({ [CHROME]: 1_000 }))).toEqual({ args: [], browser: '' })
  })
})
