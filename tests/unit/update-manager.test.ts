import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { UpdateCheckResult, UpdateProgress } from '../../src/shared/ipc'
import type { InstallInfo } from '../../src/main/update/install-kind'
import { UpdateManager, type UpdateChild, type UpdateDownloadFetch } from '../../src/main/update/update-manager'

const EXE_BYTES = new TextEncoder().encode('MZ' + 'x'.repeat(2046))
const INSTALLER_NAME = 'AriaDM-0.2.0-setup.exe'

/** A per-user install: no administrator rights anywhere in sight. */
const USER_INSTALL: InstallInfo = {
  kind: 'user',
  needsElevation: false,
  dir: 'C:/Users/me/AppData/Local/Programs/AriaDM',
  modeFlag: ''
}

/**
 * A "for all users" install in Program Files, which is what the reported bug
 * was: the silent installer has to elevate, and a declined UAC prompt makes it
 * exit instantly and silently.
 */
const MACHINE_INSTALL: InstallInfo = {
  kind: 'machine',
  needsElevation: true,
  dir: 'C:/Program Files/AriaDM',
  modeFlag: '/allusers'
}

function releaseInfo(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    current: '0.1.0',
    latest: '0.2.0',
    available: true,
    releaseUrl: 'https://example.test/release',
    downloadUrl: `https://example.test/${INSTALLER_NAME}`,
    downloadSize: EXE_BYTES.length,
    canInstall: false,
    error: '',
    ...overrides
  }
}

function streamResponse(bytes: Uint8Array, contentLength: number): ReturnType<UpdateDownloadFetch> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(contentLength) : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    })
  })
}

/** How the fake installer process behaves once spawned. */
interface SpawnBehaviour {
  /** Exit after this long, or never when omitted (a real install keeps running). */
  exitAfterMs?: number
  exitCode?: number
  /** Report an immediate launch failure instead of spawning. */
  spawnError?: Error
}

function fakeChild(behaviour: SpawnBehaviour, unref: () => void): UpdateChild {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = { spawn: [], exit: [], error: [] }

  const once = ((event: string, listener: (arg?: unknown) => void) => {
    listeners[event]?.push(listener)
    return child
  }) as UpdateChild['once']

  const child: UpdateChild = { pid: 4242, once, unref }

  void Promise.resolve().then(() => {
    if (behaviour.spawnError) {
      for (const listener of listeners.error ?? []) listener(behaviour.spawnError)
      return
    }
    for (const listener of listeners.spawn ?? []) listener()
    if (behaviour.exitAfterMs !== undefined) {
      const timer = setTimeout(() => {
        for (const listener of listeners.exit ?? []) listener(behaviour.exitCode ?? 0)
      }, behaviour.exitAfterMs)
      timer.unref?.()
    }
  })

  return child
}

function makeManager(
  options: {
    bytes?: Uint8Array
    contentLength?: number
    canInstall?: boolean
    install?: InstallInfo
    spawnThrows?: boolean
    child?: SpawnBehaviour
    /** Image names `tasklist` reports; mutated by tests to simulate the elevated copy. */
    running?: string[]
    onProgress?: (progress: UpdateProgress) => void
  } = {}
): {
  manager: UpdateManager
  dir: string
  spawned: { file: string; args: string[] }[]
  quit: ReturnType<typeof vi.fn>
  opened: string[]
  logs: string[]
  fetches: () => number
  running: string[]
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ariadm-update-'))
  const bytes = options.bytes ?? EXE_BYTES
  const spawned: { file: string; args: string[] }[] = []
  const opened: string[] = []
  const logs: string[] = []
  const running = options.running ?? []
  const quit = vi.fn()
  let fetches = 0

  const manager = new UpdateManager({
    currentVersion: () => '0.1.0',
    installerDir: () => dir,
    canInstall: () => options.canInstall ?? true,
    installInfo: () => options.install ?? USER_INSTALL,
    onProgress: options.onProgress ?? (() => {}),
    requestQuit: quit,
    openInstaller: (file) => {
      opened.push(file)
    },
    log: (line) => {
      logs.push(line)
    },
    logPath: () => path.join(dir, 'update.log'),
    readLogTail: () => '2026-10-01T00:00:00.000Z checked: current=0.1.0',
    // Short windows: the real ones exist so a human can answer a UAC prompt, and
    // a test should not stand in for one.
    timings: { earlyExitMs: 30, elevatedConfirmMs: 60, processPollMs: 5 },
    checkImpl: async () => releaseInfo(),
    fetchImpl: () => {
      fetches += 1
      return streamResponse(bytes, options.contentLength ?? bytes.length)
    },
    spawnImpl: (file, args) => {
      if (options.spawnThrows) throw new Error('blocked by the system')
      spawned.push({ file, args })
      return fakeChild(options.child ?? {}, () => {})
    },
    processRunning: async (image) => running.includes(image)
  })

  return { manager, dir, spawned, quit, opened, logs, fetches: () => fetches, running }
}

