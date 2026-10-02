/**
 * URI and filename handling, shared by the main process and the renderer.
 *
 * This is the area where download managers most often get things wrong: a
 * filename read from a server or a URL is untrusted input, and on Windows it can
 * escape the target directory, collide with a reserved device name, or be
 * silently rewritten by the filesystem. Everything that reaches disk goes
 * through `sanitizeFileName`.
 */

/**
 * Device names reserved on Windows regardless of extension. Creating "CON.txt"
 * fails, and it fails in a confusing way, so we rename defensively.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

export function isReservedDeviceName(name: string): boolean {
  const withoutExtension = name.split('.')[0]?.toLowerCase() ?? ''
  return RESERVED_DEVICE_NAMES.has(withoutExtension)
}

/**
 * Extensions that name a *page* rather than a file.
 *
 * These look exactly like a file extension, but a URL ending in `.html` is a
 * web page you can watch a video on, not a payload worth handing to aria2. Video
 * sites are full of them — `/video/123.html`, `/watch.php?…` — and treating the
 * suffix as a file pushed every such link to the download engine, which then
 * saved the HTML instead of the video.
 */
const PAGE_EXTENSIONS = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'jspx', 'shtml'])

export function sanitizeFileName(input: string, fallback = 'download'): string {
  let name = (input ?? '').trim()

  // Keep only the last path segment, for both separator conventions.
  name = name.split(/[/\\]/).pop() ?? ''

  // Control characters plus the set Windows forbids: < > : " | ? * and NUL.
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')

  // A leading dot hides the file, and ".." collapses upward.
  name = name.replace(/^\.+/, '')

  // Windows strips trailing dots and spaces, silently producing a different
  // name than the user asked for. Normalise it ourselves instead.
  name = name.replace(/[. ]+$/, '')

  // Residual Windows path prefixes.
  name = name.replace(/^[a-zA-Z]:/, '')
  name = name.replace(/^\\\\\?\\/, '')

  if (name.length === 0) name = fallback
  if (isReservedDeviceName(name)) name = `_${name}`

  // Leave room for the directory and for the ".aria2" control file aria2 writes
  // alongside every download, so we do not brush against MAX_PATH.
  const MAX_LENGTH = 180
  if (name.length > MAX_LENGTH) {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    name = name.slice(0, MAX_LENGTH - extension.length) + extension
  }

  return name
}

/**
 * True when a dropped file is a list of links rather than a download itself.
 *
 * `.m3u`/`.m3u8` interleave `#EXTINF` directives with their URLs, and
 * `parseUriList` already drops `#` comments and blank lines — so the contents can
 * be appended as they are.
 */
export function isListFileName(name: string): boolean {
  return /\.(txt|list|urls|m3u8?)$/i.test(name.trim())
}

/** Percent-decode a path segment without throwing on malformed input. */
export function decodeUriSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Best-effort filename from a URI.
 *
 * This is only a suggestion for the UI and for `--out`; aria2 stays
 * authoritative on the final name because it also sees Content-Disposition.
 */
export function fileNameFromUri(uri: string): string {
  const trimmed = uri.trim()

  if (trimmed.startsWith('magnet:')) {
    const match = /[?&]dn=([^&]+)/i.exec(trimmed)
    if (match?.[1]) {
      return sanitizeFileName(decodeUriSegment(match[1].replace(/\+/g, ' ')), 'magnet 下載')
    }
    return 'magnet 下載'
  }

  try {
    const parsed = new URL(trimmed)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (last) {
      const decoded = decodeUriSegment(last)
      if (decoded && !decoded.endsWith('/')) return sanitizeFileName(decoded)
    }
    if (parsed.hostname) {
      return sanitizeFileName(`${parsed.hostname}${parsed.pathname.replace(/\//g, '_')}`)
    }
  } catch {
    // Not a URL; fall through to a primitive split.
  }

  return sanitizeFileName(trimmed.split('/').pop() ?? 'download')
}

export function fileNameFromPath(filePath: string): string {
  const segments = (filePath ?? '').split(/[/\\]/).filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

/** Lowercase extension without the dot, or an empty string. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export type UriKind = 'http' | 'ftp' | 'bittorrent'

/**
 * True when the URL appears to name a file rather than a page or an endpoint.
 *
 * Short extensions only: a path segment like `/watch` or `/status/12345` carries
 * no dot, and a long segment with a dot in it ("v2.1.3-notes") is a slug, not a
 * file. Page extensions are excluded outright — see `PAGE_EXTENSIONS`. Servers
 * that hand out files behind a script often name them in the query instead, so
 * those keys are checked too.
 *
 * Used both to decide whether a copied link is safe to auto-add and to keep
 * direct CDN payloads away from the media engine.
 */
export function hasFileExtension(url: string): boolean {
  if (url.trim().toLowerCase().startsWith('magnet:')) return true

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
  const extension = extensionOf(lastSegment)
  if (extension.length >= 2 && extension.length <= 5 && !PAGE_EXTENSIONS.has(extension)) return true

  // An explicit `?filename=thing.html` is the server declaring a download, so
  // page extensions count here even though they do not in the path.
  for (const key of ['filename', 'file', 'download', 'name']) {
    const value = parsed.searchParams.get(key)
    if (value && extensionOf(value).length >= 2) return true
  }
  return false
}

/** Guess a transport from a URI. Unknown schemes report as http, never guessed. */
export function kindFromUri(uri: string): UriKind {
  const lower = uri.trim().toLowerCase()
  if (lower.startsWith('magnet:')) return 'bittorrent'
  if (lower.startsWith('ftp://') || lower.startsWith('sftp://')) return 'ftp'
  return 'http'
}

/**
 * Split a pasted blob into candidate URIs, preserving order, dropping blanks and
 * comments, and removing exact duplicates.
 */
export function parseUriList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rawLine of text.split(/[\r\n]+/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

export interface ClassifiedUris {
  /** Groups of URIs that share a filename, so they are mirrors of one file. */
  mirrors: string[][]
  /** URIs whose filename is unique, so each is its own download. */
  singles: string[]
}

/**
 * Decide whether a pasted list is one download with mirrors or several separate
 * downloads. A shared suggested filename is the practical signal for mirrors,
 * which is what makes pasting a multi-mirror list do the expected thing.
 */
export function classifyUriList(uris: string[]): ClassifiedUris {
  const byName = new Map<string, string[]>()
  const order: string[] = []

  for (const uri of uris) {
    const name = fileNameFromUri(uri).toLowerCase()
    const key = uri.startsWith('magnet:') ? `magnet:${uri}` : name
    if (!byName.has(key)) {
      byName.set(key, [])
      order.push(key)
    }
    byName.get(key)!.push(uri)
  }

  const mirrors: string[][] = []
  const singles: string[] = []
  for (const key of order) {
    const group = byName.get(key)!
    if (group.length > 1) mirrors.push(group)
    else singles.push(group[0]!)
  }
  return { mirrors, singles }
}

/** Basic validation before we hand a URI to the engine. */
export function isSupportedUri(uri: string): boolean {
  const lower = uri.trim().toLowerCase()
  if (lower.startsWith('magnet:')) return true
  return /^(https?|ftp|sftp):\/\//i.test(lower)
}

export function detectKindFromList(uris: string[]): 'http' | 'ftp' | 'bittorrent' {
  if (uris.some((uri) => uri.trim().toLowerCase().startsWith('magnet:'))) return 'bittorrent'
  if (uris.some((uri) => /^(ftp|sftp):\/\//i.test(uri.trim()))) return 'ftp'
  return 'http'
}
