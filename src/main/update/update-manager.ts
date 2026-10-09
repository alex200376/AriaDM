import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type {
  UpdateCheckResult,
  UpdateDiagnostics,
  UpdateInfo,
  UpdateProgress,
  UpdateRepairResult
} from '@shared/ipc'
import { t } from '@shared/i18n'

import type { InstallInfo } from './install-kind'
import { checkForUpdate } from './update-checker'

/**
 * What the NSIS installer exits with when its own integrity check fails.
 *
 * It is the "Installer integrity check has failed. Common causes include
 * incomplete download and damaged media" box, and it is the one exit code that
 * means the *file* is bad rather than the user having cancelled a prompt (which
 * arrives as Windows' 1223, `ERROR_CANCELLED`).
 */
const NSIS_INTEGRITY_FAILURE = 2

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
 * The download is verified before it is allowed to run: the byte count must match
 * what the release advertised (a truncated installer is worse than no update),
 * the bytes themselves must hash to the SHA-256 GitHub published for that asset,
 * and the file must start with an `MZ` header. The digest is what makes a
 * *damaged* transfer detectable — a file can arrive the right length and the
 * wrong bytes, and without a hash to compare against it was accepted, then reused
 * on every retry, and refused by the installer's own integrity check again and
 * again without ever being downloaded a second time.
 *
 * A verified installer is left on disk so a failed update does not have to fetch
 * 197 MB twice — but "verified" means the digest matched, and that is checked
 * again on reuse rather than taken on trust from last time.
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
  /**
   * Download the installer with the app's own engine (aria2c).
   *
   * Preferred over the built-in fetch-and-pipe because the engine runs as a
   * separate process and verifies the published checksum itself. Absent on a
   * build whose engine cannot be located, in which case the fetch path is used.
   */
  aria2Download?(options: {
    url: string
    dir: string
    out: string
    sha256: string
    size: number
    signal: AbortSignal
    onProgress(received: number): void
  }): Promise<{ ok: boolean; unavailable?: boolean; error?: string }>
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
 * How many times a download may be attempted before the failure is reported.
 *
 * Two, not one: a fresh release can be served — or its digest reported — a
 * moment behind by a CDN edge or an antivirus/proxy cache, and the symptom is a
 * digest mismatch on a file of exactly the right length. A second attempt
 * re-reads the release and downloads from a different URL, which is what makes
 * that recoverable instead of a permanent failure.
 */
const MAX_DOWNLOAD_ATTEMPTS = 2

/**
 * The same URL with a throwaway query parameter.
 *
 * Release assets are served through a CDN edge and, on a machine that has one,
 * an antivirus or corporate proxy that caches by URL. A brand-new asset can be
 * cached before it has fully propagated, and the same URL then keeps answering
 * with the old bytes for ever. Changing the URL sidesteps every such cache.
 */
