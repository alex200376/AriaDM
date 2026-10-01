import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'

import type { EngineState, EngineStatus } from '@shared/download'
import type { Settings } from '@shared/settings'

import { buildDaemonArgs, globalLimitOptions, type DaemonPaths } from './options'
import { Aria2RpcClient } from './rpc-client'
import { SessionFile } from './session'
import type { Aria2Notification } from './types'

export interface SupervisorOptions {
  binaryPath: string
  settings: Settings
  paths: DaemonPaths
  onLog?: (line: string) => void
}

/** Consecutive failed health probes tolerated before we recycle the daemon. */
const HEALTH_FAILURE_LIMIT = 3
const HEALTH_INTERVAL_MS = 10_000
const MAX_RESTARTS_PER_WINDOW = 5
const RESTART_WINDOW_MS = 60_000

/**
 * Find a loopback port. If the preferred port is taken we fall back to an
 * ephemeral one rather than failing: a port clash must never block a download.
 */
async function findFreePort(preferred = 0): Promise<number> {
  const attempt = (port: number): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.unref()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const chosen = typeof address === 'object' && address ? address.port : 0
        server.close(() => resolve(chosen))
      })
    })

  if (preferred > 0) {
    try {
      return await attempt(preferred)
    } catch {
      // Port busy; fall through to an ephemeral port.
    }
  }
  return attempt(0)
}

/**
 * Owns the aria2c child process: spawning, health, log capture, clean shutdown
 * and crash recovery.
 *
 * The RPC secret lives only here and in the renderer-inaccessible main process.
 */
