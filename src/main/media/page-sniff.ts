import {
  findDirectMediaUrls,
  findPageTitle,
  findPlayerFrames,
  findStreamUrls,
  isMediaContentType,
  isScannableDocument,
  isStreamManifestUrl,
  looksLikeMediaPage,
  PAGE_MEDIA_LIMIT,
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
 * Reading it the way a browser would means following the player, too. On plenty
 * of sites the page itself holds nothing but an `<iframe>` — a movie page whose
 * `/_watch/1234` frame carries the HLS manifest — and stopping at the outer
 * document is why those links used to be reported as "no video here". The walk
 * is one level deep and bounded, and always in parallel, so the extra hop costs
 * one request rather than one round trip per frame.
 *
 * The result stays three-valued. `unknown` means the fetch failed or timed out,
 * and the caller must treat it as "not media" — a flaky connection must never
 * turn a plain file into a yt-dlp download.
 */
export type SniffVerdict = 'media' | 'not-media' | 'unknown'

/**
 * Everything one page fetch answers.
 *
 * `mediaUrls` is what makes a page that merely links a `.mp4` work — the file is
 * downloadable on its own and needs no yt-dlp at all. `streamUrls` is the same
 * idea for a manifest, which yt-dlp does need: it fetches HLS segment by segment
 * and muxes the result. `title` exists because a manifest cannot name the result
 * itself (every HLS play list is called "index"), so the page the user opened is
 * the only honest source for a filename.
 */
export interface PageScan {
  verdict: SniffVerdict
  mediaUrls: string[]
  streamUrls: string[]
  title: string
  /**
   * True when the server refused to serve the page rather than serving one with
   * nothing on it — a 403 from a bot check, a 429, a 503.
   *
   * Worth telling apart in the caller, because the two lead to the same verdict
   * and completely different advice. A page we read and found no video in is a
   * file, and aria2 downloading it is right; a page we were never allowed to read
   * is a site that blocks non-browser clients, and the aria2 failure that follows
   * says nothing about why.
   */
  blocked: boolean
}

export interface SniffHttpContext {
  cookieHeader?: string
  referer?: string
  userAgent?: string
}

export interface MediaSnifferOptions {
  /** How long the fetch may take before it is abandoned. */
  timeoutMs?: number
  /** How long one embedded player may take; frames run in parallel. */
  frameTimeoutMs?: number
  cacheTtlMs?: number
  cacheLimit?: number
  /** Used when the caller has no User-Agent; without one many pages refuse. */
  defaultUserAgent?: string
  log?(line: string): void
  now?(): number
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_FRAME_TIMEOUT_MS = 3_500
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_CACHE_LIMIT = 32

/**
 * How many of a page's players are actually walked.
 *
 * Every frame is a real fetch on a path the user is already waiting on, so this
 * stays small: the scoring in `findPlayerFrames` is what makes the first two the
 * likely ones rather than a lottery.
 */
const MAX_PLAYER_FRAMES = 2

/**
 * A desktop Chrome User-Agent, for the many sites that serve a stub page (or a
 * bot check) to anything else. The dialog's detect and the download that follows
 * should see the same page, so this is deliberately generic and stable.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** A negative answer, freshly built so no caller can mutate what others hold. */
function emptyScan(): PageScan {
  return { verdict: 'unknown', mediaUrls: [], streamUrls: [], title: '', blocked: false }
}

export class MediaSniffer {
  /** Answers by URL, with how deep the walk that produced them was. */
  private readonly cache = new Map<string, { at: number; depth: number } & PageScan>()
  private readonly timeoutMs: number
  private readonly frameTimeoutMs: number
  private readonly cacheTtlMs: number
  private readonly cacheLimit: number
  private readonly defaultUserAgent: string
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor(options: MediaSnifferOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.frameTimeoutMs = options.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS
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
   * The whole answer for a URL: its verdict, the files and manifests it points
   * at, and its title.
   *
   * One fetch answers all of it, so asking for the addresses costs nothing
   * extra. A caller that only needs the verdict should use `sniff`, which reads
   * the same cache.
   */
  async scan(url: string, http: SniffHttpContext = {}): Promise<PageScan> {
    return await this.scanCached(url, http, 0)
  }

  /**
   * The answer for a URL at a given depth, reusing a recent one when it can.
   *
   * Player frames come through here too, so the player a whole series embeds is
   * read once rather than once per episode. A cached answer reached *as* a frame
   * was produced without walking that frame's own frames, so it is only reused
   * for a top-level page when it found media: a negative is exactly the answer a
   * deeper walk could have overturned.
   */
  private async scanCached(url: string, http: SniffHttpContext, depth: number): Promise<PageScan> {
    const cached = this.cache.get(url)
    if (
      cached &&
      this.now() - cached.at < this.cacheTtlMs &&
      (cached.depth === depth || cached.verdict === 'media')
    ) {
      return withoutTimestamp(cached)
    }

    const answer = await this.scanPage(url, http, depth)
    // Failures are not cached: a transient network error must not pin a link as
    // "not a video" for the rest of the window.
    if (answer.verdict !== 'unknown') this.remember(url, answer, depth)
    return answer
  }

  private remember(url: string, answer: PageScan, depth: number): void {
    this.cache.set(url, { at: this.now(), depth, ...answer })
    // A plain Map is insertion-ordered, so the oldest key is the first one.
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /**
   * One document, and — at the top level only — the players it embeds.
   */
  private async scanPage(url: string, http: SniffHttpContext, depth: number): Promise<PageScan> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      depth === 0 ? this.timeoutMs : this.frameTimeoutMs
    )
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: requestHeaders(url, http, this.defaultUserAgent)
      })
      /*
       * A refusal is not an answer.
       *
       * A bot check (Cloudflare and friends) answers every non-browser request
       * with 403 and a challenge page, and that page has no player on it — so
       * reading it would report "no video here" about a site that is full of
       * video. Reported as `unknown`, which every caller already treats as "not
       * media": a refusal must never promote a link, and, because failures are
       * not cached, it must not pin the link as a plain file for the next five
       * minutes either. `blocked` is what lets the caller say so out loud.
       */
      if (!response.ok) {
        this.log(`page sniff: ${url} -> blocked (HTTP ${response.status})`)
        return {
          verdict: 'unknown',
          mediaUrls: [],
          streamUrls: [],
          title: '',
          blocked: true
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      // The URL itself is the file, so there is nothing left to scan for, and a
      // manifest is something yt-dlp can be handed as it stands.
      if (isMediaContentType(contentType)) {
        return {
          verdict: 'media',
          mediaUrls: [],
          streamUrls: isStreamManifestUrl(url) ? [url] : [],
          title: '',
          blocked: false
        }
      }

      const body = await readPrefix(response, SNIFF_BYTE_LIMIT)
      /*
       * Only a real document is scanned. A binary payload that happens to
       * contain the bytes `.mp4` is not a page that links one, which is the same
       * rule the marker check below applies.
       */
      if (!isScannableDocument(contentType, body)) {
        return { verdict: 'not-media', mediaUrls: [], streamUrls: [], title: '', blocked: false }
      }

      const own: PageScan = {
        // The cheap markers answer most pages; only when they are silent is the
        // body handed to the metadata parser, so a page that names its video in
        // `og:video` or a JSON-LD `VideoObject` is not missed.
        verdict:
          looksLikeMediaPage(contentType, body) || (await pageHasMediaMetadata(body))
            ? 'media'
            : 'not-media',
        mediaUrls: findDirectMediaUrls(body, url),
        streamUrls: findStreamUrls(body, url),
        title: findPageTitle(body),
        blocked: false
      }

      /*
       * A page that already names the media needs nothing further, and a frame is
       * never walked out of: one level is what a browser player costs, and the
       * second level of an ad frame is where a walk would stop paying for itself.
       */
      if (depth > 0 || own.streamUrls.length > 0 || own.mediaUrls.length > 0) return own

      const frames = findPlayerFrames(body, url).slice(0, MAX_PLAYER_FRAMES)
      if (frames.length === 0) return own
      return await this.walkFrames(own, frames, url, http)
    } catch (error) {
      this.log(`page sniff: ${url} -> unknown (${(error as Error).message})`)
      return emptyScan()
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Look inside a page's players, in parallel, and merge what they hold.
   *
   * A frame that cannot be read contributes nothing rather than an answer: it
   * must not promote the page to media, and it must not overrule what the page
   * itself said either. Each frame's own verdict is cached under its own URL, so
   * a second page embedding the same player costs no request.
   */
  private async walkFrames(
    own: PageScan,
    frames: string[],
    pageUrl: string,
    http: SniffHttpContext
  ): Promise<PageScan> {
    const embedded = await Promise.all(
      frames.map((frame) => this.scanCached(frame, { ...http, referer: pageUrl }, 1))
    )

    const played = embedded.some((scan) => scan.verdict === 'media')
    return {
      verdict: own.verdict === 'media' || played ? 'media' : own.verdict,
      mediaUrls: unique([
        ...own.mediaUrls,
        ...embedded.flatMap((scan) => scan.mediaUrls)
      ]).slice(0, PAGE_MEDIA_LIMIT),
      streamUrls: unique([...own.streamUrls, ...embedded.flatMap((scan) => scan.streamUrls)]),
      title: own.title || embedded.find((scan) => scan.title !== '')?.title || '',
      blocked: own.blocked || embedded.some((scan) => scan.blocked)
    }
  }
}

/** A cached answer, without the bookkeeping it is stored with. */
function withoutTimestamp(entry: { at: number; depth: number } & PageScan): PageScan {
  return {
    verdict: entry.verdict,
    mediaUrls: entry.mediaUrls,
    streamUrls: entry.streamUrls,
    title: entry.title,
    blocked: entry.blocked
  }
}

/** The same addresses, in the same order, without repeats. */
function unique(urls: string[]): string[] {
  return [...new Set(urls)]
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
