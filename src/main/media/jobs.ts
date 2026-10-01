import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { DownloadItem } from '@shared/download'
import { classifyMediaError } from '@shared/media-errors'
import { defaultFormatId } from '@shared/media-formats'
import type { AddMediaInput, MediaFormatInfo } from '@shared/settings'
import { extensionOf } from '@shared/uri'

import type { HistoryRecord, HistoryStore } from '../downloads/history-store'

import { probeFormats, YtDlpRunner, type HttpContext, type MediaProbe } from './ytdlp'

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

interface MediaJob {
  gid: string
  url: string
  formatId: string
  formatLabel: string
  dir: string
  audioOnly: boolean
  playlist: boolean
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
  /** Browser context, kept so a resume sends the same cookies as the first try. */
  http: HttpContext
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
  log(line: string): void
}

export class MediaJobs extends EventEmitter {
  private readonly jobs = new Map<string, MediaJob>()
  private readonly options: MediaJobsOptions

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
   * Cookies for one run.
   *
   * A Cookie header from the extension is that page's live session, so when the
   * caller supplies one the on-disk browser store is deliberately not read: two
   * cookie sources for the same request would send conflicting sessions.
   */
  private credentialsFor(context: HttpContext): string[] {
    if (context.cookieHeader) return []
    return this.options.getCookieArgs?.() ?? []
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

  async probe(url: string, context: HttpContext = {}): Promise<MediaProbe> {
    const binary = this.options.getBinaryPath()
    if (!binary) throw new Error('尚未安裝 yt-dlp，請在設定中下載。')
    try {
      return await probeFormats(binary, url, {
        hasFfmpeg: this.hasFfmpeg,
        ...context,
        cookieArgs: this.credentialsFor(context)
      })
    } catch (error) {
      const described = this.describe((error as Error).message)
      this.options.log(`yt-dlp probe failed: ${(error as Error).message}`)
      throw new Error(described)
    }
  }

  /**
   * Add a media URL without asking which format to use.
   *
   * This is the path an auto-detected link takes: the user pasted "this video",
   * not a quality preference, so the best available stream is the right answer.
   */
  async addFromUrl(
    url: string,
    options: { dir: string; playlist: boolean } & HttpContext
  ): Promise<{ gid: string }> {
    const probe = await this.probe(url, options)
    return this.add(
      {
        url,
        // Not `formats[0]`: on a machine without ffmpeg the best entry cannot be
        // produced at all, and this path is the extension's "download this
        // video" — it has to just work.
        formatId: defaultFormatId(probe.formats, this.hasFfmpeg),
        dir: options.dir,
        audioOnly: false,
        playlist: options.playlist,
        maxConcurrent: 0
      },
      probe,
      options
    )
  }

  findFormat(probe: MediaProbe, formatId: string): MediaFormatInfo | undefined {
    return probe.formats.find((format) => format.formatId === formatId)
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

    const gid = `${MEDIA_GID_PREFIX}${randomUUID()}`
    const job: MediaJob = {
      gid,
      url: input.url,
      formatId: input.formatId,
      formatLabel: format?.label ?? input.formatId,
      dir: input.dir,
      audioOnly: input.audioOnly,
      playlist: input.playlist,
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
      http
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

    const runner = new YtDlpRunner({
      binaryPath: binary,
      url: job.url,
      formatId: job.formatId,
      dir: job.dir,
      ffmpegDir,
      audioOnly: job.audioOnly,
      playlist: job.playlist,
      overwrite: job.status === 'error',
      ...job.http
    })

    runner.on('progress', (progress) => {
      job.downloadedBytes = progress.downloadedBytes
      job.totalBytes = progress.totalBytes
      job.speed = progress.speed
      job.eta = progress.eta
      if (progress.totalBytes > 0) {
        this.history.patchDeferred(job.gid, { totalLength: progress.totalBytes })
      }
      this.emit('change')
    })

    runner.on('file', (filePath) => {
      job.outputPaths.push(filePath)
    })

    runner.on('log', (line) => this.options.log(line))

    runner.on('done', () => {
      job.status = 'complete'
      job.completedAt = Date.now()
      job.speed = 0
      if (job.totalBytes > 0) job.downloadedBytes = job.totalBytes
      job.runner = null
      this.history.patchDeferred(job.gid, {
        status: 'complete',
        completedAt: job.completedAt,
        totalLength: job.totalBytes
      })
      this.emit('completed', this.toItem(job))
      this.emit('change')
    })

    runner.on('failed', (message) => {
      job.status = 'error'
      job.speed = 0
      job.errorCode = 1
      // yt-dlp writes for its own maintainers; the row, the toast and the detail
      // view all show this text, so it is translated once, here.
      job.errorMessage = this.describe(message)
      job.runner = null
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