export class Aria2Supervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private rpcClient: Aria2RpcClient | null = null
  private session: SessionFile

  private state: EngineState = 'stopped'
  private message = ''
  private lastError = ''
  private restarts = 0
  private restartTimes: number[] = []
  private startedAt: number | null = null
  private intentionalStop = false
  private port: number | null = null
  private secret = ''
  private healthTimer: NodeJS.Timeout | null = null
  private healthFailures = 0
  private restartTimer: NodeJS.Timeout | null = null

  private logRing: string[] = []
  private readonly logRingLimit = 400

  private binaryPath: string
  private settings: Settings
  private readonly paths: DaemonPaths
  private readonly onLog: (line: string) => void

  constructor(options: SupervisorOptions) {
    super()
    this.binaryPath = options.binaryPath
    this.settings = options.settings
    this.paths = options.paths
    this.session = new SessionFile(options.paths.sessionFile)
    this.onLog = options.onLog ?? (() => {})
  }

  get rpc(): Aria2RpcClient {
    if (!this.rpcClient) throw new Error('aria2 RPC client is not available; engine is not running')
    return this.rpcClient
  }

  get isRunning(): boolean {
    return this.child !== null && this.state !== 'stopped' && this.state !== 'failed'
  }

  get logTail(): string {
    return this.logRing.slice(-80).join('\n')
  }

  getStatus(): EngineStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.port,
      version: '',
      message: this.message,
      restarts: this.restarts,
      lastError: this.lastError,
      logTail: this.logTail,
      startedAt: this.startedAt
    }
  }

  updateBinaryPath(binaryPath: string): void {
    this.binaryPath = binaryPath
  }

  /**
   * Apply settings that aria2 can change live. Anything that is only read at
   * process start (paths, RPC port, connection fan-out defaults) needs a restart.
   */
  async applyLiveSettings(settings: Settings): Promise<void> {
    this.settings = settings
    if (!this.rpcClient || !this.isRunning) return
    try {
      await this.rpcClient.changeGlobalOption(globalLimitOptions(settings))
    } catch (error) {
      this.pushLog(`failed to apply global options: ${(error as Error).message}`)
    }
  }

  private pushLog(line: string): void {
    const trimmed = line.trimEnd()
    if (!trimmed) return
    for (const part of trimmed.split(/\r?\n/)) {
      this.logRing.push(part)
      this.onLog(part)
    }
    if (this.logRing.length > this.logRingLimit) {
      this.logRing.splice(0, this.logRing.length - this.logRingLimit)
    }
  }

  private setState(state: EngineState, message = ''): void {
    this.state = state
    this.message = message
    this.emit('status', this.getStatus())
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  async start(): Promise<void> {
    if (this.isRunning || this.state === 'starting') return
    this.intentionalStop = false
    await this.launch()
  }

  private async launch(): Promise<void> {
    this.setState('starting', '正在啟動 aria2 引擎')

    try {
      // Drop any session file an older build left behind: AriaDM never replays it,
      // and leaving it around only risks a stale queue being restored if the
      // daemon options are ever changed back.
      await this.session.purge()
      await fsp.mkdir(this.paths.downloadDir, { recursive: true })
      await fsp.mkdir(path.dirname(this.paths.logFile), { recursive: true })
    } catch (error) {
      this.lastError = `無法建立必要目錄：${(error as Error).message}`
      this.setState('failed', this.lastError)
      return
    }

    this.secret = randomBytes(24).toString('hex')
    this.port = await findFreePort(this.settings.aria2RpcPort)

    const args = buildDaemonArgs({
      settings: this.settings,
      paths: this.paths,
      port: this.port,
      secret: this.secret
    })

    this.pushLog(`spawning ${this.binaryPath}`)
    this.pushLog(`  rpc port ${this.port}`)

    let child: ChildProcess
    try {
      child = spawn(this.binaryPath, args, {
        windowsHide: true,
        // Pipes must be drained explicitly: on Windows a full stdout buffer will
        // block the child, which looks exactly like a hung download.
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.lastError = `無法啟動 aria2：${(error as Error).message}`
      this.setState('failed', this.lastError)
      return
    }

    this.child = child

    child.stdout?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString('utf8')))
    child.on('error', (error) => {
      this.lastError = `aria2 程序錯誤：${error.message}`
      this.pushLog(this.lastError)
    })
    child.on('exit', (code, signal) => this.handleExit(code, signal))

    this.rpcClient = new Aria2RpcClient({ port: this.port, secret: this.secret })
    this.rpcClient.connectNotifications(
      (notification) => this.emit('notification', notification as Aria2Notification),
      (line) => this.pushLog(line)
    )

    const healthy = await this.waitForHealthy()
    if (!healthy) {
      this.lastError = 'aria2 引擎啟動後無法連線 RPC，請查看日誌。'
      this.setState('failed', this.lastError)
      await this.forceKillChild()
      return
    }

    this.healthFailures = 0
    this.startedAt = Date.now()
    this.startHealthWatchdog()
    this.setState('ready', '')
    this.pushLog('aria2 engine ready')
  }

  private async waitForHealthy(): Promise<boolean> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) return false
      try {
        const version = await this.rpcClient?.getVersion()
        if (version?.version) {
          this.pushLog(`aria2 version ${version.version}`)
          return true
        }
      } catch {
        // Not listening yet; keep waiting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  private startHealthWatchdog(): void {
    this.stopHealthWatchdog()
    this.healthTimer = setInterval(() => {
      void this.probeHealth()
    }, HEALTH_INTERVAL_MS)
    this.healthTimer.unref?.()
  }

  private stopHealthWatchdog(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async probeHealth(): Promise<void> {
    if (!this.rpcClient || !this.isRunning) return
    try {
      await this.rpcClient.getGlobalStat()
      this.healthFailures = 0
    } catch {
      this.healthFailures += 1
      if (this.healthFailures >= HEALTH_FAILURE_LIMIT) {
        this.pushLog(`RPC unreachable ${this.healthFailures} times; recycling aria2`)
        this.healthFailures = 0
        await this.stop()
        await this.start()
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = this.intentionalStop
    this.child = null
    this.stopHealthWatchdog()
    this.pushLog(`aria2 exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`)

    if (expected) {
      this.rpcClient?.close()
      this.rpcClient = null
      this.setState('stopped', '')
      return
    }

    this.lastError = `aria2 意外結束（代碼 ${code ?? '未知'}）。`
    void this.scheduleRestart()
  }

  private async scheduleRestart(): Promise<void> {
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter((time) => now - time < RESTART_WINDOW_MS)
    this.restartTimes.push(now)

    if (this.restartTimes.length > MAX_RESTARTS_PER_WINDOW) {
      this.setState('failed', 'aria2 反覆崩潰，已停止自動重啟。請至設定頁檢查引擎路徑或查看日誌。')
      return
    }

    const attempt = this.restartTimes.length
    const delay = Math.min(500 * 2 ** (attempt - 1), 8000)
    this.restarts += 1
    this.setState('restarting', `${Math.round(delay / 1000)} 秒後自動重啟（第 ${attempt} 次）`)
    this.emitStatus()

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.launch()
    }, delay)
    this.restartTimer.unref?.()
  }

  private async forceKillChild(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      child.kill()
    } catch {
      // Already dead.
    }
  }

  /**
   * Clean shutdown. Windows has no SIGTERM, so we ask aria2 to shut down first so
   * its per-download control files are flushed, and only escalate if it does not
   * comply.
   */
  async stop(): Promise<void> {
    this.intentionalStop = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopHealthWatchdog()

    const child = this.child
    const client = this.rpcClient
    if (!child) {
      this.setState('stopped', '')
      return
    }

    const waitForExit = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => resolve(child.exitCode !== null), ms)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })

    if (client) {
      try {
        await client.shutdown()
        this.pushLog('aria2 shutdown requested')
      } catch {
        this.pushLog('shutdown request failed; will escalate')
      }
    }

    let exited = await waitForExit(3000)

    if (!exited && client) {
      try {
        await client.forceShutdown()
      } catch {
        // Fall through to a hard kill.
      }
      exited = await waitForExit(1500)
    }

    if (!exited) {
      this.pushLog('aria2 did not exit gracefully; terminating')
      try {
        child.kill()
      } catch {
        // Nothing else we can do.
      }
      await waitForExit(1500)
    }

    client?.close()
    this.rpcClient = null
    this.child = null
    this.startedAt = null
    this.setState('stopped', '')
  }

  async restart(): Promise<void> {
    this.pushLog('restart requested')
    await this.stop()
    this.restartTimes = []
    this.restarts = 0
    await this.start()
  }
}
