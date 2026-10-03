import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'

import type { AudioFormat, MediaFormatInfo, MediaPlaylistInfo, SubtitleTrack } from '@shared/settings'

/**
 * yt-dlp wrapper.
 *
 * Two things worth knowing about this engine:
 *  - It has no pause. Pausing here means terminating the process, and resuming
 *    means relaunching with `-c` so the partially written `.part` file continues
 *    rather than restarting. That is a real behavioural difference from aria2 and
 *    the UI says so rather than pretending otherwise.
 *  - Progress arrives as text on stdout, so we ask for a machine readable
 *    template instead of trying to parse the human output.
 */

interface RawFormat {
  format_id?: string
  ext?: string
  /** The stream's own URL, and how yt-dlp says it should be fetched. */
  url?: string
  protocol?: string
  resolution?: string
  width?: number
  height?: number
  filesize?: number
  filesize_approx?: number
  vcodec?: string
  acodec?: string
  format_note?: string
  fps?: number
  tbr?: number
}

interface RawProbe {
  title?: string
  id?: string
  /** yt-dlp's extractor name, e.g. 'generic' or 'youtube'. */
  extractor?: string
  duration?: number
  thumbnail?: string
  webpage_url?: string
  url?: string
  formats?: RawFormat[]
  entries?: RawProbe[]
  /** Manual subtitle tracks, keyed by language code. */
  subtitles?: Record<string, unknown>
  /** Auto-generated caption tracks, keyed by language code. */
  automatic_captions?: Record<string, unknown>
}

export interface MediaProbe {
  url: string
  title: string
  id: string
  durationSeconds: number
  thumbnail: string
  formats: MediaFormatInfo[]
  /** Languages this video offers subtitles in, manual first. */
  subtitles: SubtitleTrack[]
  /** True when this looked like a playlist rather than a single item. */
  isPlaylist: boolean
  /** yt-dlp's extractor name, e.g. 'generic' or 'youtube'. */
  extractor: string
  /**
   * The file URL when the probe found nothing but a plain HTTP(S) payload.
   *
   * Empty for anything that is really a media page. Set means the link was a
   * file all along — possibly a page whose only media is that file — and aria2
   * should fetch it instead of yt-dlp: one connection plus a per-run startup and
   * an extraction pass is tens of times slower on a bare payload, and yt-dlp
   * reports no size for it, so the row's speed and ETA come out as noise.
   */
  directUrl: string
}

/**
 * 1-based positions compressed into yt-dlp's `--playlist-items` syntax.
 *
 * `[1,2,3,5]` becomes `1-3,5`. Runs are collapsed because that is the form
 * yt-dlp documents and the shortest one to read in a log; duplicates and
 * non-positions are dropped rather than trusted, since a bad value makes yt-dlp
 * refuse the whole run.
 */
export function formatPlaylistItems(indices: number[]): string {
  const sorted = [...new Set(indices.filter((value) => Number.isInteger(value) && value > 0))].sort(
    (a, b) => a - b
  )
  const parts: string[] = []
  let start = 0
  while (start < sorted.length) {
    let end = start
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1
    const from = sorted[start]!
    const to = sorted[end]!
    parts.push(from === to ? String(from) : `${from}-${to}`)
    start = end + 1
  }
  return parts.join(',')
}

/**
 * Turn a flat-playlist probe into the list the picker shows.
 *
 * A flat probe resolves only the playlist's own metadata, so each entry carries
 * a title, an id and a duration but no formats — which is exactly what a chooser
 * needs, and fast even for a list with hundreds of items.
 */
export function parsePlaylist(payload: RawProbe): MediaPlaylistInfo {
  const entries = (payload.entries ?? []).map((entry, index) => ({
    id: entry.id ?? String(index + 1),
    title: entry.title ?? entry.id ?? `#${index + 1}`,
    durationSeconds: entry.duration ?? 0,
    url: entry.webpage_url ?? entry.url ?? '',
    thumbnail: entry.thumbnail ?? ''
  }))
  return { title: payload.title ?? '', entries }
}

