import { spawn as nodeSpawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { UpdateCheckResult, UpdateDiagnostics, UpdateInfo, UpdateProgress } from '@shared/ipc'

import type { InstallInfo } from './install-kind'
import { checkForUpdate } from './update-checker'

/**
 * In-app update: download the installer, then run it silently.
 *
 * The old updater only ever opened a browser tab, which on a 197 MB installer is
 * a poor experience: the user leaves the app, watches a browser download, runs
 * an installer, and comes back. This does the whole thing in place.
 *
 * Three details make the silent install work:
 *
 *  - The installer is the electron-builder NSIS build, which understands `/S`
 *    (silent), `--updated` (an in-place update: wait for the app to exit rather
 *    than prompt that it is running) and `--force-run` (launch the app again
 *    when finished). Without `--updated` the installer would show the "AriaDM is
 *    running, close it?" box this feature exists to avoid.
 *  - It is launched *before* the app begins to shut down. Launching it from the
 *    end of the shutdown meant any slow or stuck teardown step — a keep-alive
 *    socket holding a loopback server open, for instance — silently swallowed
 *    the update, because the installer was never started and the UI had already
 *    reset itself.
 *  - The launch is confirmed before the app quits. A per-machine install has to
 *    elevate, and a declined UAC prompt makes the installer exit instantly with
 *    no window and no message; without this check the user is left with a closed
 *    app and an update that never happened.
 *
 * The download is verified before it is allowed to run: the byte count must
 * match what the release advertised (a truncated installer is worse than no
 * update), the file must actually start with an `MZ` header, and it is left on
 * disk so a failed update can be retried without downloading it all again.
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

/**
 * The slice of `ChildProcess` this module uses.
 *
 * Narrowed to what is actually needed so a test can hand back a fake process
 * that reports "spawned, then died instantly", which is the shape of the failure
 * that used to leave the app quit with no update installed.
 */
export interface UpdateChild {
  pid?: number | undefined
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  unref(): void
}

export type UpdateSpawn = (file: string, args: string[]) => UpdateChild

export interface UpdateManagerDeps {
  currentVersion(): string
  /** Directory the installer is downloaded into; created on demand. */
  installerDir(): string
  /** True when this build can install an update itself (packaged, not portable). */
  canInstall(): boolean
  /** How this copy is installed, and whether replacing it needs administrator rights. */
  installInfo(): InstallInfo
  onProgress(progress: UpdateProgress): void
  /** Gracefully shut the app down; the installer is already running by then. */
  requestQuit(): void
  /**
   * Open the installer with its normal, visible window. The escape hatch for
   * every case where the silent path could not be confirmed.
   */
  openInstaller(file: string): void
  log(line: string): void
  /** Where the update log lives, for diagnostics. */
  logPath(): string
  /** Last `lines` lines of the update log, for diagnostics. */
  readLogTail(lines: number): string
  /** Injectables for tests. */
  fetchImpl?: UpdateDownloadFetch
  spawnImpl?: UpdateSpawn
  /** Is a process with this image name running? Used to confirm an elevated installer. */
  processRunning?: (image: string) => Promise<boolean>
  /**
   * Last gate before running a downloaded executable: is it signed the same way
   * this build is? Skipped by builds that are not signed at all, which have
   * nothing to compare against.
   */
  verifyInstaller?: (file: string) => Promise<{ ok: boolean; reason?: string }>
  /** Overridden by tests so they never wait out the real confirmation windows. */
  timings?: Partial<UpdateTimings>
  checkImpl?: (current: string) => Promise<UpdateCheckResult>
}

const IDLE: UpdateProgress = { phase: 'idle', received: 0, total: 0, percent: -1, error: '' }

/** Progress is emitted at most this often; a phase change always goes through. */
const PROGRESS_INTERVAL_MS = 120

/** Arguments that make the NSIS installer install in place, silently, then relaunch. */
const INSTALLER_ARGS = ['/S', '--updated', '--force-run']

/**
 * How long the installer must survive before we accept that it started.
 *
 * Long enough to catch an immediate failure (a bad image, a missing file, an
 * installer that refuses to run beside a running copy), short enough that the
 * user does not notice a delay before the window closes.
 */
const EARLY_EXIT_MS = 1_200

/**
 * How long to keep looking for the elevated installer.
 *
 * An elevating launcher exits at once: NSIS re-runs itself with administrator
 * rights and the original process quits, so the interesting process is a *new*
 * one with the same image name. Windows shows the UAC prompt first, and the user
 * may take a while to answer it — hence the generous window, and the fact that
 * this only applies when elevation is actually required.
 */
const ELEVATION_CONFIRM_MS = 25_000
const PROCESS_POLL_MS = 500

export interface UpdateTimings {
  earlyExitMs: number
  elevatedConfirmMs: number
  processPollMs: number
}

const DEFAULT_TIMINGS: UpdateTimings = {
  earlyExitMs: EARLY_EXIT_MS,
  elevatedConfirmMs: ELEVATION_CONFIRM_MS,
  processPollMs: PROCESS_POLL_MS
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Is a process with this image name running? Windows only; `tasklist` is built in. */
export function tasklistHas(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        // A non-zero exit or a timeout is "cannot tell", which is not evidence
        // that the installer is running.
        if (error) {
          resolve(false)
          return
        }
        resolve(stdout.toLowerCase().includes(image.toLowerCase()))
      }
    )
  })
}

