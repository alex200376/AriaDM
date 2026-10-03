import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * A live session, as a file yt-dlp will actually read.
 *
 * The browser extension can hand AriaDM the cookies for the page the user is
 * looking at, which is the only way to reach sites whose cookie store yt-dlp
 * cannot read (a running Chromium, app-bound encryption). Passing that session as
 * an HTTP `Cookie:` header looks like it works and does not: yt-dlp's extractors
 * authenticate from their **cookie jar**, not from request headers —
 *
 *   X:         is_logged_in  = bool(self._get_cookies(API_BASE).get('auth_token'))
 *   Instagram: _is_logged_in = bool(self._get_cookies(BASE_URL).get('sessionid'))
 *
 * — so a header leaves every one of them treating the visitor as signed out. X
 * then hides sensitive posts (they come back as a TweetTombstone) and Instagram
 * answers with its login page, and the user is told the post "has no video".
 *
 * Writing the session into a Netscape cookies file and passing `--cookies` puts
 * it in the jar, which is what the header was always meant to do. The file is a
 * credential, so it is owner-only and deleted as soon as the run is over.
 */

export interface ParsedCookie {
  name: string
  value: string
}

/** One year, in seconds: long enough to outlive any download. */
const COOKIE_LIFETIME_SECONDS = 365 * 24 * 60 * 60

/** Where cookie files go when the caller does not name a directory. */
const DEFAULT_COOKIE_DIR = path.join(os.tmpdir(), 'ariadm-cookies')

/**
 * Host labels that are a site prefix rather than part of its name.
 *
 * Stripping them is what lets a session captured on `www.x.com` also be sent to
 * `api.x.com`, which is the host the extractor actually calls.
 */
const HOST_PREFIXES = new Set(['www', 'm', 'mobile', 'amp'])

/** Cookie names and values must not be able to break the tab-separated format. */
function cleanField(value: string): string {
  return value.replace(/[\t\r\n\u0000]/g, '')
}

/**
 * Parse a `Cookie:` header into name/value pairs.
 *
 * Malformed pairs are dropped rather than guessed at: a cookie jar entry built
 * from a misread value would be sent to the site as a different, wrong session.
 */
export function parseCookieHeader(header: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = []
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = cleanField(part.slice(0, separator).trim())
    const value = cleanField(part.slice(separator + 1).trim())
    if (!name || name.includes('=')) continue
    cookies.push({ name, value })
  }
  return cookies
}

/**
 * The domain a cookie should be scoped to, so the site's API host matches too.
 *
 * `www.instagram.com` becomes `instagram.com`, and an address (an IPv4 literal,
 * which has no labels to trim) is left exactly as it is.
 */
export function cookieDomainFor(hostname: string): string {
  const host = (hostname ?? '').toLowerCase().replace(/\.$/, '')
  if (!host) return host
  if (/^\d+(\.\d+){3}$/.test(host)) return host

  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return host
  if (HOST_PREFIXES.has(labels[0]!)) return labels.slice(1).join('.')
  return labels.slice(-2).join('.')
}

/**
 * The Netscape cookie file for a URL and a `Cookie:` header, or '' when there is
 * nothing usable in it.
 *
 * The format is the one every tool in this space reads: one tab-separated line
 * per cookie — domain, include-subdomains, path, secure, expiry, name, value —
 * under a comment line that names it. The domain is written with a leading dot
 * and `TRUE`, so the whole site and its API subdomains share the session.
 */
export function netscapeCookieFile(url: string, header: string, now = Date.now()): string {
  const cookies = parseCookieHeader(header)
  if (cookies.length === 0) return ''

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }

  const domain = `.${cookieDomainFor(parsed.hostname)}`
  const secure = parsed.protocol === 'https:' ? 'TRUE' : 'FALSE'
  const expiry = String(Math.floor(now / 1000) + COOKIE_LIFETIME_SECONDS)

  const lines = ['# Netscape HTTP Cookie File', '# Written by AriaDM for one yt-dlp run.']
  for (const cookie of cookies) {
    lines.push([domain, 'TRUE', '/', secure, expiry, cookie.name, cookie.value].join('\t'))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Write the session to a file yt-dlp can be pointed at, and return its path.
 *
 * Returns '' when there is nothing to write, so callers can pass the result on
 * unconditionally.
 */
export async function writeCookieFile(
  url: string,
  header: string,
  dir: string = DEFAULT_COOKIE_DIR
): Promise<string> {
  const content = netscapeCookieFile(url, header)
  if (!content) return ''

  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `cookies-${randomUUID()}.txt`)
  // Owner-only where the filesystem honours it; the file is deleted right after
  // the run either way.
  await fsp.writeFile(file, content, { mode: 0o600 })
  return file
}

/** Delete a cookie file, ignoring the case where it is already gone. */
export async function removeCookieFile(file: string): Promise<void> {
  if (!file) return
  await fsp.rm(file, { force: true })
}