function cacheBusted(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('ariadm_retry', String(Date.now()))
    return parsed.toString()
  } catch {
    return url
  }
}

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
    const pending = await this.findVerifiedInstaller(
      installerNameFor(info),
      info.downloadSize,
      info.downloadSha256
    )
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
    if (!this.info?.downloadUrl) throw new Error(t('update.noDownloadUrl'))

    /*
     * Claim the in-flight slot before anything can await.
     *
     * The guard used to be checked here but the claim itself happened only after
     * `mkdir` and after re-verifying whatever is already on disk, so two quick
     * presses could both get past it and run two downloads into the same `.part`
     * file. Two write positions and one file produce exactly the failure that
     * cannot be seen from the byte count: the right length, with blocks of the
     * wrong data in it.
     */
    if (this.controller) return this.state
    const controller = new AbortController()
    this.controller = controller
    try {
      return await this.runDownload(controller)
    } finally {
      // Only our own: a newer attempt may already have taken the slot, and
      // clearing that one would let a third start on top of it.
      if (this.controller === controller) this.controller = null
    }
  }

  /** The download itself; `download` holds the in-flight slot around it. */
  private async runDownload(controller: AbortController): Promise<UpdateProgress> {
    // Reassigned on a retry: the digest we compare against may itself be the
    // part that was stale.
    let info = this.info
    if (!info?.downloadUrl) throw new Error(t('update.noDownloadUrl'))

    const name = installerNameFor(info)
    const dir = this.deps.installerDir()
    await fsp.mkdir(dir, { recursive: true })
    const target = path.join(dir, name)
    const partial = `${target}.part`

    // Already downloaded and verified? Then this is a retry after a failed
    // install, not a new download.
    const existing = await this.findVerifiedInstaller(name, info.downloadSize, info.downloadSha256)
    if (existing) {
      const reused = this.installer !== existing
      this.installer = existing
      if (reused) this.deps.log(`reusing verified installer already on disk: ${existing}`)
      this.emit({ phase: 'ready', received: info.downloadSize, total: info.downloadSize, percent: 100, error: '' }, true)
      return this.state
    }

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

      // The app's own engine first: it verifies the published checksum itself,
      // and being a separate process it is not exposed to anything wrong in this
      // one. Only when it is unavailable, or fails, does the fetch path run.
      if (await this.downloadWithEngine(info, controller)) {
        const size = (await fsp.stat(target).catch(() => null))?.size ?? info.downloadSize
        this.installer = target
        this.emit({ phase: 'ready', received: size, total: size, percent: 100, error: '' }, true)
        void this.pruneInstallers(target)
        return this.state
      }

      let received = 0
      let total = info.downloadSize

      for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
        const baseUrl = info.downloadUrl
        if (!baseUrl) throw new Error(t('update.noDownloadUrl'))
        const url = attempt === 0 ? baseUrl : cacheBusted(baseUrl)
        this.deps.log(`downloading ${url} -> ${target}`)

        const response = await this.fetchImpl(url, { signal: controller.signal })
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

        const headerLength = Number(response.headers.get('content-length'))
        total = headerLength > 0 ? headerLength : info.downloadSize

        await fsp.rm(partial, { force: true })
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        received = 0
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

        // A short read means the connection dropped mid-file. Installing a
        // partial installer is worse than asking the user to try again.
        if (total > 0 && received !== total) {
          throw new Error(t('update.incomplete', { received, total }))
        }

        /*
         * The bytes, not just the count.
         *
         * This is the check that separates "the transfer finished" from "the
         * file is the one that was published". A damaged write of the right
         * length is rare, but it is not hypothetical: it is what a storage or
         * antivirus fault in the middle of a 197 MB write looks like, and a
         * fresh release served a moment early looks the same from here.
         */
        if (!info.downloadSha256) break
        const actual = await this.hashFile(partial)
        if (actual === info.downloadSha256) break

        // Recorded rather than only thrown: without the two hashes in the log,
        // this failure is indistinguishable from a dozen other causes.
        this.deps.log(
          `update: downloaded installer failed its digest check ` +
            `(expected ${info.downloadSha256}, got ${actual})`
        )
        if (attempt + 1 >= MAX_DOWNLOAD_ATTEMPTS) {
          throw new Error(t('update.checksumMismatch'))
        }
        // Take the release's word again as well: the digest we were comparing
        // against may have been the stale part, not the file.
        const refreshed = await this.check().catch(() => null)
        if (refreshed?.downloadUrl) info = refreshed
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
      const message = controller.signal.aborted || isAbort(error) ? t('update.cancelled') : (error as Error).message
      this.emit({ phase: 'error', received: 0, total: 0, percent: -1, error: message }, true)
      throw new Error(message)
    }
  }

  /**
   * Fetch the installer with the app's own engine.
   *
   * Never throws except for a cancellation: every other failure is reported so
   * the caller can fall through to its own download, because only the
   * *combination* failing is a real dead end. The engine checks the published
   * SHA-256 itself and the digest is checked again here — a file that reaches the
   * installer is the one thing in this flow that must never be wrong.
   */
  private async downloadWithEngine(info: UpdateInfo, controller: AbortController): Promise<boolean> {
    const download = this.deps.aria2Download
    const url = info.downloadUrl
    if (!download || !url || !info.downloadSha256) return false

    const dir = this.deps.installerDir()
    const out = installerNameFor(info)
    const target = path.join(dir, out)

    try {
      this.deps.log(`downloading with the bundled engine: ${url} -> ${target}`)
      const result = await download({
        url,
        dir,
        out,
        sha256: info.downloadSha256,
        size: info.downloadSize,
        signal: controller.signal,
        onProgress: (received) => {
          this.emit({
            phase: 'downloading',
            received,
            total: info.downloadSize,
            percent:
              info.downloadSize > 0 ? Math.min(99, Math.floor((received / info.downloadSize) * 100)) : -1,
            error: ''
          })
        }
      })
      // A cancelled engine reports failure like any other; without this the
      // fetch path would immediately start downloading what the user just
      // cancelled.
      if (controller.signal.aborted) throw new Error(t('update.cancelled'))
      if (!result.ok) {
        this.deps.log(
          `update: the bundled engine could not fetch the installer` +
            `${result.unavailable ? ' (aria2 is unavailable)' : ''}: ${result.error ?? ''}`
        )
        return false
      }
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) throw error
      this.deps.log(`update: the bundled engine failed: ${(error as Error).message}`)
      return false
    }

    const actual = await this.hashFile(target).catch(() => '')
    if (actual !== info.downloadSha256) {
      this.deps.log(
        `update: engine download failed its digest check ` +
          `(expected ${info.downloadSha256}, got ${actual || 'no file on disk'})`
      )
      await fsp.rm(target, { force: true }).catch(() => undefined)
      return false
    }

    // The same gate the fetch path applies: an installer that is not a Windows
    // executable never gets to run, whoever downloaded it.
    try {
      await this.assertExecutable(target)
    } catch (error) {
      this.deps.log(`update: engine download is not a Windows executable: ${(error as Error).message}`)
      await fsp.rm(target, { force: true }).catch(() => undefined)
      return false
    }

    this.deps.log(`update downloaded: ${target}`)
    return true
  }

  /**
   * Abort an in-flight download. Harmless when nothing is running.
   *
   * Deliberately does *not* clear the controller: this attempt's own `finally`
   * does that, and only once its `pipeline` has finished unwinding. Clearing it
   * here released the "already downloading" guard while the aborted write stream
   * still had buffered chunks to flush, so a retry could open a second writer on
   * the same `.part` file — two file positions, one file, and a result that is
   * the right length and the wrong bytes.
   */
  cancel(): void {
    this.controller?.abort()
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
    if (!this.installer) throw new Error(t('update.notDownloaded'))
    if (!this.deps.canInstall()) throw new Error(t('update.installUnsupported'))

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
      throw new Error(this.state.error || outcome.reason || t('update.installerWontStart'))
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
    if (!this.installer) return { started: false, reason: t('update.notDownloaded') }
    return this.launch()
  }

  /**
   * Re-verify what is sitting in the update folder and delete what does not
   * match the release it claims to be.
   *
   * `download()` already checks what it writes, so this is for the files that
   * were written before that check existed or were damaged afterwards — a
   * storage fault, an antivirus rewriting a file it quarantined — which all
   * leave the length intact. Such a file keeps passing a name-and-size test for
   * ever: the app calls the update "ready", the installer fails its integrity
   * check every time, and no retry ever re-fetches it. Removing it is the one
   * action that gets that state moving again, and it is a step the user cannot
   * take from the UI on their own.
   */
  async repairCache(): Promise<UpdateRepairResult> {
    const result: UpdateRepairResult = { checked: 0, removed: 0, kept: 0, bytesFreed: 0 }
    const dir = this.deps.installerDir()

    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      this.deps.log('update cache repair: no update folder to check')
      return result
    }

    // An installer can only be judged against the release it names. Before the
    // first check there is no such release, and then there is nothing that could
    // make a file "wrong" — so nothing is deleted on a guess.
    const expectedSha256 = this.info?.downloadSha256 ?? ''

    for (const entry of entries) {
      if (!/\.(exe|part)$/i.test(entry)) continue
      const full = path.join(dir, entry)
      result.checked += 1

      let size = 0
      try {
        size = (await fsp.stat(full)).size
      } catch {
        continue
      }

      // A `.part` file is an unfinished download by definition: no installer was
      // ever run from it, and a fresh download starts a new one anyway.
      const isPartial = entry.toLowerCase().endsWith('.part')
      const digest =
        !isPartial && expectedSha256 ? await this.hashFile(full).catch(() => '') : ''
      const keep = !isPartial && (expectedSha256 === '' || digest === expectedSha256)

      if (keep) {
        result.kept += 1
        continue
      }

      await fsp.rm(full, { force: true }).catch(() => {})
      result.removed += 1
      result.bytesFreed += size
      this.deps.log(`update cache repair: removed ${entry}`)

      if (this.installer === full) {
        // Stop offering an installer that is no longer on disk. Without this the
        // About tab would keep a "ready" state pointing at a deleted file.
        this.installer = null
        if (this.state.phase === 'ready') this.emit({ ...IDLE }, true)
      }
    }

    this.deps.log(
      `update cache repair: checked=${result.checked} removed=${result.removed} ` +
        `kept=${result.kept} freed=${result.bytesFreed}`
    )
    return result
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
    if (!file) return { started: false, reason: t('update.notDownloaded') }

    if (process.platform !== 'win32') {
      const reason = t('update.installUnsupportedPlatform')
      this.fail(reason)
      return { started: false, reason }
    }

    // Nothing signed is run unsigned. A hijacked download, a swapped release
    // asset or a mangled transfer all look like a file that was not signed by
    // whoever signed this build.
    if (this.deps.verifyInstaller) {
      const verdict = await this.deps.verifyInstaller(file).catch(() => ({ ok: false, reason: t('update.signatureCheckFailed') }))
      if (!verdict.ok) {
        const reason = verdict.reason ?? t('update.signatureUnverified')
        this.deps.log(`update installer rejected by the signature check: ${reason}`)
        this.fail(t('update.installStopped', { reason }))
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
      const outcome = await this.confirmStarted(child, image, info.needsElevation)
      if (!outcome.started) {
        /*
         * A damaged file is the one failure the installer cannot walk away from:
         * it cannot re-download itself, so leaving it on disk means every retry
         * fails on the same bytes. Dropping it here turns a permanent dead end
         * into one more attempt — which the digest check either passes or catches
         * before the install is even tried.
         */
        if (outcome.exitCode === NSIS_INTEGRITY_FAILURE) {
          await fsp.rm(file, { force: true }).catch(() => {})
          this.installer = null
          this.deps.log(
            'update installer reported a damaged file; discarded so the next attempt downloads it again'
          )
          const damaged = t('update.installerDamaged')
          this.fail(t('update.manualFallback', { message: damaged }))
          return { started: false, reason: damaged }
        }

        const reason = info.needsElevation
          ? t('update.notStartedElevation')
          : t('update.notStartedImmediately')
        this.deps.log(`update installer not confirmed running: ${reason}`)
        this.fail(t('update.manualInstallerHint', { reason }))
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
      this.fail(opened ? t('update.openedManually', { message }) : message)
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
  private async confirmStarted(
    child: UpdateChild,
    image: string,
    needsElevation: boolean
  ): Promise<{ started: boolean; exitCode: number | null }> {
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code: number | null) => resolve(code))
      // A spawn failure is reported as an exit with code -1: either way, nothing
      // is running any more.
      child.once('error', () => resolve(-1))
    })

    const outcome = await Promise.race([exited, delay(this.timings.earlyExitMs).then(() => 'alive' as const)])
    if (outcome === 'alive') return { started: true, exitCode: null }

    this.deps.log(`installer process exited after ${this.timings.earlyExitMs}ms (code ${outcome})`)
    const deadline = Date.now() + (needsElevation ? this.timings.elevatedConfirmMs : 0)
    for (;;) {
      // The exit code travels with the answer: it is what tells a damaged file
      // apart from a declined permission prompt.
      if (await this.processRunning(image)) return { started: true, exitCode: outcome }
      if (Date.now() >= deadline) return { started: false, exitCode: outcome }
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
      if (header.toString('latin1') !== 'MZ') throw new Error(t('update.notExecutable'))
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
  private async findVerifiedInstaller(
    name: string,
    expectedSize: number,
    expectedSha256: string
  ): Promise<string | null> {
    if (!name) return null
    const target = path.join(this.deps.installerDir(), name)
    try {
      const stat = await fsp.stat(target)
      if (!stat.isFile() || stat.size === 0) return null
      if (expectedSize > 0 && stat.size !== expectedSize) return null
      await this.assertExecutable(target)

      /*
       * Re-verify the contents instead of taking the name and the size as proof.
       *
       * A file that was damaged *after* it was written — by a storage fault, by
       * an antivirus rewriting what it quarantined, by any of the things that
       * leave the length intact — otherwise passes this check for ever, and the
       * user gets an installer that fails every time and is never fetched again.
       * That is a dead end the app cannot talk its way out of, so a mismatch is
       * thrown away here and the next attempt downloads a clean copy.
       */
      if (expectedSha256 && (await this.hashFile(target)) !== expectedSha256) {
        this.deps.log('discarding downloaded installer: its contents do not match the published check code')
        await fsp.rm(target, { force: true }).catch(() => {})
        return null
      }
      return target
    } catch {
      return null
    }
  }

  /** SHA-256 of a file, streamed so a 197 MB installer never has to fit in memory. */
  private hashFile(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = fs.createReadStream(file)
      stream.on('error', reject)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
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