export interface YtDlpProgress {
  /**
   * The file this update is about — one *stream* of the download, not the
   * finished file.
   *
   * yt-dlp downloads a merged quality as two separate streams and restarts its
   * counters for each, so without this a row would jump back to zero when the
   * audio half began and its size would shrink to the audio file.
   */
  file: string
  downloadedBytes: number
  totalBytes: number
  speed: number
  eta: number
}

function humanResolution(format: RawFormat): string {
  if (format.resolution && format.resolution !== 'audio only') return format.resolution
  if (format.width && format.height) return `${format.width}x${format.height}`
  if (format.height) return `${format.height}p`
  return ''
}

/**
 * The direct file URL behind a probe, when there is exactly one plain payload.
 *
 * The generic extractor is yt-dlp saying "I did not recognise this site; here is
 * the one thing that looked downloadable". A single HTTP(S) format from it is a
 * file, not a stream: HLS and DASH report protocols like `m3u8_native` and
 * `http_dash_segments`, which must stay with yt-dlp. Anything with several
 * formats is a real media page and is left alone too.
 */
function directPayloadUrl(primary: RawProbe, extractor: string, isPlaylist: boolean): string {
  if (extractor !== 'generic' || isPlaylist) return ''
  const raw = primary.formats ?? []
  if (raw.length !== 1) return ''

  const format = raw[0]!
  const protocol = (format.protocol ?? '').toLowerCase()
  if (protocol !== 'http' && protocol !== 'https') return ''
  return format.url ?? ''
}

/**
 * The subtitle languages a probe found, manual and automatic merged.
 *
 * A language that has both a hand-authored track and an auto-generated one is
 * listed once, as the manual track: it is the better of the two and the one the
 * download should prefer. Sorted so the picker's order does not depend on the
 * order the extractor happened to report them in.
 */
export function parseSubtitles(payload: RawProbe): SubtitleTrack[] {
  const tracks = new Map<string, SubtitleTrack>()
  for (const code of Object.keys(payload.subtitles ?? {})) {
    if (code) tracks.set(code, { code, auto: false })
  }
  for (const code of Object.keys(payload.automatic_captions ?? {})) {
    if (code && !tracks.has(code)) tracks.set(code, { code, auto: true })
  }
  return [...tracks.values()].sort((a, b) => a.code.localeCompare(b.code))
}

/**
 * Turn yt-dlp's format list into something a person can choose from, and add a
 * synthetic "best" entry that mirrors what the site would recommend.
 */
