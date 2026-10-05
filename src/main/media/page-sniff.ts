import {
  findDirectMediaUrls,
  isMediaContentType,
  isScannableDocument,
  looksLikeMediaPage,
  SNIFF_BYTE_LIMIT
} from '@shared/media-sniff'

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

/**
 * Everything one page fetch answers: whether it plays media, and the media files
 * it points at.
 *
 * `mediaUrls` is what makes a page that merely links a `.mp4` work — the file is
 * downloadable on its own, so it does not need to go through yt-dlp at all, and
 * a page with no player in it can still be worth handing to the downloader.
 */
export interface PageScan {
  verdict: SniffVerdict
  mediaUrls: string[]
}

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
  private readonly cache = new Map<string, { at: number; verdict: SniffVerdict; mediaUrls: string[] }>()
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
    return (await this.scan(url, http)).verdict
  }

  /**
   * The full answer for a URL: its verdict and the media files it points at.
   *
   * One fetch answers both, so asking for the files costs nothing extra. A caller
   * that only needs the verdict should use `sniff`, which reads the same cache.
   */
  async scan(url: string, http: SniffHttpContext = {}): Promise<PageScan> {
    const cached = this.cache.get(url)
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      return { verdict: cached.verdict, mediaUrls: cached.mediaUrls }
    }

    const answer = await this.fetchVerdict(url, http)
    // Failures are not cached: a transient network error must not pin a link as
    // "not a video" for the rest of the window.
    if (answer.verdict !== 'unknown') this.remember(url, answer)
    return answer
  }

  private remember(url: string, answer: PageScan): void {
    this.cache.set(url, { at: this.now(), ...answer })
    // A plain Map is insertion-ordered, so the oldest key is the first one.
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async fetchVerdict(url: string, http: SniffHttpContext): Promise<PageScan> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: requestHeaders(url, http, this.defaultUserAgent)
      })
      const contentType = response.headers.get('content-type') ?? ''
      // The URL itself is the file, so there is nothing to scan for: the caller
      // already holds the address it would have found.
      if (isMediaContentType(contentType)) return { verdict: 'media', mediaUrls: [] }
      const body = await readPrefix(response, SNIFF_BYTE_LIMIT)
      /*
       * Only a real document is scanned for media files. A binary payload that
       * happens to contain the bytes `.mp4` is not a page that links one, which
       * is the same rule the marker check below applies.
       */
      if (!isScannableDocument(contentType, body)) return { verdict: 'not-media', mediaUrls: [] }
      const mediaUrls = findDirectMediaUrls(body, url)
      // The cheap markers answer most pages; only when they are silent is the
      // body handed to the metadata parser, so a page that names its video in
      // `og:video` or a JSON-LD `VideoObject` is not missed.
      if (looksLikeMediaPage(contentType, body)) return { verdict: 'media', mediaUrls }
      return { verdict: (await pageHasMediaMetadata(body)) ? 'media' : 'not-media', mediaUrls }
    } catch (error) {
      this.log(`page sniff: ${url} -> unknown (${(error as Error).message})`)
      return { verdict: 'unknown', mediaUrls: [] }
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