describe('UpdateManager.check', () => {
  it('marks the update installable only when the build supports it', async () => {
    const supported = makeManager({ canInstall: true }).manager
    expect((await supported.check()).canInstall).toBe(true)

    const portable = makeManager({ canInstall: false }).manager
    expect((await portable.check()).canInstall).toBe(false)
  })

  it('reports how this copy is installed and whether it needs administrator rights', async () => {
    const { manager } = makeManager({ install: MACHINE_INSTALL })
    const info = await manager.check()

    expect(info.installKind).toBe('machine')
    expect(info.needsElevation).toBe(true)
    expect(info.pendingInstaller).toBeNull()
  })

  it('offers an installer that was already downloaded and verified', async () => {
    const pending = makeManager()
    writeFileSync(path.join(pending.dir, INSTALLER_NAME), EXE_BYTES)
    expect((await pending.manager.check()).pendingInstaller).toBe(path.join(pending.dir, INSTALLER_NAME))
  })

  it('ignores an installer left behind by a different release', async () => {
    const stale = makeManager()
    // Right name, wrong size: a partly deleted download, not something to run.
    writeFileSync(path.join(stale.dir, INSTALLER_NAME), EXE_BYTES.slice(0, 100))
    expect((await stale.manager.check()).pendingInstaller).toBeNull()
  })
})

describe('UpdateManager.download', () => {
  it('streams the installer to disk and ends in the ready phase', async () => {
    const seen: UpdateProgress[] = []
    const { manager, dir } = makeManager({ onProgress: (progress) => seen.push(progress) })
    await manager.check()

    const final = await manager.download()

    expect(final.phase).toBe('ready')
    expect(final.percent).toBe(100)
    expect(manager.pendingInstaller).toBe(path.join(dir, INSTALLER_NAME))
    expect(readFileSync(manager.pendingInstaller!)).toEqual(Buffer.from(EXE_BYTES))
    // Progress was reported while downloading, not only at the end.
    expect(seen.some((progress) => progress.phase === 'downloading')).toBe(true)
  })

  it('reuses a verified installer instead of downloading 197 MB again', async () => {
    const { manager, dir, fetches } = makeManager()
    writeFileSync(path.join(dir, INSTALLER_NAME), EXE_BYTES)
    await manager.check()

    const final = await manager.download()

    expect(final.phase).toBe('ready')
    expect(fetches()).toBe(0)
    expect(manager.pendingInstaller).toBe(path.join(dir, INSTALLER_NAME))
  })

  it('rejects a truncated download and leaves no installer behind', async () => {
    // The server promised more bytes than it sent.
    const { manager } = makeManager({ contentLength: EXE_BYTES.length + 500 })
    await manager.check()

    await expect(manager.download()).rejects.toThrow(/不完整/)
    expect(manager.pendingInstaller).toBeNull()
    expect(manager.progress.phase).toBe('error')
  })

  it('refuses a file that is not a Windows executable', async () => {
    const { manager } = makeManager({ bytes: new TextEncoder().encode('not an installer') })
    await manager.check()

    await expect(manager.download()).rejects.toThrow(/可執行檔/)
    expect(manager.pendingInstaller).toBeNull()
  })
})