export function parseFormats(payload: RawProbe, hasFfmpeg: boolean): MediaFormatInfo[] {
  const entries: MediaFormatInfo[] = []
  const raw = payload.formats ?? []

  const best = raw
    .filter((format) => (format.vcodec ?? 'none') !== 'none' && (format.acodec ?? 'none') !== 'none')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]

  entries.push({
    formatId: 'bestvideo+bestaudio/best',
    label: '最佳畫質（自動合併音訊）',
    ext: 'mp4',
    resolution: best ? humanResolution(best) : '最佳',
    filesize: null,
    vcodec: 'auto',
    acodec: 'auto',
    note: hasFfmpeg ? '建議' : '需要 ffmpeg 才能合併',
    needsFfmpeg: true
  })

  const videoOnly = raw
    .filter((format) => (format.vcodec ?? 'none') !== 'none' && (format.acodec ?? 'none') === 'none')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))

  const combined = raw.filter(
    (format) => (format.vcodec ?? 'none') !== 'none' && (format.acodec ?? 'none') !== 'none'
  )

  const audioOnly = raw
    .filter((format) => (format.vcodec ?? 'none') === 'none' && (format.acodec ?? 'none') !== 'none')
    .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))

  for (const format of [...combined, ...videoOnly]) {
    if (!format.format_id) continue
    entries.push({
      formatId: format.format_id,
      label: `${humanResolution(format) || format.format_note || '影片'} · ${format.ext ?? 'mp4'}`,
      ext: format.ext ?? 'mp4',
      resolution: humanResolution(format),
      filesize: format.filesize ?? format.filesize_approx ?? null,
      vcodec: format.vcodec ?? 'none',
      acodec: format.acodec ?? 'none',
      note: format.format_note ?? '',
      // Video-only streams must be muxed with an audio track, which needs ffmpeg.
      needsFfmpeg: (format.acodec ?? 'none') === 'none'
    })
  }

  for (const format of audioOnly.slice(0, 6)) {
    if (!format.format_id) continue
    entries.push({
      formatId: format.format_id,
      label: `純音訊 · ${format.ext ?? 'm4a'}${format.tbr ? ` · ${Math.round(format.tbr)}kbps` : ''}`,
      ext: format.ext ?? 'm4a',
      resolution: 'audio',
      filesize: format.filesize ?? format.filesize_approx ?? null,
      vcodec: 'none',
      acodec: format.acodec ?? 'none',
      note: format.format_note ?? '',
      needsFfmpeg: false
    })
  }

  entries.push({
    formatId: 'bestaudio/best',
    label: '純音訊（最佳）',
    ext: 'm4a',
    resolution: 'audio',
    filesize: null,
    vcodec: 'none',
    acodec: 'auto',
    note: '直接抓取既有音軌，不需重新編碼',
    needsFfmpeg: false
  })

  return entries
}

/** The HTTP context a browser handed us, reused for both probing and downloading. */
export interface HttpContext {
  cookieHeader?: string
  referer?: string
  userAgent?: string
}

/**
 * `--add-headers` arguments for a request context.
 *
 * Values are flattened onto one line: a newline inside a header value would let
 * a crafted cookie string smuggle in additional arguments.
 *
 * The Cookie header is deliberately omitted when a cookie *file* is in use. A
 * header only rides along on requests; it never reaches yt-dlp's cookie jar, and
 * the extractors that matter authenticate from the jar (`_get_cookies`). Sending
 * both would also be sending the site two competing sessions, and yt-dlp itself
 * warns that a cookies-as-header is deprecated.
 */
export function httpHeaderArgs(context: HttpContext & CredentialOptions): string[] {
  const args: string[] = []
  const add = (name: string, value: string | undefined): void => {
    if (!value) return
    args.push('--add-headers', `${name}: ${value.replace(/[\r\n]+/g, ' ')}`)
  }
  if (!context.cookieFile) add('Cookie', context.cookieHeader)
  add('Referer', context.referer)
  add('User-Agent', context.userAgent)
  return args
}

/**
 * Credential arguments (a browser's cookie store) for a run.
 *
 * Kept separate from `HttpContext` on purpose: a Cookie header supplied by the
 * browser extension is that page's live session, while `--cookies-from-browser`
 * reads the user's profile off disk. Passing both would send yt-dlp two
 * conflicting cookie sets, so callers pick one (see MediaJobs).
 */
interface CredentialOptions {
  cookieArgs?: string[]
  /**
   * A Netscape cookies file holding a live session for this run.
   *
   * Used instead of `cookieHeader`, not alongside it: the file fills yt-dlp's
   * cookie jar, which is where its extractors look for a session. See
   * `media/cookie-file.ts`.
   */
  cookieFile?: string
}

/** `--cookies <file>` for a run that was given a session file. */
function cookieFileArgs(options: CredentialOptions): string[] {
  return options.cookieFile ? ['--cookies', options.cookieFile] : []
}

