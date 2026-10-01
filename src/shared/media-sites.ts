import { hasFileExtension } from './uri'

/**
 * Which URLs belong to yt-dlp rather than aria2.
 *
 * This is deliberately a curated host list rather than a heuristic on the URL
 * shape. A download manager has to be predictable: sending a link to the wrong
 * engine either produces a broken file or an empty download, and the user has no
 * way to tell which happened. A site we have never heard of goes to aria2, which
 * is the safe answer for the overwhelming majority of links.
 */

/** Host suffixes that serve pages yt-dlp understands. */
export const MEDIA_SITE_HOSTS = [
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'reddit.com',
  'twitch.tv',
  'dailymotion.com',
  'soundcloud.com',
  'bilibili.com',
  'nicovideo.jp',
  'vk.com',
  'threads.net',
  'rumble.com',
  'kick.com',
  'streamable.com',
  'weibo.com',
  'youku.com',
  'iqiyi.com',
  'imgur.com',
  'bsky.app'
] as const

/**
 * The host suffix this URL belongs to, or null.
 *
 * Matching on whole labels means `notx.com` does not match `x.com`, while
 * `www.x.com` and `mobile.twitter.com` do.
 */
export function matchMediaSite(url: string): string | null {
  let host: string
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }

  for (const site of MEDIA_SITE_HOSTS) {
    if (host === site || host.endsWith(`.${site}`)) return site
  }
  return null
}

/**
 * True when a URL should be handed to yt-dlp.
 *
 * A link that names a file still goes to aria2 even on a media host: sites serve
 * their CDN payloads from the same domain family, and aria2 handles a plain file
 * far better than yt-dlp does.
 */
export function isMediaSiteUrl(url: string): boolean {
  if (matchMediaSite(url) === null) return false
  return !hasFileExtension(url)
}

export type EngineChoice = 'aria2' | 'ytdlp'

export interface EngineRequest {
  uris: string[]
  /** The caller's explicit request; 'auto' defers to detection. */
  engine: 'auto' | 'aria2' | 'ytdlp'
  hasTorrent?: boolean
  hasMetalink?: boolean
}

export interface EngineAvailability {
  ytdlpEnabled: boolean
  /** The user's 自動辨識 switch. */
  autoDetect: boolean
  ytdlpAvailable: boolean
}

/**
 * Pick the engine for one add request.
 *
 * Order matters, and getting it wrong is what broke "download this video":
 *
 *  - A torrent or metalink body is structurally impossible for yt-dlp.
 *  - An explicit choice is never second-guessed. This must come *before* the
 *    自動辨識 switch, because that switch governs automatic detection only. When
 *    it was consulted first, the extension's button — which asks for yt-dlp
 *    outright — was downgraded to aria2 wherever auto-detection was off, and
 *    aria2 then saved the YouTube *page* as the file.
 *  - Turning yt-dlp off entirely still wins over an explicit request, or the
 *    setting would mean nothing.
 */
export function chooseEngine(request: EngineRequest, options: EngineAvailability): EngineChoice {
  if (request.hasTorrent || request.hasMetalink) return 'aria2'
  if (!options.ytdlpEnabled) return 'aria2'

  if (request.engine === 'ytdlp') return options.ytdlpAvailable ? 'ytdlp' : 'aria2'
  if (request.engine === 'aria2') return 'aria2'

  // Automatic detection from here on.
  if (!options.autoDetect) return 'aria2'

  // Detection is only meaningful for a single link; a pasted list is a batch of
  // files, not a media page.
  if (request.uris.length !== 1) return 'aria2'
  if (!isMediaSiteUrl(request.uris[0]!)) return 'aria2'
  return options.ytdlpAvailable ? 'ytdlp' : 'aria2'
}

export interface HandoffEngineRequest {
  urls: string[]
  /** An engine the caller named outright, when it had a real reason to. */
  engine?: 'auto' | 'aria2' | 'ytdlp'
  /** The extension's "this is a video" hint from its download button. */
  media?: boolean
}

/**
 * The engine a browser handoff should use.
 *
 * `media` is the extension's "this is a video" signal, and it is better evidence
 * than our host list: the on-page panel only appears on sites we recognise, but
 * the popup's button is offered on any page. It is still only a *hint*, not an
 * instruction.
 *
 * A URL that names a file is a file. yt-dlp fetches a bare payload over one
 * connection, after its own process startup and an extraction pass, and reports
 * no size — on a plain 3.5 MB CDN file that measured tens of times slower than
 * aria2, with a speed readout that is pure noise. Handing it to aria2 is what
 * the user actually wants, whichever button they pressed.
 *
 * An engine the caller named outright is honoured untouched: only the extension's
 * hint is treated as fallible.
 */
export function resolveHandoffEngine(request: HandoffEngineRequest): 'auto' | 'aria2' | 'ytdlp' {
  if (request.engine) return request.engine
  if (!request.media) return 'auto'

  // 'auto' rather than 'aria2' so the ordinary detection still runs; a URL with a
  // file extension is never a media *page*, so it lands on aria2 either way.
  const first = request.urls[0]
  if (first && hasFileExtension(first)) return 'auto'
  return 'ytdlp'
}

/**
 * True when detection wanted yt-dlp but it could not be used, so the caller can
 * explain the fallback instead of silently doing something different.
 */
export function shouldWarnAboutMissingYtDlp(request: EngineRequest, options: EngineAvailability): boolean {
  if (options.ytdlpAvailable || !options.ytdlpEnabled) return false
  if (request.hasTorrent || request.hasMetalink) return false

  // A request that asked for yt-dlp outright deserves an explanation whenever it
  // cannot be honoured; 自動辨識 has nothing to do with it.
  if (request.engine === 'ytdlp') return true

  if (!options.autoDetect) return false
  if (request.uris.length !== 1) return false
  return isMediaSiteUrl(request.uris[0]!)
}
