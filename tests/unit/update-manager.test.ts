import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { UpdateInfo, UpdateProgress } from '../../src/shared/ipc'
import { UpdateManager, type UpdateDownloadFetch } from '../../src/main/update/update-manager'

const EXE_BYTES = new TextEncoder().encode('MZ' + 'x'.repeat(2046))

function releaseInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: '0.1.0',
    latest: '0.2.0',
    available: true,
    releaseUrl: 'https://example.test/release',
    downloadUrl: 'https://example.test/AriaDM-0.2.0-setup.exe',
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

function makeManager(options: {
  bytes?: Uint8Array
  contentLength?: number
  canInstall?: boolean
  onProgress?: (progress: UpdateProgress) => void
} = {}): {
  manager: UpdateManager
  dir: string
  spawned: { file: string; args: string[] }[]
  quit: ReturnType<typeof vi.fn>
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ariadm-update-'))
  const bytes = options.bytes ?? EXE_BYTES
  const spawned: { file: string; args: string[] }[] = []
  const quit = vi.fn()

  const manager = new UpdateManager({
    currentVersion: () => '0.1.0',
    installerDir: () => dir,
    canInstall: () => options.canInstall ?? true,
    onProgress: options.onProgress ?? (() => {}),
    requestQuit: quit,
    log: () => {},
    checkImpl: async () => releaseInfo(),
    fetchImpl: () => streamResponse(bytes, options.contentLength ?? bytes.length),
    spawnImpl: (file, args) => {
      spawned.push({ file, args })
      return { unref: () => {} }
    }
  })

  return { manager, dir, spawned, quit }
}

describe('UpdateManager.check', () => {
  it('marks the update installable only when the build supports it', async () => {
    const supported = makeManager({ canInstall: true }).manager
    expect((await supported.check()).canInstall).toBe(true)

    const portable = makeManager({ canInstall: false }).manager
    expect((await portable.check()).canInstall).toBe(false)
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
    expect(manager.pendingInstaller).toBe(path.join(dir, 'AriaDM-0.2.0-setup.exe'))
    expect(readFileSync(manager.pendingInstaller!)).toEqual(Buffer.from(EXE_BYTES))
    // Progress was reported while downloading, not only at the end.
    expect(seen.some((progress) => progress.phase === 'downloading')).toBe(true)
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
  it('launches the installer silently and only after a download', async () => {
    const { manager, spawned } = makeManager()
    await manager.check()

    expect(() => manager.install()).toThrow()

    await manager.download()
    manager.install()
    // `launchInstaller` is what the shutdown path calls once state is flushed.
    manager.launchInstaller()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.args).toEqual(['/S', '--updated', '--force-run'])
    expect(manager.pendingInstaller).toBeNull()
  })

  it('asks the app to shut down when an install is requested', async () => {
    const { manager, quit } = makeManager()
    await manager.check()
    await manager.download()

    manager.install()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
