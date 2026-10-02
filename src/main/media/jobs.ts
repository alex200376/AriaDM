import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { DownloadItem } from '@shared/download'
import { classifyMediaError, type MediaErrorKind } from '@shared/media-errors'
import type { AddMediaInput, AudioFormat, MediaFormatInfo, MediaPlaylistInfo } from '@shared/settings'
import { extensionOf } from '@shared/uri'

import type { HistoryRecord, HistoryStore } from '../downloads/history-store'

import {
  probeFormats,
  probePlaylist,
  YtDlpRunner,
  type HttpContext,
  type MediaProbe,
  type YtDlpProgress
} from './ytdlp'

/**
 * yt-dlp jobs, presented as ordinary download items.
 *
 * Media downloads are tracked separately from the aria2 queue because the two
 * engines have different lifecycles and different controls. They are merged into
 * the same list at the IPC boundary, so the UI does not need to know which engine
 * owns a row.
 *
 * GIDs are prefixed so a command can be routed to the right engine unambiguously.
 */
export const MEDIA_GID_PREFIX = 'ytdlp:'

export function isMediaGid(gid: string): boolean {
  return gid.startsWith(MEDIA_GID_PREFIX)
}

/**
 * How often a running media download may push state at the UI.
 *
 * yt-dlp reports progress once per network read, which on a fast connection is
 * far more often than a row can be redrawn — and every notification costs a full
 * poll of the aria2 queue plus a state push. The byte counts are always current;
 * only the notification is paced.
 */
const PROGRESS_NOTIFY_MS = 150

/** One stream of a download, as yt-dlp last reported it. */
interface StreamProgress {
  downloaded: number
  total: number
}

/**
 * Fold one stream update into a job's running totals.
 *
 * A merged quality is fetched as two streams, reported one after the other with
 * a counter that restarts: the video stream's 100% would be followed by the
 * audio stream's 0%, so a row reading the last line alone falls back to nothing
 * mid-download and its size changes to the audio file's. Summing per file keeps
 * both moving forward, and it ends at the size of the finished file rather than
 * at whichever half finished last.
 */
export function mergeStreamProgress(
  streams: Map<string, StreamProgress>,
  progress: YtDlpProgress
): { downloadedBytes: number; totalBytes: number } {
  streams.set(progress.file, { downloaded: progress.downloadedBytes, total: progress.totalBytes })

  let downloadedBytes = 0
  let totalBytes = 0
  for (const stream of streams.values()) {
    downloadedBytes += stream.downloaded
    totalBytes += stream.total
  }
  return { downloadedBytes, totalBytes }
}

/**
 * Failures that mean "the cookie store could not be read".
 *
 * yt-dlp treats an unreadable cookie database as fatal — a Chromium that is
 * merely running, or one that encrypts its cookies with an app-bound key (issue
 * 10927), fails the whole run — even though most videos need no session at all.
 * The store is only ever read when no Cookie header was supplied, so blaming it
 * here is safe.
 */
const STORE_FAILURES = new Set<MediaErrorKind>([
  'cookies-locked',
  'cookies-undecryptable',
  'cookies-missing'
])

/**
 * Failures that mean "the site refused the session it was given".
 *
 * YouTube answers a logged-in cookie jar with "The page needs to be reloaded",
 * and the very same video downloads fine signed out, so the session is what is
 * in the way. Instagram does the same thing in another shape: given a
 * `sessionid`, yt-dlp's extractor gets an empty body back and reports it as
 * `Failed to parse JSON`, while the same URL resolves with no cookies at all.
 * Both are fixed by the same response — give up the credential and try once more.
 *
 * The opposite failure — a site that says it *needs* a login — is deliberately
 * not retried: dropping credentials there just fails again, and the message
 * already asks for the session the site wanted.
 */
const SESSION_FAILURES = new Set<MediaErrorKind>(['session', 'empty-response'])

/**
 * How long a probe's answer may be reused for the same link and credentials.
 *
 * The quality menu and the download it leads to ask the same question about the
 * same page a second apart, and a probe is several seconds of network work. Two
 * minutes covers a menu the user is actually reading, and is short enough that a
 * short-lived media URL or an extractor's format list cannot go stale underneath
 * it.
 */
const PROBE_REUSE_MS = 120_000

/** How many probe answers may be remembered at once; the newest are kept. */
const PROBE_CACHE_LIMIT = 8

