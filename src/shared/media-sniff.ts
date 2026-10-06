/**
 * Page-content video detection.
 *
 * The curated host list in `media-sites.ts` is the fast, predictable answer for
 * sites we already know. This module is the fallback for the rest: a page on an
 * unknown host can still be a video page, and the honest way to tell is to read
 * a little of it and look for the things a playable page always has.
 *
 * Plenty of those pages hide the player one level down. The episode page carries
 * an `<iframe>` and the manifest lives inside the frame; the address often sits
 * in a player's own setup script rather than in the markup; and some players
 * publish a download button whose target is a plain file. So the extraction here
 * looks for three different things — a media file, a streaming manifest, and the
 * frames worth walking into — and the caller decides what each one is worth.
 *
 * Everything here is pure — it takes an already-fetched content type and body
 * prefix and returns verdicts, addresses and a title — so it can be unit-tested
 * without a network, and the fetching lives in `src/main/media/page-sniff.ts`
 * where it belongs.
 */
import { hasFileExtension } from './uri'

/**
 * How much of the body to look at.
 *
 * Media markers live in the document head or in the player setup near the top of
 * a page, so a prefix is enough; a whole multi-megabyte page would be wasted
 * work. 256 KB is comfortably more than any page that has not already proved it
 * is media by then.
 */
export const SNIFF_BYTE_LIMIT = 256 * 1024

/**
 * Things a page with playable media contains.
 *
 * Deliberately not an empty match: a bare `<source>` is also how `<picture>`
 * serves a responsive image, so the media tags are anchored and the rest are
 * unambiguous markers that only a player (or a player's metadata) carries.
 */
export const MEDIA_PAGE_MARKERS: RegExp[] = [
  // A real media element.
  /<video[\s>]/i,
  /<audio[\s>]/i,
  // A typed source, e.g. `type="video/mp4"`; an image source has `srcset`.
  /type\s*=\s*["']?(?:video|audio)\//i,
  // A streaming manifest, whether in markup or in the player's own script.
  /\.m3u8\b/i,
  /\.mpd\b/i,
  /application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml)/i,
  // Open-graph / Twitter player metadata.
  /og:video/i,
  /twitter:player:stream/i
]

/**
 * Extensions of media that can be fetched as a plain file.
 *
 * Deliberately excludes the streaming containers (`.m3u8`, `.mpd`): a manifest
 * is not the media itself, and handing one to a plain downloader is exactly what
 * the yt-dlp path exists to avoid. They are collected separately — see
 * `findStreamUrls`.
 */
const DIRECT_MEDIA_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'webm',
  'mkv',
  'mov',
  'avi',
  'flv',
  'wmv',
  'mpg',
  'mpeg',
  'ogv',
  'mp3',
  'm4a',
  'aac',
  'flac',
  'opus',
  'ogg',
  'oga',
  'wav',
  'weba'
])

/** Container formats that describe the media rather than being it. */
const STREAM_EXTENSIONS = new Set(['m3u8', 'mpd'])

/** How many files one page may contribute, so a listing cannot flood the queue. */
export const PAGE_MEDIA_LIMIT = 50

/** How many embedded players one page may contribute to the walk. */
export const PLAYER_FRAME_LIMIT = 4

/** The lowercased extension of a URL's last path segment, or ''. */
function mediaExtensionOf(pathname: string): string {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase()
}

/** True when a URL is http(s), the only kind worth inspecting. */
function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * True when a URL is a media *file* — something a plain downloader can fetch
 * without knowing anything about the page it came from.
 */
export function isDirectMediaUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!isHttpUrl(parsed)) return false
  return DIRECT_MEDIA_EXTENSIONS.has(mediaExtensionOf(parsed.pathname))
}

/**
 * True when a URL names a streaming manifest rather than a media file.
 *
 * The distinction is what picks the engine: a manifest is a play list, so it
 * belongs to yt-dlp, which fetches it segment by segment and muxes the result.
 * Aria2 handed a `.m3u8` cheerfully saves the text file.
 */
export function isStreamManifestUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!isHttpUrl(parsed)) return false
  return STREAM_EXTENSIONS.has(mediaExtensionOf(parsed.pathname))
}

