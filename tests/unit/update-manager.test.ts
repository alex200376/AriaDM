import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { UpdateCheckResult, UpdateProgress } from '../../src/shared/ipc'
import type { InstallInfo } from '../../src/main/update/install-kind'
import {
  UpdateManager,
  type UpdateChild,
  type UpdateDownloadFetch,
  type UpdateManagerDeps
} from '../../src/main/update/update-manager'

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
    downloadSha256: '',
    canInstall: false,
    error: '',
    ...overrides
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A response whose body never ends, so a download stays in flight until aborted. */
function hangingResponse(signal?: AbortSignal): ReturnType<UpdateDownloadFetch> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(EXE_BYTES)
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      }
    })
  })
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
    /** The SHA-256 the release published for the asset. */
    digest?: string
    /** Replaces the default body, for a download that has to stay in flight. */
    fetchImpl?: UpdateDownloadFetch
    /** Fake engine; omitted means a build whose engine cannot be located. */
    aria2Download?: UpdateManagerDeps['aria2Download']
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
    checkImpl: async () => releaseInfo({ downloadSha256: options.digest ?? '' }),
    aria2Download: options.aria2Download,
    fetchImpl: (url, init) => {
      fetches += 1
      if (options.fetchImpl) return options.fetchImpl(url, init)
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

  it('throws away an installer whose contents no longer match the release', async () => {
    // The live failure: right name, right size, a few damaged bytes. Nothing but
    // the digest can tell it apart from a good file, so it was offered as
    // "verified" on every retry and refused by the installer every time.
    const damaged = makeManager({ digest: sha256(EXE_BYTES) })
    const file = path.join(damaged.dir, INSTALLER_NAME)
    const bytes = Uint8Array.from(EXE_BYTES)
    bytes[100] = 0x7a
    writeFileSync(file, bytes)

    expect((await damaged.manager.check()).pendingInstaller).toBeNull()
    // Dropped, not merely ignored: the next attempt downloads a clean copy.
    expect(existsSync(file)).toBe(false)
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

  it('accepts a download whose contents match the published check code', async () => {
    const { manager } = makeManager({ digest: sha256(EXE_BYTES) })
    await manager.check()

    expect((await manager.download()).phase).toBe('ready')
  })

  it('rejects a download that arrived the right length but the wrong bytes', async () => {
    // Byte count alone cannot see this, and the installer's own check is the last
    // link in the chain — by then it cannot re-download anything.
    const { manager } = makeManager({ digest: sha256(new TextEncoder().encode('some other build')) })
    await manager.check()

    await expect(manager.download()).rejects.toThrow(/檢查碼|損毀/)
    expect(manager.pendingInstaller).toBeNull()
    expect(manager.progress.phase).toBe('error')
  })

  it('retries once, and succeeds, when the first bytes fail the digest check', async () => {
    // A fresh release can be served a moment behind by a CDN edge: a file of
    // exactly the right length whose bytes are not the published ones. The
    // second attempt has to actually happen rather than be reported as a dead
    // end — otherwise a release is un-updatable for anyone who tries it early.
    const wrong = new TextEncoder().encode('some other build')
    let call = 0
    const { manager } = makeManager({
      digest: sha256(EXE_BYTES),
      fetchImpl: () => {
        call += 1
        const bytes = call === 1 ? wrong : EXE_BYTES
        return streamResponse(bytes, bytes.length)
      }
    })
    await manager.check()

    expect((await manager.download()).phase).toBe('ready')
    expect(call).toBe(2)
    expect(manager.pendingInstaller).not.toBeNull()
  })

  it('keeps the slot taken while a cancelled attempt is still unwinding', async () => {
    // Two attempts writing the same `.part` file means two file positions and one
    // file: the result is the right length with blocks of the wrong data in it.
    let calls = 0
    const { manager } = makeManager({
      fetchImpl: (_url, init) => {
        calls += 1
        return hangingResponse(init?.signal)
      }
    })
    await manager.check()

    const first = manager.download().catch(() => 'aborted')
    // The slot is taken just before the fetch goes out, so a call that has
    // reached the network is one whose guard is set.
    await vi.waitFor(() => expect(calls).toBe(1))
    manager.cancel()

    // Synchronously after a cancel the first write stream may still have buffered
    // chunks to flush, so a retry must not be allowed to open a second one yet.
    expect(await manager.download()).toMatchObject({ phase: 'downloading' })
    expect(calls).toBe(1)

    await first
    expect(manager.progress.phase).toBe('error')
  })
})

describe('UpdateManager.download with the bundled engine', () => {
  /** What a working engine does: put the bytes where it was told to. */
  function workingEngine(bytes: Uint8Array, calls?: { count: number }): UpdateManagerDeps['aria2Download'] {
    return async (options) => {
      if (calls) calls.count += 1
      writeFileSync(path.join(options.dir, options.out), bytes)
      options.onProgress(bytes.length)
      return { ok: true }
    }
  }

  it('fetches the installer with the engine and never goes near the network itself', async () => {
    const calls = { count: 0 }
    const { manager, dir, fetches } = makeManager({
      digest: sha256(EXE_BYTES),
      aria2Download: workingEngine(EXE_BYTES, calls)
    })
    await manager.check()

    const final = await manager.download()

    expect(final.phase).toBe('ready')
    expect(calls.count).toBe(1)
    // The engine did the transfer, so no fetch went out at all.
    expect(fetches()).toBe(0)
    expect(manager.pendingInstaller).toBe(path.join(dir, INSTALLER_NAME))
    expect(readFileSync(manager.pendingInstaller!)).toEqual(Buffer.from(EXE_BYTES))
  })

  it('reports progress while the engine downloads', async () => {
    const seen: UpdateProgress[] = []
    const { manager } = makeManager({
      digest: sha256(EXE_BYTES),
      onProgress: (progress) => seen.push(progress),
      aria2Download: workingEngine(EXE_BYTES)
    })
    await manager.check()
    await manager.download()

    expect(seen.some((progress) => progress.phase === 'downloading')).toBe(true)
  })

  it('falls back to its own download when the engine cannot run', async () => {
    const { manager, fetches } = makeManager({
      digest: sha256(EXE_BYTES),
      aria2Download: async () => ({ ok: false, unavailable: true, error: 'no aria2' })
    })
    await manager.check()

    expect((await manager.download()).phase).toBe('ready')
    expect(fetches()).toBe(1)
  })

  it('throws away what the engine produced when the bytes are not the published ones', async () => {
    // The engine verifies the checksum itself, so this is the belt-and-braces
    // check — and the one that decides whether a bad file can ever be run.
    const result = makeManager({
      digest: sha256(EXE_BYTES),
      aria2Download: workingEngine(new TextEncoder().encode('some other build'))
    })
    await result.manager.check()

    await result.manager.download()

    expect(result.logs.some((line) => line.includes('engine download failed its digest check'))).toBe(
      true
    )
    // It fell through to the fetch path rather than giving up.
    expect(result.fetches()).toBe(1)
  })

  it('does not use the engine when the release published no check code', async () => {
    // With no published digest the engine has nothing to verify against, and an
    // unverifiable 197 MB installer is precisely what must not be run.
    const calls = { count: 0 }
    const { manager } = makeManager({ aria2Download: workingEngine(EXE_BYTES, calls) })
    await manager.check()

    await manager.download()

    expect(calls.count).toBe(0)
  })

  it('claims the in-flight slot before its first await', async () => {
    // The regression: the guard was checked early but the slot was only claimed
    // after several awaits, so two quick presses could each start a download into
    // the same `.part` file — two write positions, one file.
    let calls = 0
    const { manager } = makeManager({
      digest: sha256(EXE_BYTES),
      aria2Download: (options) =>
        new Promise((resolve) => {
          calls += 1
          options.signal.addEventListener('abort', () => resolve({ ok: false, error: '已取消下載' }), {
            once: true
          })
        })
    })
    await manager.check()

    const first = manager.download().catch((error: Error) => error.message)
    await vi.waitFor(() => expect(calls).toBe(1))

    // A second press in the same window must not start a rival download.
    await manager.download()
    expect(calls).toBe(1)

    manager.cancel()
    expect(await first).toBe('已取消下載')
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

  it('throws away an installer the installer itself calls damaged', async () => {
    // NSIS exits with 2 for "Installer integrity check has failed": the file is
    // bad, which is not the same as a declined permission prompt (1223) and is
    // the one failure that can never succeed on a retry of the same bytes.
    const { manager, dir, quit } = makeManager({ child: { exitAfterMs: 0, exitCode: 2 } })
    await manager.check()
    await manager.download()
    const file = path.join(dir, INSTALLER_NAME)

    await expect(manager.install()).rejects.toThrow(/損毀/)

    expect(quit).not.toHaveBeenCalled()
    expect(manager.pendingInstaller).toBeNull()
    expect(existsSync(file)).toBe(false)
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

describe('UpdateManager.repairCache', () => {
  /** A file with the right name and length, and a few bytes of damage inside. */
  function damagedBytes(): Uint8Array {
    const bytes = Uint8Array.from(EXE_BYTES)
    bytes[100] = 0x7a
    return bytes
  }

  it('deletes an installer whose contents no longer match the release', async () => {
    // The state the UI cannot escape on its own: the length is intact, so it
    // keeps passing the name-and-size test, and every install attempt reuses the
    // same damaged bytes instead of fetching a clean copy.
    const repaired = makeManager({ digest: sha256(EXE_BYTES) })
    await repaired.manager.check()
    const file = path.join(repaired.dir, INSTALLER_NAME)
    writeFileSync(file, damagedBytes())

    const result = await repaired.manager.repairCache()

    expect(result).toMatchObject({ checked: 1, removed: 1, kept: 0 })
    expect(result.bytesFreed).toBe(EXE_BYTES.length)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps an installer that still matches', async () => {
    const repaired = makeManager({ digest: sha256(EXE_BYTES) })
    const file = path.join(repaired.dir, INSTALLER_NAME)
    writeFileSync(file, EXE_BYTES)
    await repaired.manager.check()

    const result = await repaired.manager.repairCache()

    expect(result).toMatchObject({ checked: 1, removed: 0, kept: 1, bytesFreed: 0 })
    expect(existsSync(file)).toBe(true)
    expect(repaired.manager.pendingInstaller).toBe(file)
  })

  it('stops offering an installer it had to delete', async () => {
    const repaired = makeManager({ digest: sha256(EXE_BYTES) })
    await repaired.manager.check()
    await repaired.manager.download()
    expect(repaired.manager.progress.phase).toBe('ready')

    writeFileSync(path.join(repaired.dir, INSTALLER_NAME), damagedBytes())
    await repaired.manager.repairCache()

    // "Ready" pointing at a file that is no longer there is the dead end this
    // whole repair exists to break.
    expect(repaired.manager.pendingInstaller).toBeNull()
    expect(repaired.manager.progress.phase).toBe('idle')
  })

  it('removes unfinished downloads, which no installer ever ran', async () => {
    const repaired = makeManager({ digest: sha256(EXE_BYTES) })
    await repaired.manager.check()
    const partial = path.join(repaired.dir, `${INSTALLER_NAME}.part`)
    writeFileSync(partial, EXE_BYTES)

    const result = await repaired.manager.repairCache()

    expect(result).toMatchObject({ checked: 1, removed: 1, kept: 0 })
    expect(result.bytesFreed).toBe(EXE_BYTES.length)
    expect(existsSync(partial)).toBe(false)
  })

  it('deletes nothing on a guess when no release is known yet', async () => {
    // Before the first check there is no published check code, so there is
    // nothing that could make an installer wrong.
    const repaired = makeManager()
    writeFileSync(path.join(repaired.dir, INSTALLER_NAME), EXE_BYTES)

    const result = await repaired.manager.repairCache()

    expect(result).toMatchObject({ checked: 1, removed: 0, kept: 1 })
  })

  it('reports an empty folder rather than failing', async () => {
    const repaired = makeManager()
    await repaired.manager.check()

    await expect(repaired.manager.repairCache()).resolves.toEqual({
      checked: 0,
      removed: 0,
      kept: 0,
      bytesFreed: 0
    })
  })
})