/** The asset filename a release URL points at, falling back to a predictable name. */
export function installerNameFor(info: Pick<UpdateInfo, 'downloadUrl' | 'latest'>): string {
  try {
    const fromUrl = decodeURIComponent(new URL(info.downloadUrl ?? '').pathname.split('/').pop() ?? '')
    if (fromUrl) return fromUrl
  } catch {
    // Fall through to the generated name.
  }
  return `AriaDM-${info.latest ?? 'update'}-setup.exe`
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
  private readonly processRunning: (image: string) => Promise<boolean>
  private readonly timings: UpdateTimings
  private readonly checkImpl: (current: string) => Promise<UpdateCheckResult>

  constructor(deps: UpdateManagerDeps) {
    this.deps = deps
    this.checkImpl = deps.checkImpl ?? checkForUpdate
    this.processRunning = deps.processRunning ?? tasklistHas
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.fetchImpl =
      deps.fetchImpl ??
      ((url, init) => fetch(url, init) as unknown as ReturnType<UpdateDownloadFetch>)
    this.spawnImpl =
      deps.spawnImpl ??
      ((file, args) =>
        nodeSpawn(file, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          // Run from the installer's own directory, never from the app's. An
          // installer whose working directory is inside the folder it is
          // replacing can fail to replace the files it is standing on.
          cwd: path.dirname(file)
        }))
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
    const canInstall = this.deps.canInstall()
    const install = this.deps.installInfo()

    // An installer that survived verification last time is worth keeping: the
    // alternative is asking for 197 MB again after a declined UAC prompt.
    const pending = await this.findVerifiedInstaller(installerNameFor(info), info.downloadSize)
    this.installer = pending

    this.info = {
      ...info,
      canInstall: canInstall && Boolean(info.downloadUrl),
      installKind: install.kind,
      needsElevation: install.needsElevation,
      pendingInstaller: pending
    }
    this.deps.log(
      `checked: current=${info.current} latest=${info.latest ?? '-'} available=${info.available} ` +
        `canInstall=${this.info.canInstall} kind=${install.kind} size=${info.downloadSize} ` +
        `pending=${pending ? 'yes' : 'no'} error=${info.error || '-'}`
    )
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

    const name = installerNameFor(info)
    const dir = this.deps.installerDir()
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, name)
    const partial = `${target}.part`

    // Already downloaded and verified? Then this is a retry after a failed
    // install, not a new download.
    const existing = await this.findVerifiedInstaller(name, info.downloadSize)
    if (existing) {
      const reused = this.installer !== existing
      this.installer = existing
      if (reused) this.deps.log(`reusing verified installer already on disk: ${existing}`)
      this.emit({ phase: 'ready', received: info.downloadSize, total: info.downloadSize, percent: 100, error: '' }, true)
      return this.state
    }

    const controller = new AbortController()
    this.controller = controller
    this.installer = null

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

      this.deps.log(`downloading ${info.downloadUrl} -> ${target}`)
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
      // Keep this installer, drop whatever earlier attempts left behind. Two
      // 197 MB installers and a few stray `.part` files pile up fast.
      void this.pruneInstallers(target)
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
   * Start the installer and, once it is confirmed running, shut down.
   *
   * The order matters and is the whole fix for "I pressed install and nothing
   * happened": the installer is started first, its survival is verified, and only
   * then does the app hand the machine over. When the launch cannot be confirmed
   * the app stays open and says so, with the verified installer kept on disk so
   * the user can run it themselves.
   */
  async install(): Promise<void> {
    if (!this.installer) throw new Error('更新尚未下載完成。')
    if (!this.deps.canInstall()) throw new Error('此版本不支援自動安裝，請手動下載。')

    const info = this.deps.installInfo()
    this.emit(
      {
        // A per-machine install has to raise a UAC prompt, and the user should be
        // told that before the app disappears.
        phase: info.needsElevation ? 'waiting-permission' : 'installing',
        received: this.state.received,
        total: this.state.total,
        percent: 100,
        error: ''
      },
      true
    )
    if (info.needsElevation) {
      this.deps.log('update needs administrator rights; waiting for the Windows permission prompt')
    }

    const outcome = await this.launch()
    if (!outcome.started) {
      throw new Error(this.state.error || outcome.reason || '無法啟動安裝程式。')
    }
    this.deps.requestQuit()
  }

  /**
   * Start the installer detached. Returns whether it is now running.
   *
   * Called from `install`, and again from the shutdown path as a no-op safety net
   * if the app is closing for another reason while an update is queued.
   */
  async launchInstaller(): Promise<{ started: boolean; reason?: string }> {
    if (!this.installer) return { started: false, reason: '更新尚未下載完成。' }
    return this.launch()
  }

  /** Everything a bug report about updating needs, in one pasteable string. */
  async diagnostics(): Promise<UpdateDiagnostics> {
    const install = this.deps.installInfo()
    const lines = [
      `AriaDM ${this.deps.currentVersion()}`,
      `platform: ${process.platform} ${process.arch}`,
      `install kind: ${install.kind}${install.needsElevation ? ' (needs administrator rights)' : ''}`,
      install.dir ? `install dir: ${install.dir}` : '',
      `in-app install available: ${this.deps.canInstall() ? 'yes' : 'no'}`,
      `latest: ${this.info?.latest ?? 'unknown'}`,
      `state: ${this.state.phase}${this.state.error ? ` - ${this.state.error}` : ''}`,
      `pending installer: ${this.installer ?? 'none'}`,
      '',
      `update log: ${this.deps.logPath()}`,
      this.deps.readLogTail(40)
    ]
    return { text: lines.filter((line) => line !== '').join('\n'), logPath: this.deps.logPath() }
  }

  private async launch(): Promise<{ started: boolean; reason?: string }> {
    const file = this.installer
    if (!file) return { started: false, reason: '更新尚未下載完成。' }

    if (process.platform !== 'win32') {
      const reason = '此平台不支援自動安裝。'
      this.fail(reason)
      return { started: false, reason }
    }

    // Nothing signed is run unsigned. A hijacked download, a swapped release
    // asset or a mangled transfer all look like a file that was not signed by
    // whoever signed this build.
    if (this.deps.verifyInstaller) {
      const verdict = await this.deps.verifyInstaller(file).catch(() => ({ ok: false, reason: '簽章檢查失敗' }))
      if (!verdict.ok) {
        const reason = verdict.reason ?? '簽章無法驗證'
        this.deps.log(`update installer rejected by the signature check: ${reason}`)
        this.fail(`${reason}，已停止安裝。請重新下載更新檔。`)
        return { started: false, reason }
      }
      this.deps.log('update installer signature accepted')
    }

    const info = this.deps.installInfo()
    const args = [...INSTALLER_ARGS]
    // `/allusers` states the install mode instead of leaving it to NSIS's own
    // registry sniffing, which is also what makes the elevation path certain.
    if (info.modeFlag) args.push(info.modeFlag)
    const image = path.basename(file)

    try {
      const child = this.spawnImpl(file, args)
      this.deps.log(
        `update installer launched: ${image} ${args.join(' ')} (kind=${info.kind} pid=${child.pid ?? '?'})`
      )
      const started = await this.confirmStarted(child, image, info.needsElevation)
      if (!started) {
        const reason = info.needsElevation
          ? '安裝程式沒有啟動，通常是 Windows 的權限提示被取消。'
          : '安裝程式啟動後立即結束。'
        this.deps.log(`update installer not confirmed running: ${reason}`)
        this.fail(`${reason}你可以改用「開啟安裝程式」手動完成更新。`)
        return { started: false, reason }
      }

      // Consumed: pressing install twice must not run the same installer twice.
      this.installer = null
      this.deps.log('update installer confirmed running; the app is quitting so it can finish')
      return { started: true }
    } catch (error) {
      const message = (error as Error).message
      this.deps.log(`update installer failed to start: ${message}`)
      // Silent install is the goal, not a requirement: rather than leave the
      // user with a failed update, hand the file to the shell.
      let opened = false
      try {
        this.deps.openInstaller(file)
        opened = true
      } catch (openError) {
        this.deps.log(`could not open installer: ${(openError as Error).message}`)
      }
      this.fail(opened ? `${message}（已改為手動開啟安裝程式）` : message)
      return { started: false, reason: message }
    }
  }

  /**
   * Is the installer actually running?
   *
   * Two shapes have to be told apart. A normal launch keeps the process we
   * spawned alive for the whole install, so surviving the grace period is proof
   * enough. An elevating launch does not: the NSIS bootstrap re-runs itself with
   * administrator rights and exits immediately, so the proof is the *new*
   * process — which only appears after the user answers the UAC prompt.
   */
  private async confirmStarted(child: UpdateChild, image: string, needsElevation: boolean): Promise<boolean> {
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code: number | null) => resolve(code))
      // A spawn failure is reported as an exit with code -1: either way, nothing
      // is running any more.
      child.once('error', () => resolve(-1))
    })

    const outcome = await Promise.race([exited, delay(this.timings.earlyExitMs).then(() => 'alive' as const)])
    if (outcome === 'alive') return true

    this.deps.log(`installer process exited after ${this.timings.earlyExitMs}ms (code ${outcome})`)
    const deadline = Date.now() + (needsElevation ? this.timings.elevatedConfirmMs : 0)
    for (;;) {
      if (await this.processRunning(image)) return true
      if (Date.now() >= deadline) return false
      await delay(this.timings.processPollMs)
    }
  }

  /** Report a failure that happened after the download, so the UI can show it. */
  private fail(error: string): void {
    this.emit({ phase: 'error', received: this.state.received, total: this.state.total, percent: -1, error }, true)
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

  /**
   * A previously verified installer for this release, if one is still on disk.
   *
   * The size check is what makes "verified" meaningful: a file left over from a
   * partly deleted download, or from a different release entirely, must not be
   * offered as an update.
   */
  private async findVerifiedInstaller(name: string, expectedSize: number): Promise<string | null> {
    if (!name) return null
    const target = path.join(this.deps.installerDir(), name)
    try {
      const stat = await fsp.stat(target)
      if (!stat.isFile() || stat.size === 0) return null
      if (expectedSize > 0 && stat.size !== expectedSize) return null
      await this.assertExecutable(target)
      return target
    } catch {
      return null
    }
  }

  /** Remove installers and `.part` files left by earlier attempts. */
  private async pruneInstallers(keep: string): Promise<void> {
    try {
      const entries = await fsp.readdir(this.deps.installerDir())
      for (const entry of entries) {
        if (!/\.(exe|part)$/i.test(entry)) continue
        const full = path.join(this.deps.installerDir(), entry)
        if (full === keep) continue
        await fsp.rm(full, { force: true }).catch(() => {})
        this.deps.log(`removed stale update file: ${entry}`)
      }
    } catch {
      // Nothing to prune if the directory is not there.
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
