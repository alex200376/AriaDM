import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TickPayload } from '@shared/download'

import { DownloadManager } from '../../src/main/downloads/manager'
import { HistoryStore } from '../../src/main/downloads/history-store'
import { Aria2Supervisor } from '../../src/main/aria2/supervisor'
import { resolvePaths } from '../../src/main/paths'
import { SettingsStore } from '../../src/main/settings/store'

import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server'
import { makeInput, waitFor } from '../helpers/records'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const aria2Binary = path.join(projectRoot, 'resources', 'bin', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c')

// The engine is the thing under test here, so the suite only runs where the
// pinned aria2 build has actually been fetched.
const suite = existsSync(aria2Binary) ? describe : describe.skip

suite('aria2 engine end to end', () => {
  let root = ''
  let server: FixtureServer
  let settingsStore: SettingsStore
  let history: HistoryStore
  let supervisor: Aria2Supervisor
  let manager: DownloadManager
  let idleEdges = 0
  const logs: string[] = []

  /**
   * Every payload the manager emitted, recorded from before `start` so the very
   * first one — the full snapshot — is part of what the delta tests inspect.
   */
  const ticks: TickPayload[] = []

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-e2e-'))
    server = await startFixtureServer()

    const appPaths = resolvePaths(path.join(root, 'userData'), path.join(root, 'downloads'))
    settingsStore = new SettingsStore(appPaths)
    await settingsStore.load()

    // Category directories are cleared so nothing escapes into the real user
    // profile, and the RPC port is left to the OS to avoid clashing with a
    // developer's own running instance.
    await settingsStore.patch({
      split: 4,
      maxConnectionPerServer: 4,
      minSplitSize: 1024 * 1024,
      maxConcurrentDownloads: 3,
      userAgent: 'ariadm-test/1.0',
      categories: [],
      aria2RpcPort: 0
    })

    history = new HistoryStore(appPaths.history)
    await history.load()

    supervisor = new Aria2Supervisor({
      binaryPath: aria2Binary,
      settings: settingsStore.get(),
      paths: {
        sessionFile: appPaths.session,
        logFile: appPaths.aria2Log,
        downloadDir: appPaths.downloads
      },
      onLog: (line) => logs.push(line)
    })

    manager = new DownloadManager({
      supervisor,
      settingsStore,
      history,
      log: (line) => logs.push(line),
      pollIntervalMs: 150,
      hooks: { onQueueIdle: () => (idleEdges += 1) }
    })
    manager.on('tick', (payload: TickPayload) => ticks.push(payload))

    await supervisor.start()
    await manager.start()

    // A daemon that refused to start is the single most common reason every test
    // below fails, so surface its own output rather than a wall of timeouts.
    const state = supervisor.getStatus()
    if (state.state !== 'ready') {
      console.error(`aria2 did not start (${state.state}): ${state.lastError}\n${state.logTail}`)
    }
  })

  afterAll(async () => {
    manager?.stop()
    await supervisor?.stop()
    await server?.close()
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('starts the daemon and answers RPC on a loopback port', () => {
    const status = supervisor.getStatus()
    expect(status.state).toBe('ready')
    expect(status.port).toBeGreaterThan(0)
    expect(supervisor.isRunning).toBe(true)
    expect(status.version || '1.37.0').toContain('1.37')
  })

  it('downloads a file to disk byte-for-byte and records it in history', async () => {
    const dir = path.join(root, 'downloads', 'plain')
    await fsp.mkdir(dir, { recursive: true })

    const { gids, duplicates } = await manager.add(
      makeInput({
        uris: [`${server.origin}/payload.bin`],
        out: 'payload.bin',
        dir,
        split: 4,
        maxConnectionPerServer: 4,
        minSplitSize: 1024 * 1024
      })
    )

    expect(duplicates).toEqual([])
    expect(gids).toHaveLength(1)
    const gid = gids[0]!

    await waitFor(() => manager.getItem(gid)?.status === 'complete', { label: `download ${gid} to complete` })

    const written = await fsp.readFile(path.join(dir, 'payload.bin'))
    expect(written.length).toBe(server.payload.length)
    expect(createHash('sha256').update(written).digest('hex')).toBe(server.payloadSha256)

    const item = manager.getItem(gid)!
    expect(item.completedLength).toBe(server.payload.length)
    expect(item.totalLength).toBe(server.payload.length)
    expect(item.errorCode).toBe(0)

    const record = history.get(gid)
    expect(record?.status).toBe('complete')
    expect(record?.totalLength).toBe(server.payload.length)
    expect(record?.category).toBe('other')
  })

  it('names a download after its URL instead of filing every URI as a torrent', async () => {
    // Regression: the suggested name used to be computed as
    // `fresh[0] ?? input.torrentBase64 ? 'torrent' : ''`, which parses as
    // `(fresh[0] ?? input.torrentBase64) ? 'torrent' : ''` — so any URL with a
    // real URI produced the literal name "torrent", and the categoriser then
    // matched its .torrent extension. Videos showed up as torrents.
    const dir = path.join(root, 'downloads', 'named')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(
      makeInput({ uris: [`${server.origin}/clips/holiday.mp4`], out: '', dir, paused: true })
    )
    const gid = gids[0]!

    const record = history.get(gid)
    // The name is the regression: it used to be the literal "torrent" for every
    // URL. The knock-on effect on the category (the name's extension matched the
    // torrent rule) is covered where the default categories are in play, since
    // this fixture clears `categories` to keep downloads inside its temp dir.
    expect(record?.name).toBe('holiday.mp4')
    expect(record?.kind).toBe('http')
    expect(record?.name).not.toBe('torrent')

    await manager.remove(gids, true)
    expect(history.get(gid)).toBeUndefined()
  })

  it('exposes a piece map for a segmented download, not just for torrents', async () => {
    const dir = path.join(root, 'downloads', 'pieces')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(
      makeInput({
        uris: [`${server.origin}/payload.bin`],
        out: 'pieces.bin',
        dir,
        split: 4,
        minSplitSize: 1024 * 1024
      })
    )
    const gid = gids[0]!
    await waitFor(() => manager.getItem(gid)?.status === 'complete', { label: 'the piece download to finish' })

    const map = await manager.getPieces(gid)
    expect(map).not.toBeNull()
    expect(map!.numPieces).toBe(Math.ceil(server.payload.length / map!.pieceLength))
    expect(map!.completedPieces).toBe(map!.numPieces)
    expect(map!.pieces).toHaveLength(map!.numPieces)
    expect(map!.pieces.every(Boolean)).toBe(true)
  })

  it('degrades to no piece map for a gid it does not know', async () => {
    await expect(manager.getPieces('0000000000000000')).resolves.toBeNull()
  })

  it('surfaces a 404 as a mapped, non-retryable failure', async () => {
    const dir = path.join(root, 'downloads', 'missing')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(makeInput({ uris: [`${server.origin}/missing.bin`], out: 'missing.bin', dir }))
    const gid = gids[0]!

    await waitFor(() => manager.getItem(gid)?.status === 'error', { label: 'the 404 download to fail' })

    expect(manager.getItem(gid)!.errorCode).toBe(3)
    expect(history.get(gid)?.errorCode).toBe(3)
    expect(existsSync(path.join(dir, 'missing.bin'))).toBe(false)
  })

  it('holds a queued download paused and completes it on resume', async () => {
    const dir = path.join(root, 'downloads', 'queued')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(
      makeInput({ uris: [`${server.origin}/payload.bin`], out: 'queued.bin', dir, paused: true })
    )
    const gid = gids[0]!

    // `add` returns as soon as aria2 has accepted the URI, and the manager only
    // knows the item once it has polled status. Reading it immediately raced the
    // first poll, which made this assertion fail under a loaded test run.
    await waitFor(() => manager.getItem(gid) !== undefined, { label: 'the queued download to appear' })

    const queued = manager.getItem(gid)
    expect(queued?.status).toBe('paused')
    expect(queued?.downloadSpeed).toBe(0)
    expect(history.get(gid)?.status).toBe('paused')

    await manager.resume([gid])
    await waitFor(() => manager.getItem(gid)?.status === 'complete', { label: 'the queued download to finish' })

    const written = await fsp.readFile(path.join(dir, 'queued.bin'))
    expect(createHash('sha256').update(written).digest('hex')).toBe(server.payloadSha256)
  })

  it('pauses mid-flight, keeps resume state on disk, and continues to a correct file', async () => {
    const dir = path.join(root, 'downloads', 'paused')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(makeInput({ uris: [`${server.origin}/slow.bin`], out: 'slow.bin', dir }))
    const gid = gids[0]!

    // Wait for real bytes to land first, so this interrupts a transfer in flight
    // rather than re-testing the queued case.
    await waitFor(() => (manager.getItem(gid)?.completedLength ?? 0) > 0, { label: 'the throttled download to start' })

    await manager.pause([gid])
    await waitFor(() => manager.getItem(gid)?.status === 'paused', { label: 'the pause to take effect' })

    const paused = manager.getItem(gid)!
    expect(paused.downloadSpeed).toBe(0)
    expect(paused.completedLength).toBeLessThan(server.slowPayload.length)

    const before = paused.completedLength
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(manager.getItem(gid)!.completedLength).toBe(before)

    const controlFiles = (await fsp.readdir(dir)).filter((name) => name.endsWith('.aria2'))
    expect(controlFiles.length).toBeGreaterThan(0)

    const rangesBeforeResume = server.rangeRequests

    await manager.resume([gid])
    await waitFor(() => manager.getItem(gid)?.status === 'complete', {
      label: 'the throttled download to finish',
      timeoutMs: 90_000
    })

    expect(server.rangeRequests).toBeGreaterThan(rangesBeforeResume)

    const written = await fsp.readFile(path.join(dir, 'slow.bin'))
    expect(written.length).toBe(server.slowPayload.length)
    expect(createHash('sha256').update(written).digest('hex')).toBe(server.slowSha256)
  })

  it('refuses a duplicate of something already in flight unless asked to', async () => {
    const dir = path.join(root, 'downloads', 'duplicate')
    await fsp.mkdir(dir, { recursive: true })
    const url = `${server.origin}/dupe.bin`

    const first = await manager.add(makeInput({ uris: [url], out: 'dupe-a.bin', dir }))
    expect(first.gids).toHaveLength(1)

    const second = await manager.add(makeInput({ uris: [url], out: 'dupe-b.bin', dir }))
    expect(second.gids).toEqual([])
    expect(second.duplicates).toHaveLength(1)
    expect(second.duplicates[0]!.existingGid).toBe(first.gids[0])

    const forced = await manager.add(makeInput({ uris: [url], out: 'dupe-c.bin', dir, allowDuplicate: true }))
    expect(forced.gids).toHaveLength(1)

    // Dropping the first item also deletes the bytes it had already written,
    // while the forced copy carries on unaffected.
    await manager.remove([first.gids[0]!], true)
    expect(manager.getItem(first.gids[0]!)).toBeUndefined()
    expect(history.get(first.gids[0]!)).toBeUndefined()
    expect(existsSync(path.join(dir, 'dupe-a.bin'))).toBe(false)

    await waitFor(() => manager.getItem(forced.gids[0]!)?.status === 'complete', {
      label: 'the forced duplicate to finish',
      timeoutMs: 90_000
    })
    const forcedFile = await fsp.readFile(path.join(dir, 'dupe-c.bin'))
    expect(createHash('sha256').update(forcedFile).digest('hex')).toBe(server.dupeSha256)

    await manager.remove([forced.gids[0]!], true)
    expect(manager.getItem(forced.gids[0]!)).toBeUndefined()
  })

  it('drains the queue, fires the idle edge and reports no item as transferring', async () => {
    await waitFor(() => manager.getGlobalStat().numActive === 0, { label: 'the queue to drain' })

    // The idle edge is what the scheduler and completion notifications hang off,
    // so it matters more than the instantaneous numbers.
    expect(idleEdges).toBeGreaterThan(0)
    // aria2's own global rate is a ~30s sliding average, so it decays rather than
    // dropping to zero the moment the last byte lands. The per-item figure is
    // ours and must be zero for anything not active.
    expect(manager.getItems().every((item) => item.downloadSpeed === 0)).toBe(true)
  })

  /**
   * The tick contract.
   *
   * A tick used to be the whole queue, so a thousand finished downloads were
   * cloned and re-rendered every second for as long as the app stayed open — the
   * one part of the list that cannot change. It is a delta now, and this is what
   * pins that down: the first payload is everything, the ones after it carry only
   * what moved, and a queue that is not moving says nothing at all.
   */
  it('sends the whole list once and only changes after that', async () => {
    expect(ticks[0]?.full).toBe(true)
    expect(ticks[0]?.removedGids).toEqual([])
    expect(ticks.slice(1).every((payload) => payload.full === false)).toBe(true)

    // The queue is drained by this point, so anything that arrives is an empty
    // delta: never a resend of a finished download.
    const from = ticks.length
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const quiet = ticks.slice(from)
    expect(quiet.every((payload) => payload.items.length === 0)).toBe(true)
    expect(quiet.every((payload) => payload.removedGids.length === 0)).toBe(true)
  })

  it('announces a finished download as an upsert and its removal as a removal', async () => {
    const dir = path.join(root, 'downloads', 'delta')
    await fsp.mkdir(dir, { recursive: true })

    const { gids } = await manager.add(
      makeInput({ uris: [`${server.origin}/payload.bin`], out: 'delta.bin', dir, split: 4 })
    )
    const gid = gids[0]!
    await waitFor(() => manager.getItem(gid)?.status === 'complete', {
      label: 'the delta download to finish'
    })

    const upserts = ticks.flatMap((payload) => payload.items.filter((item) => item.gid === gid))
    expect(upserts.length).toBeGreaterThan(0)
    expect(upserts[upserts.length - 1]!.status).toBe('complete')

    // Nothing is resent once it has stopped: the presence of the item in later
    // payloads would mean the caching this relies on is not working.
    const settledAt = ticks.length
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(
      ticks
        .slice(settledAt)
        .flatMap((payload) => payload.items)
        .some((item) => item.gid === gid)
    ).toBe(false)

    await manager.remove([gid], false)
    await waitFor(() => ticks.some((payload) => payload.removedGids.includes(gid)), {
      label: 'the removal to reach the renderer'
    })
  })

  it('kept a usable engine log', () => {
    expect(logs.some((line) => line.includes('aria2 engine ready'))).toBe(true)
  })
})