/** A probe's answer, kept so the download it was made for need not repeat it. */
interface CachedProbe {
  url: string
  /** When the probe finished, for the expiry check. */
  at: number
  probe: MediaProbe
  /** The credentials that made this probe work, so a reuse resolves the same way. */
  verdict: CredentialVerdict
}

/**
 * What a probe proved about the credentials it was given.
 *
 * Remembered by URL rather than by job because a probe is always followed
 * directly by the download it was made for, and keying on the URL keeps a stale
 * verdict from ever being applied to a different link.
 */
interface CredentialVerdict {
  url: string
  /** The session the caller handed over is what failed, so do not send it. */
  skipSession: boolean
  /** The on-disk browser store is what failed, so do not read it again. */
  skipStore: boolean
}

interface MediaJob {
  gid: string
  url: string
  formatId: string
  formatLabel: string
  dir: string
  audioOnly: boolean
  playlist: boolean
  /** 1-based playlist positions to download; empty means "the site's default". */
  playlistItems: number[]
  /** Subtitle languages to write, and whether to mux them in. Null when none. */
  subtitles: { codes: string[]; embed: boolean } | null
  /** Container to convert the audio to; 'native' keeps the site's own. */
  audioFormat: AudioFormat
  title: string
  status: DownloadItem['status']
  downloadedBytes: number
  totalBytes: number
  speed: number
  eta: number
  addedAt: number
  completedAt: number | null
  errorCode: number
  errorMessage: string
  postActionState: DownloadItem['postActionState']
  notified: boolean
  outputPaths: string[]
  runner: YtDlpRunner | null
  /**
   * Bytes per stream of this run, keyed by yt-dlp's filename.
   *
   * Cleared on every launch: a fresh process reports fresh counters, so the
   * previous attempt's numbers would otherwise be added to the new one's.
   */
  streams: Map<string, StreamProgress>
  /** Browser context, kept so a resume sends the same cookies as the first try. */
  http: HttpContext
  /** `--cookies-from-browser` arguments this job runs with, resolved once. */
  cookieArgs: string[]
  /**
   * True when this job runs without browser credentials, because a probe already
   * proved them unusable or a launch had to give up on them.
   */
  cookiesRetried: boolean
}

export interface MediaJobsOptions {
  history: HistoryStore
  getBinaryPath(): string
  getFfmpegPath(): string
  /**
   * `--cookies-from-browser` arguments for the current setting.
   *
   * Read per run rather than captured at construction so changing the setting
   * takes effect on the next download instead of the next app start.
   */
  getCookieArgs?: () => string[]
  /** Installed yt-dlp version, shown when its extractor needs updating. */
  getYtdlpVersion?: () => string
  /**
   * How many HLS/DASH fragments to fetch in parallel.
   *
   * Read per run like the cookie setting, so changing it applies to the next
   * download instead of the next app start.
   */
  getConcurrentFragments?: () => number
  log(line: string): void
}

export class MediaJobs extends EventEmitter {
  private readonly jobs = new Map<string, MediaJob>()
  private readonly options: MediaJobsOptions

  /**
   * The credentials the last probe gave up on, if any.
   *
   * Every download is probed immediately before it starts, so this is refreshed
   * per download: the launch can skip what the probe already proved unusable
   * rather than paying for the same failure a second time.
   */
  private verdict: CredentialVerdict = { url: '', skipSession: false, skipStore: false }

  /**
   * Probe answers, keyed by link *and* credentials.
   *
   * The credentials are part of the key because the answer depends on them: the
   * same Instagram reel resolves signed out and fails with a stale `sessionid`,
   * so a cache keyed on the URL alone would hand one attempt's failure to the
   * next. The key is a digest rather than the header itself, so a live session
   * never sits in a map key where a crash dump could print it.
   */
  private readonly probeCache = new Map<string, CachedProbe>()

  /** Pending paced `change`, and when the last one was let through. */
  private progressTimer: NodeJS.Timeout | null = null
  private lastProgressAt = 0

  constructor(options: MediaJobsOptions) {
    super()
    this.options = options
  }

  private get history(): HistoryStore {
    return this.options.history
  }

  get hasFfmpeg(): boolean {
    return this.options.getFfmpegPath().length > 0
  }

  get binaryAvailable(): boolean {
    return this.options.getBinaryPath().length > 0
  }