export function buildProbeArgs(url: string, context: HttpContext & CredentialOptions = {}): string[] {
  return [
    '--dump-single-json',
    /*
     * Never read a config file. yt-dlp loads `yt-dlp.conf` from the working
     * directory and the user's home before its own arguments, so a file an
     * attacker managed to place there would run with our flags. It also keeps
     * the app predictable: a stray config on the machine cannot silently change
     * a probe's behaviour.
     */
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--socket-timeout',
    '30',
    ...(context.cookieArgs ?? []),
    ...cookieFileArgs(context),
    ...httpHeaderArgs(context),
    url
  ]
}

/**
 * Arguments for listing a playlist without resolving every item.
 *
 * `--flat-playlist` is the whole point: a normal probe of a large playlist would
 * resolve each entry (seconds per item), where this returns the titles, ids and
 * durations straight from the list page.
 */
export function buildPlaylistProbeArgs(url: string, context: HttpContext & CredentialOptions = {}): string[] {
  return [
    '--flat-playlist',
    '--dump-single-json',
    '--ignore-config',
    '--no-warnings',
    '--no-check-certificates',
    '--socket-timeout',
    '30',
    ...(context.cookieArgs ?? []),
    ...cookieFileArgs(context),
    ...httpHeaderArgs(context),
    url
  ]
}

export async function probeFormats(
  binaryPath: string,
  url: string,
  options: { hasFfmpeg: boolean; timeoutMs?: number } & HttpContext & CredentialOptions
): Promise<MediaProbe> {
  const timeoutMs = options.timeoutMs ?? 45_000

  return new Promise<MediaProbe>((resolve, reject) => {
    const child = spawn(binaryPath, buildProbeArgs(url, options), { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('讀取影片資訊逾時。'))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`無法執行 yt-dlp：${error.message}`))
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      const output = Buffer.concat(stdout).toString('utf8').trim()
      if (code !== 0 || output.length === 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).slice(-3).join(' ')
        reject(new Error(message || `yt-dlp 結束，代碼 ${code ?? '未知'}`))
        return
      }

      let payload: RawProbe
      try {
        payload = JSON.parse(output) as RawProbe
      } catch {
        reject(new Error('無法解析 yt-dlp 的輸出。'))
        return
      }

      const isPlaylist = Array.isArray(payload.entries)
      const primary: RawProbe = isPlaylist && payload.entries?.[0] ? payload.entries[0]! : payload

      const extractor = primary.extractor ?? payload.extractor ?? ''

      resolve({
        url,
        title: primary.title ?? payload.title ?? url,
        id: primary.id ?? '',
        durationSeconds: primary.duration ?? 0,
        thumbnail: primary.thumbnail ?? '',
        formats: parseFormats(primary, options.hasFfmpeg),
        subtitles: parseSubtitles(primary),
        isPlaylist,
        extractor,
        directUrl: directPayloadUrl(primary, extractor, isPlaylist)
      })
    })
  })
}

export async function probePlaylist(
  binaryPath: string,
  url: string,
  options: { timeoutMs?: number } & HttpContext & CredentialOptions
): Promise<MediaPlaylistInfo> {
  const timeoutMs = options.timeoutMs ?? 45_000

  return new Promise<MediaPlaylistInfo>((resolve, reject) => {
    const child = spawn(binaryPath, buildPlaylistProbeArgs(url, options), { windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error('讀取播放清單逾時。'))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`無法執行 yt-dlp：${error.message}`))
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      const output = Buffer.concat(stdout).toString('utf8').trim()
      if (code !== 0 || output.length === 0) {
        const message = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).slice(-3).join(' ')
        reject(new Error(message || `yt-dlp 結束，代碼 ${code ?? '未知'}`))
        return
      }

      try {
        resolve(parsePlaylist(JSON.parse(output) as RawProbe))
      } catch {
        reject(new Error('無法解析 yt-dlp 的輸出。'))
      }
    })
  })
}

/** Most fragments yt-dlp will fetch at once; beyond this it stops paying off. */
const MAX_CONCURRENT_FRAGMENTS = 16
/** Bounds on a chunked request size, so a bad setting cannot explode a download. */
const MIN_HTTP_CHUNK_SIZE = 256 * 1024
const MAX_HTTP_CHUNK_SIZE = 32 * 1024 * 1024

