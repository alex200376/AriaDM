import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { UpdateInfo, UpdateProgress } from '@shared/ipc'

import { checkForUpdate } from './update-checker'

/**
 * In-app update: download the installer, then run it silently.
 *
 * The old updater only ever opened a browser tab, which on a 197 MB installer is
 * a poor experience: the user leaves the app, watches a browser download, runs
 * an installer, and comes back. This does the whole thing in place.
 *
 * Two details make the silent install work:
 *
 *  - The installer is the electron-builder NSIS build, which understands `/S`
 *    (silent), `--updated` (an in-place update: wait for the app to exit rather
 *    than prompt that it is running) and `--force-run` (launch the app again
 *    when finished). Without `--updated` the installer would show the "AriaDM is
 *    running, close it?" box this feature exists to avoid.
 *  - It is launched from the *shutdown* path, after the app has flushed its
 *    state, so the installer finds nothing left to kill.
 *
 * The download is verified before it is allowed to run: the byte count must
 * match what the release advertised (a truncated installer is worse than no
 * update) and the file must actually start with an `MZ` header.
 */

/** The minimum of `fetch`'s response this module needs, so tests can stub it. */
export type UpdateDownloadFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}>

export type UpdateSpawn = (file: string, args: string[]) => { unref(): void }

export interface UpdateManagerDeps {
  currentVersion(): string
  /** Directory the installer is downloaded into; created on demand. */
  installerDir(): string
  /** True when this build can install an update itself (packaged, not portable). */
  canInstall(): boolean
  onProgress(progress: UpdateProgress): void
  /** Gracefully shut the app down; the installer is launched during that. */
  requestQuit(): void
  log(line: string): void
  /** Injectable for tests. */
  fetchImpl?: UpdateDownloadFetch
  spawnImpl?: UpdateSpawn
  checkImpl?: (current: string) => Promise<UpdateInfo>
}

const IDLE: UpdateProgress = { phase: 'idle', received: 0, total: 0, percent: -1, error: '' }

/** Progress is emitted at most this often; a phase change always goes through. */
const PROGRESS_INTERVAL_MS = 120

function isAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError'
}

export class UpdateManager {
  private info: UpdateInfo | null = null
  private state: UpdateProgress = IDLE
  private installer: string | null = null
  private controller: AbortController | null = null
  private lastEmit = 0
  private readonly deps: UpdateManagerDeps
  private readonly fetchImpl: UpdateDownloadFetch
  private readonly spawnImpl: UpdateSpawn
  private readonly checkImpl: (current: string) => Promise<UpdateInfo>