  /**
   * Cookies for one run, once the last probe's verdict has been applied.
   *
   * A Cookie header from the extension is that page's live session, so when the
   * caller supplies one the on-disk browser store is deliberately not read: two
   * cookie sources for the same request would send conflicting sessions. That is
   * also why a store failure and a session failure are never retried together —
   * whichever one was in use is the one that gets dropped.
   */
  private resolveCredentials(
    url: string,
    context: HttpContext
  ): { http: HttpContext; cookieArgs: string[] } {
    const skip = this.verdict.url === url ? this.verdict : { skipSession: false, skipStore: false }
    const cookieArgs =
      context.cookieHeader || skip.skipStore ? [] : this.options.getCookieArgs?.() ?? []
    const http = skip.skipSession ? { ...context, cookieHeader: '' } : context
    return { http, cookieArgs }
  }

  /**
   * Turn a raw toolchain failure into a sentence for the user.
   *
   * The version is passed in because "update yt-dlp" is only actionable when the
   * user can see how old theirs is.
   */
  private describe(message: string): string {
    return classifyMediaError(message, { ytdlpVersion: this.options.getYtdlpVersion?.() ?? '' }).message
  }

  /**
   * Ask yt-dlp what a link contains.
   *
   * A failure that names the credentials is retried once without them, because
   * most videos need no session at all: an unreadable cookie store, or a session
   * the site refuses, must not make every download in the app impossible. The
   * retried attempt's message is the one reported when that fails too, since it
   * is what remains once the credentials are out of the picture.
   *
   * `options.reuse` is what lets a caller say "ask again" — the quality menu's
   * refresh button means exactly that, and a menu that hands back a remembered
   * answer to a button labelled *probe again* would be lying about what it did.
   */
  async probe(url: string, context: HttpContext = {}, options: { reuse?: boolean } = {}): Promise<MediaProbe> {
    const binary = this.options.getBinaryPath()
    if (!binary) throw new Error('尚未安裝 yt-dlp，請在設定中下載。')

    const key = this.probeKey(url, context)
    if (options.reuse !== false) {
      const cached = this.recallProbe(key, url)
      if (cached) return cached
    }

    this.verdict = { url, skipSession: false, skipStore: false }
    const { http, cookieArgs } = this.resolveCredentials(url, context)
    const supplied = Boolean(context.cookieHeader) || cookieArgs.length > 0

    try {
      const probe = await this.probeOnce(binary, url, http, cookieArgs)
      this.rememberProbe(key, { url, at: Date.now(), probe, verdict: { ...this.verdict, url } })
      return probe
    } catch (error) {
      const message = (error as Error).message
      const kind = classifyMediaError(message).kind
      this.options.log(`yt-dlp probe failed: ${message}`)
      if (!supplied || (!STORE_FAILURES.has(kind) && !SESSION_FAILURES.has(kind))) {
        this.forgetProbe(url)
        throw new Error(this.describe(message))
      }

      /*
       * Which credential to blame follows from what was in use, not from the
       * failure's name: a store failure can only have come from the store, but
       * "the site refused this session" is just as possible from a logged-in
       * cookie store as from a header. Exactly one of the two is ever sent, so
       * the absent header means the store was the one at fault.
       */
      const skipStore = STORE_FAILURES.has(kind) || !http.cookieHeader
      const dropped = skipStore ? 'cookies' : 'session'
      this.options.log(`yt-dlp probe failed with ${kind}; retrying without ${dropped}`)
      this.verdict = { url, skipSession: !skipStore, skipStore }

      try {
        const probe = await this.probeOnce(binary, url, this.resolveCredentials(url, context).http, [])
        this.rememberProbe(key, { url, at: Date.now(), probe, verdict: { ...this.verdict, url } })
        return probe
      } catch (retryError) {
        const retryMessage = (retryError as Error).message
        this.options.log(`yt-dlp probe failed again without credentials: ${retryMessage}`)
        this.forgetProbe(url)
        throw new Error(this.describe(retryMessage))
      }
    }
  }

  /**
   * The cache key for a probe: the link plus everything that changes its answer.
   *
   * The store arguments are left out when a Cookie header is supplied, since a
   * header means the store is never read — otherwise changing the browser-cookie
   * setting would miss a cache entry that is still perfectly valid.
   */
  private probeKey(url: string, context: HttpContext): string {
    const storeArgs = context.cookieHeader ? [] : this.options.getCookieArgs?.() ?? []
    return createHash('sha256')
      .update(url)
      .update('\0')
      .update(context.cookieHeader ?? '')
      .update('\0')
      .update(storeArgs.join('\0'))
      .digest('hex')
  }

