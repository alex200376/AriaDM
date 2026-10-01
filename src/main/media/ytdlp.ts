import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'

import type { MediaFormatInfo } from '@shared/settings'

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
  duration?: number
  thumbnail?: string
  webpage_url?: string
  formats?: RawFormat[]
  entries?: RawProbe[]
}

export interface MediaProbe {
  url: string
  title: string
  id: string
  durationSeconds: number
  thumbnail: string
  formats: MediaFormatInfo[]
  /** True when this looked like a playlist rather than a single item. */
  isPlaylist: boolean
}

export interface YtDlpProgress {
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
 */
export function httpHeaderArgs(context: HttpContext): string[] {
  const args: string[] = []
  const add = (name: string, value: string | undefined): void => {
    if (!value) return
    args.push('--add-headers', `${name}: ${value.replace(/[\r\n]+/g, ' ')}`)
  }
  add('Cookie', context.cookieHeader)
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
}

export function buildProbeArgs(url: string, context: HttpContext & CredentialOptions = {}): string[] {
  return [
    '--dump-single-json',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--socket-timeout',
    '30',
    ...(context.cookieArgs ?? []),
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

      resolve({
        url,
        title: primary.title ?? payload.title ?? url,
        id: primary.id ?? '',
        durationSeconds: primary.duration ?? 0,
        thumbnail: primary.thumbnail ?? '',
        formats: parseFormats(primary, options.hasFfmpeg),
        isPlaylist
      })
    })
  })
}

export interface YtDlpRunOptions extends HttpContext, CredentialOptions {
  binaryPath: string
  url: string
  formatId: string
  dir: string
  /** Directory containing ffmpeg, when present. */
  ffmpegDir: string
  audioOnly: boolean
  playlist: boolean
  /** Overwrite an existing final file rather than renaming. */
  overwrite: boolean
}

export function buildDownloadArgs(options: YtDlpRunOptions): string[] {
  const args: string[] = [
    '--newline',
    '--no-colors',
    // A machine readable progress line instead of parsing the human readout.
    '--progress-template',
    'download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s',
    '--print',
    'after_move:ariadm-file:%(filepath)s'
  ]

  if (options.playlist) {
    args.push('--yes-playlist')
  } else {
    args.push('--no-playlist')
  }

  args.push('-f', options.formatId || (options.audioOnly ? 'bestaudio/best' : 'bestvideo+bestaudio/best'))

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
  args.push('--paths', options.dir)

  if (options.ffmpegDir) args.push('--ffmpeg-location', options.ffmpegDir)

  args.push(...(options.cookieArgs ?? []))
  args.push(...httpHeaderArgs(options))

  args.push('--no-warnings')
  args.push(options.url)
  return args
}

/** Parse one `download:` progress line. Returns null for any other line. */
export function parseProgressLine(line: string): YtDlpProgress | null {
  if (!line.startsWith('download:')) return null
  const parts = line.slice('download:'.length).trim().split('|')
  if (parts.length < 4) return null

  const parse = (value: string): number => {
    if (!value || value === 'NA' || value === 'None') return 0
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return {
    downloadedBytes: parse(parts[0]!),
    totalBytes: parse(parts[1]!),
    speed: parse(parts[2]!),
    eta: parse(parts[3]!)
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

    if (trimmed.startsWith('ariadm-file:')) {
      this.emit('file', trimmed.slice('ariadm-file:'.length))
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