/**
 * A slash as a scripted player spells it inside a string literal — the two
 * characters seen in 'https:\/\/…' — built from a character code so that no
 * escaping rule anywhere between this file and the disk can change it.
 */
const ESCAPED_SLASH = String.fromCharCode(92) + '/'

/**
 * The part of a body worth scanning.
 *
 * JSON-escaped slashes are put back first: a player configured from a script
 * writes its address as `https:\/\/cdn\/…\/index.m3u8`, and those escapes make
 * every one of them invisible to a plain scan.
 */
function sniffWindow(html: string): string {
  const body = html.length > SNIFF_BYTE_LIMIT ? html.slice(0, SNIFF_BYTE_LIMIT) : html
  return body.split(ESCAPED_SLASH).join('/')
}

/**
 * Attributes that carry a URL.
 *
 * `data-*` covers the players that keep their source out of `src` — a download
 * button whose target exists only in `data-download`, a lazy player in
 * `data-src` — and `content` is how a `<meta>` declares one.
 */
const URL_ATTRIBUTES =
  'src|href|data-src|data-href|data-url|data-file|data-video|data-source|data-download|content'

/** The attribute scan, compiled once: `name="value"` with any spacing. */
const URL_ATTRIBUTE_PATTERN = new RegExp(`(?:${URL_ATTRIBUTES})\\s*=\\s*["']([^"']+)["']`, 'gi')

/** Resolve a candidate against the page, undoing what markup escapes. */
function absoluteCandidate(raw: string, baseUrl: string): string {
  const candidate = raw.trim().replace(/&amp;/g, '&')
  if (candidate === '') return ''
  try {
    // A bare path (`/media/a.mp4`) resolves against the page it was found on.
    return new URL(candidate, baseUrl).toString()
  } catch {
    return ''
  }
}

/**
 * Every URL the page mentions, in the order it mentions them, filtered by
 * `accept`.
 *
 * Markup (`src`, `href`, `content`) and bare URLs are both read, because a
 * script-built player keeps the address in its own setup — `var url =
 * '…/index.m3u8';` — rather than in the element it renders.
 */
function collectUrls(html: string, baseUrl: string, accept: (url: string) => boolean): string[] {
  const text = sniffWindow(html)
  const found = new Set<string>()

  const consider = (raw: string): void => {
    if (found.size >= PAGE_MEDIA_LIMIT) return
    const absolute = absoluteCandidate(raw, baseUrl)
    if (absolute !== '' && accept(absolute)) found.add(absolute)
  }

  for (const match of text.matchAll(URL_ATTRIBUTE_PATTERN)) {
    consider(match[1]!)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    consider(match[0]!)
  }

  return [...found]
}

/**
 * The media files a page points at, in the order they appear.
 *
 * This is what makes a plain page that just *contains* a video file work: the
 * file itself is the download, and it can go straight to the multi-connection
 * engine rather than being rediscovered by yt-dlp from the page URL.
 */
export function findDirectMediaUrls(html: string, baseUrl: string): string[] {
  return collectUrls(html, baseUrl, isDirectMediaUrl)
}

/**
 * The streaming manifests a page points at, in the order they appear.
 *
 * This is what makes a hand-rolled player work. Its page is not something yt-dlp
 * can read — the generic extractor answers "Unsupported URL" for the episode
 * page and for the `/_watch/1234` frame it embeds — while the manifest the page
 * hid in its markup downloads perfectly the moment it is handed over directly.
 */
export function findStreamUrls(html: string, baseUrl: string): string[] {
  return collectUrls(html, baseUrl, isStreamManifestUrl)
}
/** Tokens that mark a frame as the one holding the video rather than an advert. */
const PLAYER_FRAME_HINT = /(player|watch|embed|play|video|movie|vod|stream|media)/i

/**
 * The embedded players a page declares, likeliest first.
 *
 * A player is usually an `<iframe>` (sometimes an `<embed>` or an `<object>`),
 * and the frame holding the video is rarely the first one on the page — advert
 * and tracker frames come and go. So candidates are scored: one whose URL names
 * a player outranks one that does not, and a same-site frame outranks a third
 * party. The caller walks only the top few, because every extra frame is a real
 * fetch on a path the user is already waiting on.
 *
 * A frame that names a file is dropped: `<iframe src="ad.png">` is a payload
 * masquerading as a document, and following it would waste a request.
 */
