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
 */

export interface CookieCandidate {
  source: Exclude<MediaCookieSource, 'auto' | 'none'>
  /** Browser name understood by yt-dlp's `--cookies-from-browser`. */
  browser: string
  label: string
  /** Paths that indicate the browser is installed, per platform. */
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

export const COOKIE_CANDIDATES: CookieCandidate[] = [
  {
    source: 'chrome',
    browser: 'chrome',
    label: 'Chrome',
    paths: {
      win32: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Google/Chrome/Default/Cookies'],
      linux: ['~/.config/google-chrome/Default/Cookies']
    }
  },
  {
    source: 'edge',
    browser: 'edge',
    label: 'Edge',
    paths: {
      win32: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Microsoft Edge/Default/Cookies'],
      linux: ['~/.config/microsoft-edge/Default/Cookies']
    }
  },
  {
    source: 'brave',
    browser: 'brave',
    label: 'Brave',
    paths: {
      win32: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'],
      linux: ['~/.config/BraveSoftware/Brave-Browser/Default/Cookies']
    }
  },
  {
    source: 'firefox',
    browser: 'firefox',
    label: 'Firefox',
    // Firefox stores one directory per profile, so the directory is the signal.
    paths: {
      win32: ['%APPDATA%\\Mozilla\\Firefox\\Profiles'],
      darwin: ['~/Library/Application Support/Firefox/Profiles'],
      linux: ['~/.mozilla/firefox']
    }
  },
  {
    source: 'vivaldi',
    browser: 'vivaldi',
    label: 'Vivaldi',
    paths: {
      win32: ['%LOCALAPPDATA%\\Vivaldi\\User Data\\Default\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/Vivaldi/Default/Cookies'],
      linux: ['~/.config/vivaldi/Default/Cookies']
    }
  },
  {
    source: 'opera',
    browser: 'opera',
    label: 'Opera',
    paths: {
      win32: ['%APPDATA%\\Opera Software\\Opera Stable\\Network\\Cookies'],
      darwin: ['~/Library/Application Support/com.operasoftware.Opera/Network/Cookies'],
      linux: ['~/.config/opera/Network/Cookies']
    }
  }
]

export const COOKIE_SOURCE_LABELS: Record<Exclude<MediaCookieSource, 'auto' | 'none'>, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  vivaldi: 'Vivaldi',
  opera: 'Opera'
}

export interface CookieEnvironment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Injected so detection is testable without touching the real disk. */
  exists?: (filePath: string) => boolean
  /** Modification time of a candidate path, or null when it cannot be read. */
  stat?: (filePath: string) => { mtimeMs: number } | null
}

function plausibleFiles(candidate: CookieCandidate, environment: CookieEnvironment): string[] {
  const entries = candidate.paths[environment.platform] ?? []
  return entries.map((entry) => expand(entry, environment.env)).filter(Boolean)
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
 * So the newest cookie store wins, and the list order only breaks ties — which
 * keeps the result stable when the timestamps cannot be read.
 */
export function detectCookieSource(environment: CookieEnvironment): CookieCandidate | null {
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

  let best: CookieCandidate | null = null
  let bestTime = -1

  for (const candidate of COOKIE_CANDIDATES) {
    const files = plausibleFiles(candidate, environment).filter((file) => exists(file))
    if (files.length === 0) continue

    const newest = files.reduce((time, file) => Math.max(time, stat(file)?.mtimeMs ?? -1), -1)
    if (best === null || newest > bestTime) {
      best = candidate
      bestTime = newest
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
    return { args: ['--cookies-from-browser', detected.browser], browser: detected.label }
  }

  const candidate = cookieCandidateFor(source)
  const browser = candidate?.browser ?? source
  return { args: ['--cookies-from-browser', browser], browser: COOKIE_SOURCE_LABELS[source] ?? source }
}
