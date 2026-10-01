import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { MediaCookieSource } from '@shared/settings'

/**
 * Where the cookies come from.
 *
 * yt-dlp can read a browser's cookie database directly, which is what makes
 * YouTube's "confirm you're not a bot" check and X's login-gated videos work at
 * all. Without it every one of those sites fails with a message that reads like a
 * bug in the app.
 *
 * The file is only *located* here: yt-dlp does the reading (and the decryption,
 * which on Windows needs the browser closed for Chromium). Detection exists so
 * the default can be "whichever browser this machine actually has" instead of
 * asking a question most people cannot answer.
 *
 * Two things about that location matter more than they look:
 *
 *  - A profile is not always "Default". Someone whose session lives in
 *    "Profile 2" has a cookie store the old Default-only lookup never saw, and
 *    the error they got said their browser was not installed.
 *  - Not every Chromium browser has a name yt-dlp knows. Perplexity's Comet is
 *    Chromium with its own `User Data` layout, so it is found here and then read
 *    as Chrome pointed at Comet's own profile directory — which is also what
 *    makes yt-dlp pick up Comet's `Local State` for the decryption key.
 */

export interface CookieCandidate {
  source: Exclude<MediaCookieSource, 'auto' | 'none'>
  /**
   * yt-dlp's name for this browser, or '' when it has none.
   *
   * yt-dlp knows brave, chrome, chromium, edge, firefox, opera, safari, vivaldi
   * and whale; anything else has to be read through `impersonate`.
   */
  browser: string
  /** A yt-dlp browser to read this store as, when `browser` is empty. */
  impersonate?: string
  label: string
  /**
   * Cookie store locations, per platform.
   *
   * A `*` segment stands for any profile directory. Nothing else may be
   * wildcarded, which keeps expansion to a single directory listing.
   */
  paths: Partial<Record<NodeJS.Platform, string[]>>
}

/** `~` and `${APPDATA}` style roots, expanded at call time. */
function expand(entry: string, env: NodeJS.ProcessEnv): string {
  let value = entry
  const localAppData = env.LOCALAPPDATA ?? ''
  const appData = env.APPDATA ?? ''
  const home = env.HOME ?? os.homedir()

  value = value.replace(/^%LOCALAPPDATA%/, localAppData)
  value = value.replace(/^%APPDATA%/, appData)
  value = value.replace(/^~/, home)
  return value
}

/**
 * Chromium browsers all keep one cookie database per profile:
 * `<User Data>/<profile>/Network/Cookies`. Listing every profile is the whole
 * point of the wildcard.
 */
