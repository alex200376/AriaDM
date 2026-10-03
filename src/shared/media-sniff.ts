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