describe('UpdateManager.install', () => {
  it('launches the installer silently and hands over once it is running', async () => {
    const { manager, spawned, quit } = makeManager()
    await manager.check()

    await expect(manager.install()).rejects.toThrow(/尚未下載/)

    await manager.download()
    await manager.install()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.args).toEqual(['/S', '--updated', '--force-run'])
    expect(quit).toHaveBeenCalledTimes(1)
    // Consumed: a second press must not run the same installer twice.
    expect(manager.pendingInstaller).toBeNull()
  })

  it('tells a per-machine install about the install mode and warns about permissions', async () => {
    const seen: UpdateProgress[] = []
    const { manager, spawned, quit } = makeManager({
      install: MACHINE_INSTALL,
      onProgress: (progress) => seen.push(progress)
    })
    await manager.check()
    await manager.download()

    await manager.install()

    expect(spawned[0]!.args).toEqual(['/S', '--updated', '--force-run', '/allusers'])
    expect(seen.some((progress) => progress.phase === 'waiting-permission')).toBe(true)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('keeps the app open when the installer dies at once with nothing to show for it', async () => {
    // What a declined UAC prompt looks like from here.
    const { manager, quit, opened } = makeManager({ child: { exitAfterMs: 0, exitCode: 0 } })
    await manager.check()
    await manager.download()

    await expect(manager.install()).rejects.toThrow(/權限提示被取消|立即結束/)

    // Quitting would leave the user with no app and no update, which is exactly
    // the failure this ordering exists to prevent.
    expect(quit).not.toHaveBeenCalled()
    expect(opened).toEqual([])
    expect(manager.progress.phase).toBe('error')
    // The verified installer stays on disk, so a retry costs nothing.
    expect(manager.pendingInstaller).not.toBeNull()
  })

  it('accepts an elevating launcher exiting early, because the elevated copy is running', async () => {
    const running: string[] = []
    const { manager, quit } = makeManager({
      install: MACHINE_INSTALL,
      child: { exitAfterMs: 0, exitCode: 0 },
      running
    })
    await manager.check()
    await manager.download()

    // NSIS re-runs itself elevated and the original process quits, so the proof
    // that the install started is the new process carrying the same image name.
    running.push(INSTALLER_NAME)
    await manager.install()

    expect(quit).toHaveBeenCalledTimes(1)
    expect(manager.pendingInstaller).toBeNull()
  })

  it('opens the installer by hand when the silent launch cannot even start', async () => {
    const { manager, quit, opened } = makeManager({ spawnThrows: true })
    await manager.check()
    await manager.download()

    await expect(manager.install()).rejects.toThrow(/blocked by the system/)
    expect(quit).not.toHaveBeenCalled()
    expect(opened).toHaveLength(1)
    expect(opened[0]!.endsWith(INSTALLER_NAME)).toBe(true)
    expect(manager.progress.phase).toBe('error')
  })

  it('does nothing on the shutdown safety net when no installer is pending', async () => {
    const { manager, spawned } = makeManager()
    await manager.check()

    expect(await manager.launchInstaller()).toEqual({ started: false, reason: '更新尚未下載完成。' })
    expect(spawned).toHaveLength(0)
  })
})

describe('UpdateManager.diagnostics', () => {
  it('describes the install so a bug report can be acted on', async () => {
    const { manager } = makeManager({ install: MACHINE_INSTALL })
    await manager.check()

    const report = await manager.diagnostics()

    expect(report.text).toContain('install kind: machine (needs administrator rights)')
    expect(report.text).toContain('install dir: C:/Program Files/AriaDM')
    expect(report.text).toContain('latest: 0.2.0')
    expect(report.logPath.endsWith('update.log')).toBe(true)
  })
})