  /** A still-valid remembered answer for this link and credentials, if any. */
  private recallProbe(key: string, url: string): MediaProbe | null {
    const cached = this.probeCache.get(key)
    if (!cached) return null
    if (Date.now() - cached.at > PROBE_REUSE_MS) {
      this.probeCache.delete(key)
      return null
    }
    // The credentials that produced this answer are the ones the download that
    // follows must send, so the verdict is restored with it.
    this.verdict = { ...cached.verdict, url }
    this.options.log(`media probe reused for ${url}`)
    return cached.probe
  }

  /** Keep a probe's answer, newest kept, bounded to PROBE_CACHE_LIMIT entries. */
  private rememberProbe(key: string, entry: CachedProbe): void {
    // Re-inserting moves the entry to the end, which is what makes the trim
    // below "oldest" rather than "first ever seen".
    this.probeCache.delete(key)
    this.probeCache.set(key, entry)
    while (this.probeCache.size > PROBE_CACHE_LIMIT) {
      const oldest = this.probeCache.keys().next()
      if (oldest.done) break
      this.probeCache.delete(oldest.value)
    }
  }

  /**
   * Drop every remembered probe for a link.
   *
   * Called when a download fails: the answer was good enough to build a menu
   * from but not good enough to download, so the next attempt must not be handed
   * it back. The "probe again" button asks for a fresh run by itself, so it does
   * not depend on this — but a plain retry does.
   */
  forgetProbe(url: string): void {
    for (const [key, entry] of this.probeCache) {
      if (entry.url === url) this.probeCache.delete(key)
    }
  }

  private probeOnce(
    binary: string,
    url: string,
    context: HttpContext,
    cookieArgs: string[]
  ): Promise<MediaProbe> {
    return probeFormats(binary, url, { hasFfmpeg: this.hasFfmpeg, ...context, cookieArgs })
  }

  findFormat(probe: MediaProbe, formatId: string): MediaFormatInfo | undefined {
    return probe.formats.find((format) => format.formatId === formatId)
  }

  /**
   * List a playlist's items without resolving them.
   *
   * Deliberately not cached: the picker is opened on demand, and a stale list
   * would be worse than the couple of seconds this costs — a re-upload or a
   * deletion between two openings would otherwise offer positions that no longer
   * exist.
   */
  async probePlaylist(url: string, context: HttpContext = {}): Promise<MediaPlaylistInfo> {
    const binary = this.options.getBinaryPath()
    if (!binary) throw new Error('尚未安裝 yt-dlp，請在設定中下載。')
    const { http, cookieArgs } = this.resolveCredentials(url, context)
    return probePlaylist(binary, url, { ...http, cookieArgs })
  }