export function findPlayerFrames(html: string, baseUrl: string): string[] {
  const text = sniffWindow(html)
  const candidates = new Map<string, { url: string; score: number; order: number }>()
  let order = 0

  let pageHost = ''
  try {
    pageHost = new URL(baseUrl).hostname
  } catch {
    pageHost = ''
  }

  const consider = (raw: string): void => {
    const absolute = absoluteCandidate(raw, baseUrl)
    if (absolute === '' || candidates.has(absolute)) return
    let parsed: URL
    try {
      parsed = new URL(absolute)
    } catch {
      return
    }
    if (!isHttpUrl(parsed)) return
    if (hasFileExtension(absolute)) return

    let score = 0
    if (PLAYER_FRAME_HINT.test(parsed.pathname + parsed.search)) score += 2
    if (pageHost !== '' && parsed.hostname === pageHost) score += 1
    candidates.set(absolute, { url: absolute, score, order })
    order += 1
  }

  for (const match of text.matchAll(/<(?:iframe|frame|embed)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    consider(match[1]!)
  }
  for (const match of text.matchAll(/<object\b[^>]*?\bdata\s*=\s*["']([^"']+)["']/gi)) {
    consider(match[1]!)
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, PLAYER_FRAME_LIMIT)
    .map((entry) => entry.url)
}

/**
 * The page's own title, or ''.
 *
 * Only needed when a download has to be named from outside yt-dlp: a manifest
 * carries no title of its own — every HLS play list is called "index" — so the
 * page the user actually opened is the only honest source for a name.
 */
export function findPageTitle(html: string): string {
  const text = sniffWindow(html)
  const tag = /<meta[^>]+(?:property|name)\s*=\s*["']og:title["'][^>]*>/i.exec(text)
  const meta = tag ? (/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag[0])?.[1] ?? '') : ''
  const element = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(text)?.[1] ?? ''
  return cleanTitle(meta || element)
}

/** A title with its markup and entities undone, on one line, and bounded. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    // Last, so an escaped ampersand cannot expose a second entity.
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** Lowercase media type without its parameters, or ''. */
export function normalizeContentType(contentType: string): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase()
}

/**
 * True when the response *is* media, not a page that describes it.
 *
 * A URL that resolves straight to a video or a streaming manifest needs no
 * sniffing at all: the server already answered the question.
 */
export function isMediaContentType(contentType: string): boolean {
  const type = normalizeContentType(contentType)
  return (
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl' ||
    type === 'application/dash+xml'
  )
}

/** True when this response is a document whose body is worth reading. */
export function isHtmlContentType(contentType: string): boolean {
  const type = normalizeContentType(contentType)
  return type === 'text/html' || type === 'application/xhtml+xml'
}

/**
 * True when a body should be handed to a page parser at all.
 *
 * The same rule `looksLikeMediaPage` uses internally, exposed so the metadata
 * parser in the main process scans the identical set of bodies — and, just as
 * importantly, refuses the identical set. A binary payload that happens to
 * contain the bytes `video` is not a page, and must never be parsed as one.
 */
export function isScannableDocument(contentType: string, body: string): boolean {
  const type = normalizeContentType(contentType)
  return (
    isHtmlContentType(type) ||
    // A missing type is common on hand-rolled servers, but only a body that
    // starts like HTML is treated as a document.
    (type === '' && /^\s*<(?:!doctype\s+html|html)\b/i.test(body.slice(0, 256)))
  )
}

/**
 * Does this page look like it plays media?
 *
 * The content type decides the easy cases. A page is only scanned when it really
 * is a document (or the server omitted the type but the body is plainly HTML),
 * so a binary payload that happens to contain the bytes `video` is not mistaken
 * for a player, and a bare `.m3u8` response is caught by its content type rather
 * than by a marker.
 */
export function looksLikeMediaPage(contentType: string, body: string): boolean {
  if (isMediaContentType(contentType)) return true
  if (!isScannableDocument(contentType, body)) return false

  const scan = body.length > SNIFF_BYTE_LIMIT ? body.slice(0, SNIFF_BYTE_LIMIT) : body
  return MEDIA_PAGE_MARKERS.some((marker) => marker.test(scan))
}
