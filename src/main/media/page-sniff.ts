import { isMediaContentType, isScannableDocument, looksLikeMediaPage, SNIFF_BYTE_LIMIT } from '@shared/media-sniff'

import { pageHasMediaMetadata } from './media-metadata'

/**
 * Fetch a little of a page and decide whether it plays media.
 *
 * This is the network half of `shared/media-sniff.ts`, which owns the actual
 * judgement. It exists so an unknown host can still reach yt-dlp: rather than
 * growing a hand-maintained list of every video site, we read the page the way a
 * browser would and look for a player.
 *
 * The result is intentionally three-valued. `unknown` means the fetch failed or
 * timed out, and the caller must treat it as "not media" — a flaky connection
 * must never turn a plain file into a yt-dlp download.
 */
export type SniffVerdict = 'media' | 'not-media' | 'unknown'

export interface SniffHttpContext {
  cookieHeader?: string
  referer?: string
  userAgent?: string
}

export interface MediaSnifferOptions {
  /** How long the fetch may take before it is abandoned. */
  timeoutMs?: number
  cacheTtlMs?: number
  cacheLimit?: number
  /** Used when the caller has no User-Agent; without one many pages refuse. */
  defaultUserAgent?: string
  log?(line: string): void
  now?(): number
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_CACHE_LIMIT = 32

/**
 * A desktop Chrome User-Agent, for the many sites that serve a stub page (or a
 * bot check) to anything else. The dialog's detect and the download that follows
 * should see the same page, so this is deliberately generic and stable.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export class MediaSniffer {
  private readonly cache = new Map<string, { at: number; verdict: SniffVerdict }>()
  private readonly timeoutMs: number
  private readonly cacheTtlMs: number
  private readonly cacheLimit: number
  private readonly defaultUserAgent: string
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor(options: MediaSnifferOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT
    this.defaultUserAgent = options.defaultUserAgent ?? BROWSER_USER_AGENT
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  /** The verdict for a URL, reusing a recent answer when there is one. */
  async sniff(url: string, http: SniffHttpContext = {}): Promise<SniffVerdict> {
    const cached = this.cache.get(url)
    if (cached && this.now() - cached.at < this.cacheTtlMs) return cached.verdict

    const verdict = await this.fetchVerdict(url, http)
    // Failures are not cached: a transient network error must not pin a link as
    // "not a video" for the rest of the window.
    if (verdict !== 'unknown') this.remember(url, verdict)
    return verdict
  }

  private remember(url: string, verdict: SniffVerdict): void {
    this.cache.set(url, { at: this.now(), verdict })
    // A plain Map is insertion-ordered, so the oldest key is the first one.
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async fetchVerdict(url: string, http: SniffHttpContext): Promise<SniffVerdict> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: requestHeaders(url, http, this.defaultUserAgent)
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (isMediaContentType(contentType)) return 'media'
      const body = await readPrefix(response, SNIFF_BYTE_LIMIT)
      // The cheap markers answer most pages; only when they are silent is the
      // body handed to the metadata parser, so a page that names its video in
      // `og:video` or a JSON-LD `VideoObject` is not missed. A binary body is
      // never parsed: a payload that happens to contain `video` is not a page.
      if (looksLikeMediaPage(contentType, body)) return 'media'
      if (!isScannableDocument(contentType, body)) return 'not-media'
      return (await pageHasMediaMetadata(body)) ? 'media' : 'not-media'
    } catch (error) {
      this.log(`page sniff: ${url} -> unknown (${(error as Error).message})`)
      return 'unknown'
    } finally {
      clearTimeout(timer)
    }
  }
}

function requestHeaders(
  url: string,
  http: SniffHttpContext,
  defaultUserAgent: string
): Record<string, string> {
  const headers: Record<string, string> = { 'user-agent': http.userAgent || defaultUserAgent }
  // A referer of the page itself is what a browser sends when it plays the page's
  // own media, and it is what these servers check.
  headers.referer = http.referer || url
  if (http.cookieHeader) headers.cookie = http.cookieHeader
  return headers
}

/** Read up to `limit` bytes of the body as text, then stop and drop the socket. */
async function readPrefix(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let received = 0
  try {
    while (received < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        received += value.byteLength
        text += decoder.decode(value, { stream: true })
      }
    }
  } catch {
    // A body that breaks mid-stream is still worth whatever arrived before it.
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}