  async add(input: AddMediaInput, probe: MediaProbe, http: HttpContext = {}): Promise<{ gid: string }> {
    const binary = this.options.getBinaryPath()
    if (!binary) throw new Error('尚未安裝 yt-dlp，請在設定中下載。')

    const format = this.findFormat(probe, input.formatId)
    if (format?.needsFfmpeg && !this.hasFfmpeg) {
      // The user asked for a specific quality that cannot be produced here, so
      // this stays an error — but one the dialog can answer with an install
      // button (see the ffmpeg rule in shared/media-errors).
      throw new Error('這個格式需要合併音訊與視訊，請先安裝 ffmpeg 媒體包，或改選單檔畫質。')
    }

    /*
     * Subtitles and audio conversion both run through ffmpeg. Caught here rather
     * than letting yt-dlp fail mid-download, so the dialog can offer the install
     * button before anything is queued — and so the two failures name their own
     * cause instead of yt-dlp's muxer message.
     */
    const subtitles =
      input.subtitles && input.subtitles.codes.length > 0
        ? { codes: [...input.subtitles.codes], embed: Boolean(input.subtitles.embed) }
        : null
    const audioFormat: AudioFormat = input.audioFormat ?? 'native'

    if (subtitles?.embed && !this.hasFfmpeg) {
      throw new Error('嵌入字幕需要 ffmpeg，請先安裝 ffmpeg 媒體包，或改為另存字幕檔。')
    }
    if (audioFormat !== 'native' && !this.hasFfmpeg) {
      throw new Error('轉換音訊格式需要 ffmpeg，請先安裝 ffmpeg 媒體包，或改選「原始音訊」。')
    }

    /*
     * A video-only stream carries no soundtrack, and the quality menu is built
     * from exactly those: its "1080p · webm" row is a picture, not a whole video.
     * `-f 312` therefore produced a file that played silently — "the video has no
     * sound" — even though the menu looked like it was offering a quality of the
     * video. Asking for `<id>+bestaudio` merges the site's audio into the stream
     * the user picked, within the same run, which is what the synthetic "best"
     * entry has always done.
     *
     * Only a bare id is rewritten: a composed selector (`312+bestaudio`) is
     * already a complete request, and asking for a stream that is already muxed
     * needs nothing added.
     */
    const formatId =
      format?.needsFfmpeg && this.hasFfmpeg && !input.formatId.includes('+')
        ? `${input.formatId}+bestaudio`
        : input.formatId

    // Credentials are resolved here, once, from the probe that was just made for
    // this link: the download must not repeat a credential the probe already
    // proved unusable, and a resume must send what the first attempt sent.
    const credentials = this.resolveCredentials(input.url, http)

    const gid = `${MEDIA_GID_PREFIX}${randomUUID()}`
    const job: MediaJob = {
      gid,
      url: input.url,
      formatId,
      formatLabel: format?.label ?? input.formatId,
      dir: input.dir,
      audioOnly: input.audioOnly,
      // A chosen subset implies a playlist: `--yes-playlist` has to be on for
      // `--playlist-items` to mean anything.
      playlist: input.playlist || Boolean(input.playlistItems && input.playlistItems.length > 0),
      playlistItems: input.playlistItems ? [...input.playlistItems] : [],
      subtitles,
      audioFormat,
      title: probe.title,
      status: 'active',
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      eta: 0,
      addedAt: Date.now(),
      completedAt: null,
      errorCode: 0,
      errorMessage: '',
      postActionState: 'idle',
      notified: false,
      outputPaths: [],
      runner: null,
      streams: new Map(),
      http: credentials.http,
      cookieArgs: credentials.cookieArgs,
      cookiesRetried: false
    }

    this.jobs.set(gid, job)

    const record: HistoryRecord = {
      gid,
      name: job.title,
      dir: input.dir,
      category: input.audioOnly ? 'audio' : 'video',
      tags: ['yt-dlp'],
      kind: 'media',
      engine: 'ytdlp',
      uris: [input.url],
      totalLength: 0,
      addedAt: job.addedAt,
      completedAt: null,
      source: 'manual',
      status: 'active',
      mediaFormat: job.formatLabel,
      errorCode: 0,
      errorMessage: '',
      postActionState: 'idle',
      notified: false,
      maxDownloadLimit: 0,
      split: 1,
      maxConnectionPerServer: 1,
      minSplitSize: 0,
      referer: '',
      userAgent: '',
      cookieHeader: '',
      headers: [],
      username: '',
      password: '',
      proxy: '',
      pausedQueued: false
    }
    this.history.upsert(record)
    await this.history.flush()

    this.launch(job)
    return { gid }
  }