export interface YtDlpRunOptions extends HttpContext, CredentialOptions {
  binaryPath: string
  url: string
  formatId: string
  dir: string
  /** Directory containing ffmpeg, when present. */
  ffmpegDir: string
  audioOnly: boolean
  playlist: boolean
  /**
   * How many HLS/DASH fragments to fetch in parallel.
   *
   * This is the native downloader's own multithreading, and it is the only safe
   * way to speed up fragmented downloads: yt-dlp removed support for downloading
   * fragmented manifests through aria2c in 2026.06.09 (GHSA-vx4q-3cr2-7cg2),
   * because a malicious manifest could inject aria2c input-file options. 1 means
   * the yt-dlp default of one fragment at a time.
   */
  concurrentFragments?: number
  /**
   * Size of each ranged HTTP request yt-dlp makes, in bytes; 0 disables it.
   *
   * Every fragment of an HLS/DASH download is fetched through yt-dlp's normal
   * HTTP downloader, so this splits each fragment into a series of ranged
   * requests. A server that throttles a connection — which is what makes a
   * single 1.4 MB segment crawl — sees a fresh request per chunk and speeds up
   * accordingly. Experimental upstream; off by default.
   */
  httpChunkSize?: number
  /** Subtitle tracks to write, and whether to mux them into the video. */
  subtitles?: { codes: string[]; embed: boolean }
  /** Convert the audio track to this format; 'native' keeps the site's own. */
  audioFormat?: AudioFormat
  /** 1-based playlist positions to download; empty means "the site's default". */
  playlistItems?: number[]
  /** Overwrite an existing final file rather than renaming. */
  overwrite: boolean
}