  constructor(deps: UpdateManagerDeps) {
    this.deps = deps
    this.checkImpl = deps.checkImpl ?? checkForUpdate
    this.fetchImpl =
      deps.fetchImpl ??
      ((url, init) => fetch(url, init) as unknown as ReturnType<UpdateDownloadFetch>)
    this.spawnImpl =
      deps.spawnImpl ??
      ((file, args) => nodeSpawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }))
  }

  /** Latest progress, for a UI that reloads while a download is running. */
  get progress(): UpdateProgress {
    return this.state
  }

  /** The downloaded installer waiting to be launched, if any. */
  get pendingInstaller(): string | null {
    return this.installer
  }

  async check(): Promise<UpdateInfo> {
    const info = await this.checkImpl(this.deps.currentVersion())
    this.info = { ...info, canInstall: this.deps.canInstall() && Boolean(info.downloadUrl) }
    return this.info
  }

  /**
   * Download the newest installer, reporting progress as it goes.
   *
   * Resolves with the final progress once the file is on disk and verified.
   * Throws on failure, with the error also left in `progress.error` so a UI that
   * only watches events still sees it.
   */
  async download(): Promise<UpdateProgress> {
    const info = this.info
    if (!info?.downloadUrl) throw new Error('沒有可下載的更新檔。')
    // A second call while one is running is a no-op, not a second download.
    if (this.controller) return this.state

    const controller = new AbortController()
    this.controller = controller
    this.installer = null

    const dir = this.deps.installerDir()
    await fsp.mkdir(dir, { recursive: true })

    const remoteName = (() => {
      try {
        return decodeURIComponent(new URL(info.downloadUrl).pathname.split('/').pop() ?? '')
      } catch {
        return ''
      }
    })()
    const name = remoteName || `AriaDM-${info.latest ?? 'update'}-setup.exe`
    const target = path.join(dir, name)
    const partial = `${target}.part`

    try {
      this.emit(
        {
          phase: 'downloading',
          received: 0,
          total: info.downloadSize,
          percent: info.downloadSize > 0 ? 0 : -1,
          error: ''
        },
        true
      )

      const response = await this.fetchImpl(info.downloadUrl, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      const headerLength = Number(response.headers.get('content-length'))
      const total = headerLength > 0 ? headerLength : info.downloadSize

      await fsp.rm(partial, { force: true })
      const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      let received = 0
      source.on('data', (chunk: Buffer) => {
        received += chunk.length
        this.emit({
          phase: 'downloading',
          received,
          total,
          percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : -1,
          error: ''
        })
      })

      await pipeline(source, fs.createWriteStream(partial))

      // A short read means the connection dropped mid-file. Installing a partial
      // installer is worse than asking the user to try again.
      if (total > 0 && received !== total) {
        throw new Error(`更新檔不完整（${received}/${total} bytes）`)
      }

      await fsp.rm(target, { force: true })
      await fsp.rename(partial, target)
      await this.assertExecutable(target)

      this.installer = target
      this.emit({ phase: 'ready', received, total, percent: 100, error: '' }, true)
      this.deps.log(`update downloaded: ${target}`)
      return this.state
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => {})
      // A file that failed verification must not linger as a runnable leftover.
      await fsp.rm(target, { force: true }).catch(() => {})
      const message = controller.signal.aborted || isAbort(error) ? '已取消下載' : (error as Error).message
      this.emit({ phase: 'error', received: 0, total: 0, percent: -1, error: message }, true)
      throw new Error(message)
    } finally {
      this.controller = null
    }
  }

  /** Abort an in-flight download. Harmless when nothing is running. */
  cancel(): void {
    this.controller?.abort()
    this.controller = null
  }

  /**
   * Ask for the app to shut down with an installer queued.
   *
   * The actual launch happens in `launchInstaller`, called from the shutdown
   * path once the app is done writing its state.
   */
  install(): void {
    if (!this.installer) throw new Error('更新尚未下載完成。')
    if (!this.deps.canInstall()) throw new Error('此版本不支援自動安裝，請手動下載。')
    this.emit(
      { phase: 'installing', received: this.state.received, total: this.state.total, percent: 100, error: '' },
      true
    )
    this.deps.requestQuit()
  }

  /** Start the installer detached. No-op when none is waiting. */
  launchInstaller(): void {
    const file = this.installer
    if (!file) return
    this.installer = null

    // Only the Windows build ships an NSIS installer.
    if (process.platform !== 'win32') return

    try {
      this.spawnImpl(file, ['/S', '--updated', '--force-run'])
      this.deps.log(`update installer launched: ${file}`)
    } catch (error) {
      this.deps.log(`update installer failed: ${(error as Error).message}`)
    }
  }

  /** An installer that is not a Windows executable never gets to run. */
  private async assertExecutable(file: string): Promise<void> {
    const handle = await fsp.open(file, 'r')
    try {
      const header = Buffer.alloc(2)
      await handle.read(header, 0, 2, 0)
      if (header.toString('latin1') !== 'MZ') throw new Error('下載的更新檔不是可執行檔')
    } finally {
      await handle.close()
    }
  }

  private emit(next: UpdateProgress, force = false): void {
    this.state = next
    const now = Date.now()
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return
    this.lastEmit = now
    this.deps.onProgress(next)
  }
}