  private launch(job: MediaJob): void {
    const binary = this.options.getBinaryPath()
    const ffmpegPath = this.options.getFfmpegPath()
    const ffmpegDir = ffmpegPath ? path.dirname(ffmpegPath) : ''

    // A new process reports its own counters from the start, so the previous
    // attempt's are dropped rather than added to.
    job.streams.clear()
    this.cancelProgressNotify()

    const runner = new YtDlpRunner({
      binaryPath: binary,
      url: job.url,
      formatId: job.formatId,
      dir: job.dir,
      ffmpegDir,
      audioOnly: job.audioOnly,
      playlist: job.playlist,
      concurrentFragments: this.options.getConcurrentFragments?.() ?? 1,
      ...(job.playlistItems.length > 0 ? { playlistItems: job.playlistItems } : {}),
      ...(job.subtitles ? { subtitles: job.subtitles } : {}),
      ...(job.audioFormat !== 'native' ? { audioFormat: job.audioFormat } : {}),
      overwrite: job.status === 'error',
      ...job.http,
      ...(job.cookiesRetried ? { cookieHeader: '', cookieArgs: [] } : { cookieArgs: job.cookieArgs })
    })

    runner.on('progress', (progress) => {
      const totals = mergeStreamProgress(job.streams, progress)
      job.downloadedBytes = totals.downloadedBytes
      job.totalBytes = totals.totalBytes
      job.speed = progress.speed
      job.eta = progress.eta
      if (job.totalBytes > 0) {
        this.history.patchDeferred(job.gid, { totalLength: job.totalBytes })
      }
      this.notifyProgress()
    })

    runner.on('file', (filePath) => {
      job.outputPaths.push(filePath)
    })

    runner.on('log', (line) => this.options.log(line))

    runner.on('done', () => {
      job.status = 'complete'
      job.completedAt = Date.now()
      job.speed = 0
      job.runner = null
      this.cancelProgressNotify()
      void this.finish(job)
    })

    runner.on('failed', (message) => {
      job.runner = null
      this.cancelProgressNotify()
      const kind = classifyMediaError(message).kind

      /*
       * A download that failed on its credentials gets one more attempt without
       * them. By now the format is chosen and the file is part-written, so the
       * retry costs a process launch rather than another round of questions —
       * and the alternative is a job that cannot be started at all while a
       * browser cookie store stays unreadable or a stale session stays in the
       * way. The message below is only reached once both attempts have failed.
       */
      const hadCredentials = job.cookieArgs.length > 0 || Boolean(job.http.cookieHeader)
      const blamed = STORE_FAILURES.has(kind) || SESSION_FAILURES.has(kind)
      if (!job.cookiesRetried && hadCredentials && blamed) {
        job.cookiesRetried = true
        job.speed = 0
        this.options.log(`yt-dlp job ${job.gid} failed with ${kind}; relaunching without browser cookies`)
        this.launch(job)
        this.emit('change')
        return
      }

      job.status = 'error'
      job.speed = 0
      job.errorCode = 1
      // The remembered probe did not survive contact with the download, so the
      // next attempt at this link has to ask yt-dlp again.
      this.forgetProbe(job.url)
      // yt-dlp writes for its own maintainers; the row, the toast and the detail
      // view all show this text, so it is translated once, here.
      job.errorMessage = this.describe(message)
      const stored = job.errorMessage
      this.history.patchDeferred(job.gid, { status: 'error', errorCode: 1, errorMessage: stored })
      this.emit('failed', this.toItem(job))
      this.emit('change')
    })

    job.runner = runner
    job.status = 'active'
    runner.start()
  }

