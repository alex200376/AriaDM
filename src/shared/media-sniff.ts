/**
 * Page-content video detection.
 *
 * The curated host list in `media-sites.ts` is the fast, predictable answer for
 * sites we already know. This module is the fallback for the rest: a page on an
 * unknown host can still be a video page, and the honest way to tell is to read
 * a little of it and look for the things a playable page always has.
 *
 * Everything here is pure — it takes an already-fetched content type and body
 * prefix and returns a verdict — so it can be unit-tested without a network, and
 * the fetching lives in `src/main/media/page-sniff.ts` where it belongs.
 */

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
 * the yt-dlp path exists to avoid.
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

/** How many files one page may contribute, so a listing cannot flood the queue. */
export const PAGE_MEDIA_LIMIT = 50

/** The lowercased extension of a URL's last path segment, or ''. */
function mediaExtensionOf(pathname: string): string {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase()
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
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return DIRECT_MEDIA_EXTENSIONS.has(mediaExtensionOf(parsed.pathname))
}

/**
 * The media files a page points at, in the order they appear.
 *
 * This is what makes a plain page that just *contains* a video file work: the
 * file itself is the download, and it can go straight to the multi-connection
 * engine rather than being rediscovered by yt-dlp from the page URL. Both markup
 * (`src`, `href`, `content`) and bare URLs are read, because a script-built
 * player keeps the address in its own setup rather than in the element it
 * renders; JSON-escaped slashes are unescaped first for the same reason.
 *
 * Pure, so the judgement is unit-tested without a network — the fetching lives
 * in `src/main/media/page-sniff.ts`.
 */
export function findDirectMediaUrls(html: string, baseUrl: string): string[] {
  const text = (html.length > SNIFF_BYTE_LIMIT ? html.slice(0, SNIFF_BYTE_LIMIT) : html).replace(
    /\\\//g,
    '/'
  )
  const found = new Set<string>()

  const consider = (raw: string): void => {
    if (found.size >= PAGE_MEDIA_LIMIT) return
    const candidate = raw.trim().replace(/&amp;/g, '&')
    if (candidate === '') return
    let absolute: string
    try {
      // A bare path (`/media/a.mp4`) resolves against the page it was found on.
      absolute = new URL(candidate, baseUrl).toString()
    } catch {
      return
    }
    if (isDirectMediaUrl(absolute) && !found.has(absolute)) found.add(absolute)
  }

  for (const match of text.matchAll(
    /\b(?:src|href|data-src|data-href|data-url|content)\s*=\s*["']([^"']+)["']/gi
  )) {
    consider(match[1]!)
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    consider(match[0]!)
  }

  return [...found]
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