export function buildDownloadArgs(options: YtDlpRunOptions): string[] {
  const args: string[] = [
    '--newline',
    '--no-colors',
    /*
     * Same reasoning as the probe: no config file is read, so nothing on the
     * machine can inject options into the command line we build.
     */
    '--ignore-config',
    /*
     * `--print` implies `--quiet`, and quiet is exactly what switches progress
     * off. Asking for a progress template under `--quiet` therefore produced no
     * progress at all: every media row sat on 0 B and then jumped straight to
     * "completed". `--progress` is the documented way to show progress "even if
     * in quiet mode".
     */
    '--progress',
    /*
     * A machine readable progress line instead of parsing the human readout.
     *
     * The leading `download:` is yt-dlp's type *selector*, and it is consumed
     * rather than printed — so it has to be written twice: the second one is
     * literal text that reaches stdout, which is what parseProgressLine reads.
     *
     * The filename comes first because it is the only thing that distinguishes
     * the video stream from the audio one during a merge.
     */
    '--progress-template',
    'download:download:%(progress.filename)j|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
    '--print',
    'after_move:ariadm-file:%(filepath)j'
  ]

  if (options.playlist) {
    args.push('--yes-playlist')
  } else {
    args.push('--no-playlist')
  }

  /*
   * Fragmented manifests always go to yt-dlp's own downloader.
   *
   * This is a hard guard, not a preference. Handing HLS/DASH to an external
   * downloader is what GHSA-vx4q-3cr2-7cg2 exploited, and yt-dlp dropped that
   * path entirely in 2026.06.09. Spelling out `native` for these protocols means
   * an external downloader set by any future config, flag or upgrade can never
   * be applied to a fragmented manifest — and it is also what makes
   * `--concurrent-fragments` below take effect, since that option is ignored
   * whenever an external downloader is in use.
   */
  args.push('--downloader', 'dash,m3u8:native')

  // Parallel fragments, the supported speed-up for HLS/DASH. Left out at 1 so
  // the default command line stays the default yt-dlp behaviour.
  const fragments = Math.floor(options.concurrentFragments ?? 1)
  if (fragments > 1) args.push('--concurrent-fragments', String(Math.min(fragments, MAX_CONCURRENT_FRAGMENTS)))

  /*
   * Chunked requests, for a server that throttles a connection.
   *
   * Clamped rather than trusted: a tiny chunk would turn one fragment into
   * thousands of requests, and one above the cap would be rejected by yt-dlp's
   * own parsing. The value is bytes; the UI collects it in MB.
   */
  const chunkSize = Math.floor(options.httpChunkSize ?? 0)
  if (chunkSize > 0) {
    const clamped = Math.min(Math.max(chunkSize, MIN_HTTP_CHUNK_SIZE), MAX_HTTP_CHUNK_SIZE)
    args.push('--http-chunk-size', String(clamped))
  }

  /*
   * A chosen subset of a playlist. `--yes-playlist` above is what lets yt-dlp
   * consider more than one item; this narrows it to the positions the user
   * ticked. yt-dlp refuses a malformed value, so it is compressed and filtered
   * by `formatPlaylistItems` before it ever reaches the command line.
   */
  if (options.playlistItems && options.playlistItems.length > 0) {
    args.push('--playlist-items', formatPlaylistItems(options.playlistItems))
  }

  args.push('-f', options.formatId || (options.audioOnly ? 'bestaudio/best' : 'bestvideo+bestaudio/best'))

  /*
   * Subtitles. `--write-auto-subs` is requested alongside `--write-subs` because
   * the picker cannot know in advance whether a chosen language has a manual
   * track: `--sub-langs` filters whatever either switch turns on, so asking for
   * both and letting the language list decide is correct either way. Embedding
   * needs ffmpeg, which the caller checks before we get here.
   */
  const subtitleCodes = options.subtitles?.codes ?? []
  if (subtitleCodes.length > 0) {
    args.push('--write-subs', '--write-auto-subs', '--sub-langs', subtitleCodes.join(','))
    args.push('--sub-format', 'srt/best')
    if (options.subtitles?.embed) args.push('--embed-subs')
  }

  // Audio conversion. 'native' means "take the track the site already serves",
  // which is the default and needs no ffmpeg.
  const audioFormat = options.audioFormat ?? 'native'
  if (audioFormat !== 'native') {
    args.push('--extract-audio', '--audio-format', audioFormat, '--audio-quality', '0')
  }

  // Continue from a partial .part file. This is what makes resume-after-pause
  // work given yt-dlp has no pause of its own.
  args.push('-c')

  if (options.overwrite) args.push('--force-overwrites')

  if (process.platform === 'win32') {
    // Ask yt-dlp to produce names that are legal on Windows; it knows the rules
    // better than a generic sanitiser and handles the reserved names too.
    args.push('--windows-filenames')
  }

  args.push('-o', '%(title).150B [%(id)s].%(ext)s')
  // Only when there is one. An empty value is not "the default": yt-dlp would
  // resolve it against the process's working directory, which for a packaged app
  // is its own installation folder.
  if (options.dir) args.push('--paths', options.dir)

  if (options.ffmpegDir) args.push('--ffmpeg-location', options.ffmpegDir)

  args.push(...(options.cookieArgs ?? []))
  args.push(...cookieFileArgs(options))
  args.push(...httpHeaderArgs(options))

  args.push('--no-warnings')
  args.push(options.url)
  return args
}

/**
 * A value printed with yt-dlp's `j` conversion, or the text exactly as it came.
 *
 * yt-dlp writes its stdout in the console code page — Big5 on a Chinese Windows,
 * cp1251 on a Russian one — so a non-ASCII filename arrives as bytes that are not
 * UTF-8, and decoding them as UTF-8 turns every Chinese character into a
 * replacement character. That is not a display problem: the path recorded for the
 * download is then one that no file can be opened, revealed or deleted by, and it
 * is the name the row shows.
 *
 * `j` escapes every non-ASCII character to `\uXXXX`, so the whole line is ASCII
 * and no code page can touch it.
 */
