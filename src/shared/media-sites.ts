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
 * Order matters: an explicit choice is never second-guessed, and a torrent or
 * metalink body is structurally impossible for yt-dlp, so both short-circuit
 * before detection is consulted.
 */
export function chooseEngine(request: EngineRequest, options: EngineAvailability): EngineChoice {
  if (request.engine === 'aria2') return 'aria2'
  if (request.hasTorrent || request.hasMetalink) return 'aria2'
  if (!options.ytdlpEnabled || !options.autoDetect) return 'aria2'

  if (request.engine === 'ytdlp') return options.ytdlpAvailable ? 'ytdlp' : 'aria2'

  // Detection is only meaningful for a single link; a pasted list is a batch of
  // files, not a media page.
  if (request.uris.length !== 1) return 'aria2'
  if (!isMediaSiteUrl(request.uris[0]!)) return 'aria2'
  return options.ytdlpAvailable ? 'ytdlp' : 'aria2'
}

/**
 * True when detection wanted yt-dlp but it could not be used, so the caller can
 * explain the fallback instead of silently doing something different.
 */
export function shouldWarnAboutMissingYtDlp(request: EngineRequest, options: EngineAvailability): boolean {
  if (options.ytdlpAvailable || !options.ytdlpEnabled || !options.autoDetect) return false
  if (request.hasTorrent || request.hasMetalink) return false
  if (request.uris.length !== 1) return false
  return isMediaSiteUrl(request.uris[0]!)
}