export const COOKIE_CANDIDATES: CookieCandidate[] = [
  {
    source: 'chrome',
    browser: 'chrome',
    label: 'Chrome',
    paths: {
      win32: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Google/Chrome/*/Cookies'],
      linux: ['~/.config/google-chrome/*/Cookies']
    }
  },
  {
    source: 'edge',
    browser: 'edge',
    label: 'Edge',
    paths: {
      win32: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Microsoft Edge/*/Cookies'],
      linux: ['~/.config/microsoft-edge/*/Cookies']
    }
  },
  {
    /**
     * Perplexity Comet: Chromium under its own data directory, and unknown to
     * yt-dlp's `--cookies-from-browser` names. Reading it as Chrome with an
     * explicit profile path works because yt-dlp then looks for `Local State`
     * next to the profile — Comet's own copy, which holds its decryption key.
     */
    source: 'comet',
    browser: '',
    impersonate: 'chrome',
    label: 'Perplexity Comet',
    paths: {
      win32: ['%LOCALAPPDATA%\\Perplexity\\Comet\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Perplexity/Comet/User Data/*/Network/Cookies'],
      linux: ['~/.config/Perplexity/Comet/User Data/*/Network/Cookies']
    }
  },
  {
    source: 'brave',
    browser: 'brave',
    label: 'Brave',
    paths: {
      win32: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser/*/Cookies'],
      linux: ['~/.config/BraveSoftware/Brave-Browser/*/Cookies']
    }
  },
  {
    source: 'chromium',
    browser: 'chromium',
    label: 'Chromium',
    paths: {
      win32: ['%LOCALAPPDATA%\\Chromium\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Chromium/*/Cookies'],
      linux: ['~/.config/chromium/*/Cookies']
    }
  },
  {
    source: 'whale',
    browser: 'whale',
    label: 'Naver Whale',
    paths: {
      win32: ['%LOCALAPPDATA%\\Naver\\Naver Whale\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Naver/Whale/*/Cookies'],
      linux: ['~/.config/naver-whale/*/Cookies']
    }
  },
  {
    source: 'firefox',
    browser: 'firefox',
    label: 'Firefox',
    // Firefox keeps one directory per profile, each with its own cookies.sqlite.
    paths: {
      win32: ['%APPDATA%\\Mozilla\\Firefox\\Profiles\\*\\cookies.sqlite'],
      darwin: ['~/Library/Application Support/Firefox/Profiles/*/cookies.sqlite'],
      linux: ['~/.mozilla/firefox/*/cookies.sqlite']
    }
  },
  {
    source: 'vivaldi',
    browser: 'vivaldi',
    label: 'Vivaldi',
    paths: {
      win32: ['%LOCALAPPDATA%\\Vivaldi\\User Data\\*\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Vivaldi/*/Cookies'],
      linux: ['~/.config/vivaldi/*/Cookies']
    }
  },
  {
    source: 'opera',
    browser: 'opera',
    label: 'Opera',
    // Opera has no profile subdirectories: "Opera Stable" *is* the profile.
    paths: {
      win32: ['%APPDATA%\\Opera Software\\Opera Stable\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/com.operasoftware.Opera/Network/Cookies'],
      linux: ['~/.config/opera/Network/Cookies']
    }
  }
]

/** Derived rather than duplicated, so a new browser cannot drift out of listing. */
export const COOKIE_SOURCE_LABELS = Object.fromEntries(
  COOKIE_CANDIDATES.map((candidate) => [candidate.source, candidate.label])
) as Record<Exclude<MediaCookieSource, 'auto' | 'none'>, string>

export interface CookieEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Injected so detection is testable without touching the real disk. */
  exists?: (filePath: string) => boolean
  /** Modification time of a candidate path, or null when it cannot be read. */
  stat?: (filePath: string) => { mtimeMs: number } | null
  /** Directory listing, used only to expand a `*` profile segment. */
  readdir?: (dir: string) => string[]
}

export interface CookieMatch {
  candidate: CookieCandidate
  /** The cookie database that won. */
  file: string
  /** Directory to hand yt-dlp as the profile, or '' when it could not be derived. */
  profile: string
}

/**
 * Expand a `*` profile segment by listing the directory in front of it.
 *
 * String surgery rather than path joining on purpose: these patterns mix
 * separators (a `%LOCALAPPDATA%` value may use forward slashes on Windows, the
 * pattern tail does not), and rewriting them would produce a path that does not
 * exist.
 */
function expandPattern(base: string, environment: CookieEnvironment): string[] {
  const star = base.indexOf('*')
  if (star === -1) return [base]

  const slash = Math.max(base.lastIndexOf('\\', star), base.lastIndexOf('/', star))
  if (slash < 1) return []

  const parent = base.slice(0, slash)
  // The separator at `slash` is put back explicitly: the wildcard sits *between*
  // two separators, and the tail starts after it.
  const separator = base[slash] ?? '\\'
  const tail = base.slice(star + 1)
  return listDirectories(parent, environment).map(
    (entry) => `${parent}${separator}${entry}${tail}`
  )
}

function listDirectories(dir: string, environment: CookieEnvironment): string[] {
  const readdir =
    environment.readdir ??
    ((value: string): string[] => {
      try {
        return fs.readdirSync(value)
      } catch {
        return []
      }
    })

  return readdir(dir).filter((entry) => entry && !entry.startsWith('.'))
}

function plausibleFiles(candidate: CookieCandidate, environment: CookieEnvironment): string[] {
  const entries = candidate.paths[environment.platform] ?? []
  return entries
    .map((entry) => expand(entry, environment.env))
    .filter(Boolean)
    .flatMap((base) => expandPattern(base, environment))
}