  /**
   * Ask the UI to redraw, at most once every PROGRESS_NOTIFY_MS.
   *
   * A trailing update is always scheduled, so the last bytes of a download are
   * never the ones that got dropped.
   */
  private notifyProgress(): void {
    const wait = this.lastProgressAt + PROGRESS_NOTIFY_MS - Date.now()
    if (wait <= 0) {
      this.lastProgressAt = Date.now()
      this.emit('change')
      return
    }
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      this.lastProgressAt = Date.now()
      this.emit('change')
    }, wait)
    this.progressTimer.unref?.()
  }

  /** Drop a paced update that has not fired yet, ahead of a terminal one. */
  private cancelProgressNotify(): void {
    if (!this.progressTimer) return
    clearTimeout(this.progressTimer)
    this.progressTimer = null
  }

  /**
   * Settle a job whose process finished cleanly.
   *
   * The finished file's own size is read rather than keeping the sum of the
   * streams it was built from: a merge wraps a container around both halves, and
   * a download that produced no progress output at all would otherwise be
   * recorded as zero bytes — the row read "Completed · 0 B" beside a full bar,
   * which is what the missing progress looked like from the outside.
   */
  private async finish(job: MediaJob): Promise<void> {
    if (job.outputPaths.length === 1) {
      try {
        const stats = await fsp.stat(job.outputPaths[0]!)
        job.totalBytes = stats.size
        job.downloadedBytes = stats.size
      } catch (error) {
        this.options.log(`could not read the finished file's size: ${(error as Error).message}`)
      }
    }

    this.history.patchDeferred(job.gid, {
      status: 'complete',
      completedAt: job.completedAt,
      totalLength: job.totalBytes
    })
    this.emit('completed', this.toItem(job))
    this.emit('change')
  }

  /**
   * Terminate the process. yt-dlp has no pause of its own, so this is what
   * "pause" means here; the `.part` file on disk is what makes resume cheap.
   */
  async pause(gid: string): Promise<void> {
    const job = this.jobs.get(gid)
    if (!job || job.status !== 'active') return
    job.runner?.kill()
    job.runner = null
    job.status = 'paused'
    job.speed = 0
    this.cancelProgressNotify()
    this.history.patchDeferred(gid, { status: 'paused' })
    this.options.log(`yt-dlp job ${gid} paused; resume will continue from the .part file`)
    this.emit('change')
  }

  /** Resume a paused job, or restart one that failed. */
  async resume(gid: string): Promise<void> {
    const job = this.jobs.get(gid)
    if (!job) return
    if (job.status !== 'paused' && job.status !== 'error') return
    job.errorCode = 0
    job.errorMessage = ''
    this.history.patchDeferred(gid, { status: 'active', errorCode: 0, errorMessage: '' })
    this.launch(job)
    this.emit('change')
  }

  retry(gid: string): Promise<void> {
    return this.resume(gid)
  }

  async remove(gid: string, deleteFiles: boolean): Promise<void> {
    const job = this.jobs.get(gid)
    if (!job) return

    job.runner?.kill()
    this.cancelProgressNotify()

    if (deleteFiles) {
      for (const target of job.outputPaths) {
        // yt-dlp writes a .part file while in flight; both it and the finished
        // file are ours to delete when the user asked for the files to go.
        for (const candidate of [target, `${target}.part`]) {
          try {
            await fsp.rm(candidate, { force: true })
          } catch (error) {
            this.options.log(`failed to delete ${candidate}: ${(error as Error).message}`)
          }
        }
      }
    }

    this.jobs.delete(gid)
    this.history.remove([gid])
    this.emit('change')
  }

  items(): DownloadItem[] {
    return [...this.jobs.values()].map((job) => this.toItem(job))
  }

  get(gid: string): DownloadItem | undefined {
    const job = this.jobs.get(gid)
    return job ? this.toItem(job) : undefined
  }

  markPostAction(gid: string, state: DownloadItem['postActionState']): void {
    const job = this.jobs.get(gid)
    if (job) job.postActionState = state
  }

  markNotified(gid: string): void {
    const job = this.jobs.get(gid)
    if (job) job.notified = true
  }

  killAll(): void {
    for (const job of this.jobs.values()) job.runner?.kill()
  }

  private toItem(job: MediaJob): DownloadItem {
    const name =
      job.outputPaths.length > 0
        ? path.basename(job.outputPaths[0]!)
        : `${job.title}${job.playlist ? '（播放清單）' : ''}`

    return {
      gid: job.gid,
      engine: 'ytdlp',
      kind: 'media',
      status: job.status,
      name,
      dir: job.dir,
      files: job.outputPaths.map((filePath, index) => ({
        index,
        path: filePath,
        name: path.basename(filePath),
        length: 0,
        completedLength: 0,
        selected: true,
        uris: []
      })),
      numFiles: job.outputPaths.length,
      totalLength: job.totalBytes,
      completedLength: job.downloadedBytes,
      downloadSpeed: job.speed,
      uploadSpeed: 0,
      // A single HTTP fetch against the CDN, so there is no connection fan-out to
      // report. Showing 1 is honest rather than inventing a number.
      connections: job.status === 'active' ? 1 : 0,
      numSeeders: 0,
      seeder: false,
      pieceLength: 0,
      numPieces: 0,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      verifiedLength: 0,
      verifyIntegrityPending: false,
      infoHash: null,
      bittorrent: null,
      category: job.audioOnly ? 'audio' : 'video',
      tags: ['yt-dlp'],
      addedAt: job.addedAt,
      completedAt: job.completedAt,
      source: 'manual',
      queuePosition: -1,
      maxDownloadLimit: 0,
      split: 1,
      maxConnectionPerServer: 1,
      referer: '',
      userAgent: '',
      postActionState: job.postActionState,
      postActionError: '',
      notified: job.notified,
      mediaFormat: job.formatLabel,
      metadataPending: job.status === 'active' && job.totalBytes === 0
    }
  }
}

/** Merge media items into the aria2-sourced list. */
export function mergeMediaItems(base: DownloadItem[], media: DownloadItem[]): DownloadItem[] {
  if (media.length === 0) return base
  return [...base, ...media]
}

export function guessAudioFromExtension(fileName: string): boolean {
  const extension = extensionOf(fileName)
  return ['mp3', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aac'].includes(extension)
}