function decodeJsonField(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'string') return parsed
  } catch {
    // An older yt-dlp may not know the conversion; take what it printed.
  }
  return raw
}

/**
 * The output path from one `ariadm-file:` line, or null for any other line.
 *
 * Used when `--print` runs *after* the final move, so this names the finished
 * file — the merged one when a quality was assembled from two streams.
 */
export function parseFileLine(line: string): string | null {
  if (!line.startsWith('ariadm-file:')) return null
  return decodeJsonField(line.slice('ariadm-file:'.length))
}

/** Parse one `download:` progress line. Returns null for any other line. */
export function parseProgressLine(line: string): YtDlpProgress | null {
  if (!line.startsWith('download:')) return null
  const parts = line.slice('download:'.length).trim().split('|')
  // filename, downloaded, total, speed, eta. Fewer means this is not one of our
  // lines at all — a bare `download:1|2|3|4` would otherwise be read as a file
  // named "1", which is worse than ignoring it.
  if (parts.length < 5) return null

  const parse = (value: string): number => {
    if (!value || value === 'NA' || value === 'None') return 0
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  // The last four fields are numbers; anything before them is the filename. A
  // filename cannot contain `|` on a platform we write to, but reading it this
  // way means a separator inside one could never shift the numbers.
  const split = parts.length - 4

  return {
    file: decodeJsonField(parts.slice(0, split).join('|')),
    downloadedBytes: parse(parts[split]!),
    totalBytes: parse(parts[split + 1]!),
    speed: parse(parts[split + 2]!),
    eta: parse(parts[split + 3]!)
  }
}

export interface YtDlpRunnerEvents {
  progress: (progress: YtDlpProgress) => void
  /** Emitted with the final path yt-dlp reported. */
  file: (filePath: string) => void
  done: () => void
  failed: (message: string) => void
  log: (line: string) => void
}

/**
 * One yt-dlp invocation.
 *
 * Note that stdout MUST be drained: yt-dlp prints a progress line per update, and
 * on Windows an unread pipe will fill and block the child, which presents as a
 * download that silently stops.
 */
export class YtDlpRunner extends EventEmitter {
  private child: ChildProcess | null = null
  private stderrTail: string[] = []
  private settled = false

  constructor(private readonly options: YtDlpRunOptions) {
    super()
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  start(): void {
    const args = buildDownloadArgs(this.options)
    this.emit('log', `yt-dlp ${args.join(' ')}`)

    const child = spawn(this.options.binaryPath, args, { windowsHide: true })
    this.child = child

    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      // Keep the trailing partial line for the next chunk.
      buffer = lines.pop() ?? ''
      for (const line of lines) this.handleStdoutLine(line)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrTail.push(line.trim())
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      }
    })

    child.on('error', (error) => {
      if (this.settled) return
      this.settled = true
      this.emit('failed', `無法執行 yt-dlp：${error.message}`)
    })

    child.on('exit', (code) => {
      if (this.settled) return
      this.settled = true
      this.child = null
      if (code === 0) {
        this.emit('done')
      } else {
        const detail = this.stderrTail.slice(-3).join(' ').trim()
        this.emit('failed', detail || `yt-dlp 結束，代碼 ${code ?? '未知'}`)
      }
    })
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    const file = parseFileLine(trimmed)
    if (file !== null) {
      this.emit('file', file)
      return
    }

    const progress = parseProgressLine(trimmed)
    if (progress) {
      this.emit('progress', progress)
      return
    }

    this.emit('log', trimmed)
  }

  /**
   * Terminate. yt-dlp writes into a `.part` file, so a kill loses only the last
   * flush and the next run can continue from it.
   */
  kill(): void {
    if (!this.child) return
    try {
      this.child.kill()
    } catch {
      // Already gone.
    }
  }
}

export function suggestOutputDir(dir: string, subdirectory: string): string {
  return subdirectory ? path.join(dir, subdirectory) : dir
}