/** The profile directory a cookie database belongs to. */
function profileDirFor(file: string): string {
  const parent = path.dirname(file)
  // `<profile>/Network/Cookies` is the modern layout; macOS and older builds put
  // the database directly in the profile.
  return path.basename(parent).toLowerCase() === 'network' ? path.dirname(parent) : parent
}

/**
 * The browser to read cookies from.
 *
 * "Installed" is not the same as "in use": a machine commonly has several
 * Chromium browsers, and the one that merely has a cookie file on disk may hold
 * a session from months ago. Picking the first match in a fixed list is how a
 * stale Chrome profile got chosen over the Edge profile the user was actually
 * signed in to, after which yt-dlp reported that it could not find usable
 * cookies for a video the browser could play fine.
 *
 * So the newest cookie store wins — across profiles as well as browsers — and
 * the list order only breaks ties, which keeps the result stable when the
 * timestamps cannot be read.
 *
 * `only` restricts the search to one candidate, which is what an explicit
 * browser choice needs: the store still has to be located (to name its profile),
 * but no other browser may win.
 */
export function detectCookieSource(
  environment: CookieEnvironment,
  only?: CookieCandidate
): CookieMatch | null {
  const exists = environment.exists ?? ((value: string) => fs.existsSync(value))
  const stat =
    environment.stat ??
    ((value: string): { mtimeMs: number } | null => {
      try {
        return { mtimeMs: fs.statSync(value).mtimeMs }
      } catch {
        return null
      }
    })

  let best: CookieMatch | null = null
  let bestTime = -1

  for (const candidate of only ? [only] : COOKIE_CANDIDATES) {
    const files = plausibleFiles(candidate, environment).filter((file) => exists(file))
    if (files.length === 0) continue

    let newestFile = files[0]!
    let newestTime = -1
    for (const file of files) {
      const time = stat(file)?.mtimeMs ?? -1
      if (time > newestTime) {
        newestTime = time
        newestFile = file
      }
    }

    if (best === null || newestTime > bestTime) {
      best = { candidate, file: newestFile, profile: profileDirFor(newestFile) }
      bestTime = newestTime
    }
  }

  return best
}

export function cookieCandidateFor(
  source: Exclude<MediaCookieSource, 'auto' | 'none'>
): CookieCandidate | undefined {
  return COOKIE_CANDIDATES.find((entry) => entry.source === source)
}

/**
 * The yt-dlp argument for a detected store.
 *
 * The profile is always named. yt-dlp picks the newest store under a browser it
 * knows, but a browser it has never heard of (Comet) has no directory to search
 * at all, and naming the profile is also what keeps the chosen store and the
 * chosen profile from disagreeing.
 */
function argsFor(match: CookieMatch): { args: string[]; browser: string } {
  const name = match.candidate.browser || match.candidate.impersonate || match.candidate.source
  const target = match.profile ? `${name}:${match.profile}` : name
  return { args: ['--cookies-from-browser', target], browser: match.candidate.label }
}

/**
 * `--cookies-from-browser` arguments for a setting value.
 *
 * An explicit choice is always honoured, even when the browser could not be
 * detected: the user may have a profile somewhere unconventional, and yt-dlp's
 * "could not find cookies" message is translated into a hint that says so.
 */
export function resolveCookieArgs(
  source: MediaCookieSource,
  environment: CookieEnvironment
): { args: string[]; browser: string } {
  if (source === 'none') return { args: [], browser: '' }

  if (source === 'auto') {
    const detected = detectCookieSource(environment)
    if (!detected) return { args: [], browser: '' }
    return argsFor(detected)
  }

  const candidate = cookieCandidateFor(source)
  if (!candidate) return { args: ['--cookies-from-browser', source], browser: source }

  const detected = detectCookieSource(environment, candidate)
  if (detected) return argsFor(detected)
  // Not found: still ask, because yt-dlp may know a location this list does not.
  const name = candidate.browser || candidate.impersonate || source
  return { args: ['--cookies-from-browser', name], browser: candidate.label }
}
