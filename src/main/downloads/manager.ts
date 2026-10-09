import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type {
  AddDownloadInput,
  AddDownloadResult,
  HistoryPage,
  HistoryQuery,
  ItemOptionPatch,
  Settings
} from '@shared/settings'
import type {
  DownloadFileEntry,
  DownloadItem,
  EngineStatus,
  GlobalStat,
  PeerInfo,
  PieceMap,
  ServerInfo,
  TickPayload
} from '@shared/download'
import { decodeBitfield } from '@shared/download'
import { t } from '@shared/i18n'
import { detectKindFromList, fileNameFromUri, sanitizeFileName } from '@shared/uri'

import {
  buildItemOptions,
  clampMaxConnectionPerServer,
  clampSplit
} from '../aria2/options'
import type { Aria2Supervisor } from '../aria2/supervisor'
import {
  POLL_KEYS,
  type Aria2RawGlobalStat,
  type Aria2RawServer,
  type Aria2RawPeer,
  type Aria2RawStatus
} from '../aria2/types'
import type { SettingsStore } from '../settings/store'

import { categorize, categoryDirectory } from './categorizer'
import type { HistoryRecord, HistoryStore } from './history-store'
import { mapPeer, mapServer, mapToItem, toNumber } from './map-to-item'
import { SpeedMeter } from './speed-meter'
import { suggestedDownloadName } from './suggested-name'

export interface DownloadManagerHooks {
  onCompleted?: (item: DownloadItem) => void
  onFailed?: (item: DownloadItem) => void
  /** Fired on the edge where the queue goes from busy to fully idle. */
  onQueueIdle?: () => void
}

export interface DownloadManagerOptions {
  supervisor: Aria2Supervisor
  settingsStore: SettingsStore
  history: HistoryStore
  log: (line: string) => void
  hooks?: DownloadManagerHooks
  pollIntervalMs?: number
}

/** Warn when free space drops below this, but never block on it. */
const LOW_SPACE_WARNING_BYTES = 500 * 1024 * 1024

function emptyGlobalStat(): GlobalStat {
  return { downloadSpeed: 0, uploadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 0, numStoppedTotal: 0 }
}

/** The engine counters that decide whether the stopped set itself moved. */
function stoppedSignatureOf(global: Aria2RawGlobalStat | null): string {
  if (!global) return 'unknown'
  return `${toNumber(global.numStopped)}:${toNumber(global.numStoppedTotal)}`
}

/** Whether two aggregate readings say the same thing. */
function sameGlobalStat(a: GlobalStat, b: GlobalStat): boolean {
  return (
    a.downloadSpeed === b.downloadSpeed &&
    a.uploadSpeed === b.uploadSpeed &&
    a.numActive === b.numActive &&
    a.numWaiting === b.numWaiting &&
    a.numStopped === b.numStopped &&
    a.numStoppedTotal === b.numStoppedTotal
  )
}

/**
 * Whether two engine readings say the same thing.
 *
 * Every field is compared, `logTail` included: the failure banner in Settings
 * prints it, and a tick that skipped a grown log would leave that stale.
 */
function sameEngineStatus(a: EngineStatus, b: EngineStatus): boolean {
  return (
    a.state === b.state &&
    a.pid === b.pid &&
    a.port === b.port &&
    a.version === b.version &&
    a.message === b.message &&
    a.restarts === b.restarts &&
    a.lastError === b.lastError &&
    a.logTail === b.logTail &&
    a.startedAt === b.startedAt
  )
}

function mapGlobalStat(raw: Aria2RawGlobalStat | null | undefined): GlobalStat {
  if (!raw) return emptyGlobalStat()
  return {
    downloadSpeed: toNumber(raw.downloadSpeed),
    uploadSpeed: toNumber(raw.uploadSpeed),
    numActive: toNumber(raw.numActive),
    numWaiting: toNumber(raw.numWaiting),
    numStopped: toNumber(raw.numStopped),
    numStoppedTotal: toNumber(raw.numStoppedTotal)
  }
}

/**
 * Owns the live view of every download and every mutation of it.
 *
 * Design notes:
 *  - The poll loop is the source of truth. aria2 notifications are consumed only
 *    to shorten latency on discrete events, never to build state.
 *  - Download history lives in our own store, because aria2 caps its retained
 *    results and `removed` entries linger until explicitly purged.
 */
export class DownloadManager extends EventEmitter {
  private readonly supervisor: Aria2Supervisor
  private readonly settingsStore: SettingsStore
  private readonly history: HistoryStore
  private readonly log: (line: string) => void
  private readonly hooks: DownloadManagerHooks
  private readonly pollIntervalMs: number
  private readonly meter = new SpeedMeter(120)

  private items = new Map<string, DownloadItem>()
  private global: GlobalStat = emptyGlobalStat()
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private wasBusy = false

  /**
   * What the renderer was last given, so a tick can carry only what moved.
   *
   * Held by identity: an item that was not rebuilt this tick is the very same
   * object the renderer already has, so it is not sent again.
   */
  private sentItems = new Map<string, DownloadItem>()
  /** Set when the next payload has to be the whole list rather than a delta. */
  private sendFull = true
  /** The last global stat and engine status that went out, for the same reason. */
  private lastEmitted: { global: GlobalStat; engine: EngineStatus } | null = null

  /**
   * Stopped downloads, reused between ticks.
   *
   * They are terminal, so the parsed items cannot go out of date on their own —
   * and rebuilding a thousand of them every second is exactly the cost this
   * avoids. `stoppedSignature` is what tells the two kinds of change apart: the
   * engine's own counters moving (a download really did stop, or was purged) from
   * nothing happening at all.
   */
  private stoppedItems = new Map<string, DownloadItem>()
  /** Null until the first read, so the very first tick always fetches. */
  private stoppedSignature: string | null = null

  constructor(options: DownloadManagerOptions) {
    super()
    this.supervisor = options.supervisor
    this.settingsStore = options.settingsStore
    this.history = options.history
    this.log = options.log
    this.hooks = options.hooks ?? {}
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this.supervisor.on('notification', (notification: { method: string; gid: string }) => {
      // A discrete event means something changed right now; refresh promptly
      // instead of waiting for the next scheduled tick.
      if (/Complete|Error|Start|Stop|Pause/.test(notification.method)) {
        void this.tick()
      }
    })

    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs)
    this.timer.unref?.()
    // Nothing has been sent yet, so the first payload is the whole list.
    this.sendFull = true
    await this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getItems(): DownloadItem[] {
    return this.ordered()
  }

  getGlobalStat(): GlobalStat {
    return this.global
  }

  getItem(gid: string): DownloadItem | undefined {
    return this.items.get(gid)
  }

  private ordered(): DownloadItem[] {
    const all = [...this.items.values()]
    const rank = (item: DownloadItem): number => {
      switch (item.status) {
        case 'active':
          return 0
        case 'waiting':
          return 1
        case 'paused':
          return 2
        default:
          return 3
      }
    }
    return all.sort((a, b) => {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return byRank
      if (a.status === 'waiting' && b.status === 'waiting') return a.queuePosition - b.queuePosition
      return b.addedAt - a.addedAt
    })
  }

  /**
   * Hand the renderer what changed, and nothing else.
   *
   * Sending the whole queue every second meant cloning and re-rendering every
   * stopped download for as long as the app was open, which is the one part of
   * the list that cannot change. Only items rebuilt this tick are upserted, gids
   * that vanished are named, and a tick where neither happened is not sent at
   * all.
   */
  private emitTick(): void {
    const engine = this.supervisor.getStatus()

    if (this.sendFull) {
      this.sendFull = false
      this.sentItems = new Map(this.items)
      this.lastEmitted = { global: this.global, engine }
      this.emit('tick', {
        items: this.ordered(),
        removedGids: [],
        full: true,
        global: this.global,
        engine,
        at: Date.now(),
        speedSeries: this.meter.series()
      } satisfies TickPayload)
      return
    }

    const items: DownloadItem[] = []
    for (const item of this.items.values()) {
      if (this.sentItems.get(item.gid) !== item) items.push(item)
    }

    const removedGids: string[] = []
    for (const gid of this.sentItems.keys()) {
      if (!this.items.has(gid)) removedGids.push(gid)
    }

    // Nothing moved: no item was rebuilt, no download appeared or disappeared,
    // and neither the totals nor the engine state differ. A payload would carry
    // the same numbers the renderer already has.
    const quiet =
      items.length === 0 &&
      removedGids.length === 0 &&
      this.lastEmitted !== null &&
      sameGlobalStat(this.lastEmitted.global, this.global) &&
      sameEngineStatus(this.lastEmitted.engine, engine)
    if (quiet) return

    this.sentItems = new Map(this.items)
    this.lastEmitted = { global: this.global, engine }
    this.emit('tick', {
      items,
      removedGids,
      full: false,
      global: this.global,
      engine,
      at: Date.now(),
      speedSeries: this.meter.series()
    } satisfies TickPayload)
  }

  // ---- polling -------------------------------------------------------------

  private buildItem(raw: Aria2RawStatus, queuePosition: number, settings: Settings): DownloadItem {
    return mapToItem(raw, {
      meta: this.history.get(raw.gid),
      queuePosition,
      settings
    })
  }

  /**
   * Whether the stopped list has to be read again.
   *
   * `numStopped` is what aria2 is holding and `numStoppedTotal` is every stop of
   * the session, so a purge (the first drops, the second does not) and a rotation
   * past aria2's own retained cap both read as a change here. `invalidateStopped`
   * covers the remaining case: the user edited something on a stopped item.
   */
  private stoppedNeedsRefresh(global: Aria2RawGlobalStat | null): boolean {
    return this.stoppedSignature !== stoppedSignatureOf(global)
  }

  /** Force the next tick to re-read the stopped list. */
  private invalidateStopped(): void {
    this.stoppedSignature = null
  }

  async tick(): Promise<void> {
    if (this.inFlight) return
    if (!this.supervisor.isRunning) {
      this.emitTick()
      return
    }

    this.inFlight = true
    try {
      const settings = this.settingsStore.get()
      // The stopped list is deliberately not part of the poll: it is the only one
      // of the three that cannot move on its own, and it is usually the largest.
      const results = await this.supervisor.rpc.multicall([
        { method: 'aria2.tellActive', params: [POLL_KEYS] },
        { method: 'aria2.tellWaiting', params: [0, 1000, POLL_KEYS] },
        { method: 'aria2.getGlobalStat' }
      ])

      const active = (results[0] ?? []) as Aria2RawStatus[]
      const waiting = (results[1] ?? []) as Aria2RawStatus[]
      const globalRaw = results[2] as Aria2RawGlobalStat | null

      if (this.stoppedNeedsRefresh(globalRaw)) {
        const raw = await this.supervisor.rpc.call<Aria2RawStatus[]>('aria2.tellStopped', 0, 1000, POLL_KEYS)
        const rebuilt = new Map<string, DownloadItem>()
        for (const entry of raw ?? []) rebuilt.set(entry.gid, this.buildItem(entry, -1, settings))
        this.stoppedItems = rebuilt
        this.stoppedSignature = stoppedSignatureOf(globalRaw)
      }

      const previous = this.items
      const next = new Map<string, DownloadItem>()

      for (const raw of active) next.set(raw.gid, this.buildItem(raw, -1, settings))
      waiting.forEach((raw, index) => next.set(raw.gid, this.buildItem(raw, index, settings)))
      // Same objects as last tick: an unchanged stopped download stays identical
      // by reference, which is what keeps it out of the payloads below.
      for (const [gid, item] of this.stoppedItems) next.set(gid, item)

      for (const item of next.values()) {
        this.reconcile(item, previous.get(item.gid))
      }

      this.items = next
      this.global = mapGlobalStat(globalRaw)
      this.meter.push(this.global.downloadSpeed, this.global.uploadSpeed)

      // A paused download stays in aria2's waiting list, so counting the waiting
      // number would leave the queue looking busy for as long as anything is
      // parked and the idle edge would never fire. Busy means bytes are moving.
      const busy = this.global.numActive > 0
      if (this.wasBusy && !busy) this.hooks.onQueueIdle?.()
      this.wasBusy = busy
    } catch (error) {
      // A failed poll is expected during a restart; surface it but keep looping.
      this.log(`poll failed: ${(error as Error).message}`)
    } finally {
      this.inFlight = false
      this.emitTick()
    }
  }

  /**
   * Keep our history record in step with the live item, and fire completion
   * hooks on status edges only.
   */
  private reconcile(item: DownloadItem, previous: DownloadItem | undefined): void {
    const record = this.history.get(item.gid)
    if (record) {
      const patch: Partial<HistoryRecord> = {}
      if (item.name && record.name !== item.name) patch.name = item.name
      if (record.totalLength !== item.totalLength) patch.totalLength = item.totalLength
      if (record.status !== item.status) patch.status = item.status
      if (item.dir && record.dir !== item.dir) patch.dir = item.dir
      if (item.errorCode !== record.errorCode) patch.errorCode = item.errorCode
      if (item.errorMessage !== record.errorMessage) patch.errorMessage = item.errorMessage
      if (Object.keys(patch).length > 0) this.history.patchDeferred(item.gid, patch)
    }

    if (previous && previous.status === item.status) return

    if (item.status === 'complete') {
      item.completedAt = item.completedAt ?? Date.now()
      this.history.patchDeferred(item.gid, { completedAt: item.completedAt })
      this.hooks.onCompleted?.(item)
    } else if (item.status === 'error') {
      this.hooks.onFailed?.(item)
    }
  }

  // ---- commands ------------------------------------------------------------

  async add(input: AddDownloadInput): Promise<AddDownloadResult> {
    const settings = this.settingsStore.get()
    const rpc = this.supervisor.rpc
    const warnings: string[] = []

    const uris = input.uris.map((uri) => uri.trim()).filter((uri) => uri.length > 0)
    if (uris.length === 0 && !input.torrentBase64 && !input.metalinkBase64) {
      throw new Error(t('main.download.noUris'))
    }

    const kind: 'http' | 'ftp' | 'bittorrent' | 'metalink' = input.torrentBase64
      ? 'bittorrent'
      : input.metalinkBase64
        ? 'metalink'
        : detectKindFromList(uris)

    // Duplicate detection against anything still in flight. Completed history is
    // deliberately not treated as a duplicate, because re-downloading a file you
    // already have is a normal thing to want.
    const duplicates: AddDownloadResult['duplicates'] = []
    const fresh: string[] = []
    for (const uri of uris) {
      const existing = this.history.findByUri(uri)
      const stillRunning =
        existing && (existing.status === 'active' || existing.status === 'waiting' || existing.status === 'paused')
      if (stillRunning && !input.allowDuplicate) {
        duplicates.push({ uri, existingGid: existing.gid, name: existing.name })
      } else {
        fresh.push(uri)
      }
    }

    if (fresh.length === 0 && duplicates.length > 0 && !input.torrentBase64 && !input.metalinkBase64) {
      return { gids: [], duplicates, warnings }
    }

    const suggestedName = suggestedDownloadName(
      { out: input.out, torrentBase64: input.torrentBase64 },
      fresh
    )

    const category =
      input.category && input.category.length > 0
        ? input.category
        : categorize(suggestedName, settings.categories)

    const dir = input.dir && input.dir.length > 0
      ? input.dir
      : categoryDirectory(settings.categories, category, settings.downloadDir)

    await this.ensureDirectory(dir)

    const space = await this.checkDiskSpace(dir)
    if (space.warning) warnings.push(space.warning)

    const options = buildItemOptions({
      input: { ...input, out: input.out ? sanitizeFileName(input.out) : '' },
      settings,
      kind
    })
    options.dir = dir

    let gids: string[] = []
    if (input.torrentBase64) {
      const gid = await rpc.addTorrent(input.torrentBase64, fresh, options)
      gids = [gid]
    } else if (input.metalinkBase64) {
      gids = await rpc.addMetalink(input.metalinkBase64, options)
    } else {
      const gid = await rpc.addUri(fresh, options)
      gids = [gid]
    }

    const now = Date.now()
    for (const gid of gids) {
      const record: HistoryRecord = {
        gid,
        name: suggestedName,
        dir,
        category,
        tags: input.tags ?? [],
        kind,
        engine: input.engine === 'ytdlp' ? 'ytdlp' : 'aria2',
        uris: fresh,
        totalLength: 0,
        addedAt: now,
        completedAt: null,
        source: input.source,
        status: input.paused ? 'paused' : 'active',
        mediaFormat: null,
        errorCode: 0,
        errorMessage: '',
        maxDownloadLimit: input.maxDownloadLimit,
        split: input.split,
        maxConnectionPerServer: input.maxConnectionPerServer,
        minSplitSize: input.minSplitSize,
        referer: input.referer,
        userAgent: input.userAgent,
        cookieHeader: input.cookieHeader,
        headers: input.headers ?? [],
        username: input.username,
        password: input.password,
        proxy: input.proxy,
        pausedQueued: input.paused,
        postActionState: 'idle',
        notified: false
      }
      this.history.upsert(record)
    }

    // Persist before refreshing so a crash right after adding still leaves the
    // record on disk.
    await this.history.flush()
    await this.tick()
    return { gids, duplicates, warnings }
  }

  async pause(gids: string[]): Promise<void> {
    for (const gid of gids) {
      try {
        await this.supervisor.rpc.pause(gid)
      } catch (error) {
        this.log(`pause ${gid} failed: ${(error as Error).message}`)
      }
    }
    await this.tick()
  }

  async resume(gids: string[]): Promise<void> {
    for (const gid of gids) {
      try {
        await this.supervisor.rpc.unpause(gid)
      } catch (error) {
        this.log(`resume ${gid} failed: ${(error as Error).message}`)
      }
    }
    await this.tick()
  }

  async pauseAll(): Promise<void> {
    try {
      await this.supervisor.rpc.pauseAll()
    } catch (error) {
      this.log(`pauseAll failed: ${(error as Error).message}`)
    }
    await this.tick()
  }

  async resumeAll(): Promise<void> {
    try {
      await this.supervisor.rpc.unpauseAll()
    } catch (error) {
      this.log(`resumeAll failed: ${(error as Error).message}`)
    }
    await this.tick()
  }

  async remove(gids: string[], deleteFiles: boolean): Promise<void> {
    for (const gid of gids) {
      const item = this.items.get(gid)
      // forceRemove handles active downloads; remove covers queued and paused.
      try {
        await this.supervisor.rpc.forceRemove(gid)
      } catch {
        try {
          await this.supervisor.rpc.remove(gid)
        } catch (error) {
          this.log(`remove ${gid} failed: ${(error as Error).message}`)
        }
      }
      // A removed download stays in the stopped list until acknowledged, which
      // is why this second call is required rather than optional.
      await this.purgeResult(gid)

      if (deleteFiles && item) await this.deleteDownloadedFiles(item)
    }

    this.history.remove(gids)
    await this.tick()
  }

  private async purgeResult(gid: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.supervisor.rpc.removeDownloadResult(gid)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    }
  }

  /**
   * Delete only the exact paths aria2 reported, plus their .aria2 control files.
   * Refuses anything without a real parent directory so a malformed path can
   * never turn into a delete of a drive root.
   */
  private async deleteDownloadedFiles(item: DownloadItem): Promise<void> {
    const targets = new Set<string>()
    for (const file of item.files) {
      if (!file.path) continue
      targets.add(file.path)
      targets.add(`${file.path}.aria2`)
    }

    for (const target of targets) {
      const parsed = path.parse(target)
      if (!parsed.dir || parsed.dir === parsed.root || parsed.base.length === 0) continue
      try {
        await fsp.rm(target, { force: true })
      } catch (error) {
        this.log(`failed to delete ${target}: ${(error as Error).message}`)
      }
    }
  }

  async move(gid: string, position: number): Promise<void> {
    try {
      await this.supervisor.rpc.changePosition(gid, position, 'POS_SET')
    } catch (error) {
      this.log(`move ${gid} failed: ${(error as Error).message}`)
    }
    await this.tick()
  }

  /**
   * aria2 only accepts option changes on downloads that have not started, so an
   * active item is paused, patched and resumed. The UI disables these fields for
   * completed items rather than letting the call fail silently.
   */
  async changeOptions(gid: string, patch: ItemOptionPatch): Promise<void> {
    const item = this.items.get(gid)
    const options: Record<string, string> = {}

    if (patch.maxDownloadLimit !== undefined) {
      options['max-download-limit'] = String(Math.max(0, Math.floor(patch.maxDownloadLimit)))
    }
    // Clamped for the same reason as the daemon arguments: aria2 rejects an
    // out-of-range connection count outright, so a bad value here would surface
    // as a failed edit rather than a rejected one.
    if (patch.split !== undefined) options.split = String(clampSplit(patch.split))
    if (patch.maxConnectionPerServer !== undefined) {
      options['max-connection-per-server'] = String(clampMaxConnectionPerServer(patch.maxConnectionPerServer))
    }
    if (patch.referer !== undefined) options.referer = patch.referer
    if (patch.userAgent !== undefined) options['user-agent'] = patch.userAgent
    if (patch.out !== undefined && patch.out.length > 0) options.out = sanitizeFileName(patch.out)
    if (patch.dir !== undefined && patch.dir.length > 0) options.dir = patch.dir

    if (Object.keys(options).length === 0) return

    const wasActive = item?.status === 'active'
    if (wasActive) {
      try {
        await this.supervisor.rpc.pause(gid)
      } catch {
        // If it finished between the check and the pause, patching may still work.
      }
    }

    try {
      await this.supervisor.rpc.changeOption(gid, options)
    } catch (error) {
      this.log(`changeOption ${gid} failed: ${(error as Error).message}`)
      throw error
    } finally {
      if (wasActive) {
        try {
          await this.supervisor.rpc.unpause(gid)
        } catch {
          // Already complete; nothing to resume.
        }
      }
    }

    const recordPatch: Partial<HistoryRecord> = {}
    if (patch.maxDownloadLimit !== undefined) recordPatch.maxDownloadLimit = patch.maxDownloadLimit
    if (patch.split !== undefined) recordPatch.split = patch.split
    if (patch.maxConnectionPerServer !== undefined) {
      recordPatch.maxConnectionPerServer = patch.maxConnectionPerServer
    }
    if (patch.referer !== undefined) recordPatch.referer = patch.referer
    if (patch.userAgent !== undefined) recordPatch.userAgent = patch.userAgent
    if (patch.dir !== undefined) recordPatch.dir = patch.dir
    if (Object.keys(recordPatch).length > 0) this.history.patchDeferred(gid, recordPatch)

    // A stopped item is cached by reference, so an edit to one has to be visible
    // on the next tick rather than whenever that item happens to be rebuilt.
    if (item && item.status !== 'active' && item.status !== 'waiting') this.invalidateStopped()

    await this.tick()
  }

  /** Re-add failed or completed downloads using their original options. */
  async retry(gids: string[]): Promise<AddDownloadResult> {
    const settings = this.settingsStore.get()
    const combined: AddDownloadResult = { gids: [], duplicates: [], warnings: [] }

    for (const gid of gids) {
      const record = this.history.get(gid)
      if (!record) continue
      if (record.uris.length === 0) {
        combined.warnings.push(t('main.retry.noSources', { name: record.name || gid }))
        continue
      }
      try {
        const result = await this.add({
          uris: record.uris,
          out: record.kind === 'http' || record.kind === 'ftp' ? record.name : '',
          dir: record.dir || settings.downloadDir,
          split: record.split,
          maxConnectionPerServer: record.maxConnectionPerServer,
          minSplitSize: record.minSplitSize,
          maxDownloadLimit: record.maxDownloadLimit,
          referer: record.referer,
          userAgent: record.userAgent,
          cookieHeader: record.cookieHeader,
          headers: record.headers,
          username: record.username,
          password: record.password,
          proxy: record.proxy,
          paused: record.pausedQueued,
          seedRatio: settings.seedRatio,
          seedTime: settings.seedTime,
          selectFileIndices: [],
          category: record.category,
          tags: record.tags,
          source: 'retry',
          torrentBase64: null,
          metalinkBase64: null,
          allowDuplicate: true,
          engine: record.engine
        })
        combined.gids.push(...result.gids)
        combined.duplicates.push(...result.duplicates)
        combined.warnings.push(...result.warnings)
      } catch (error) {
        combined.warnings.push(t('main.retry.failed', { reason: (error as Error).message }))
      }
    }

    return combined
  }

  /**
   * Clear finished downloads from the live list. Their history records survive,
   * so the History view still knows about them: this matches how IDM behaves.
   */
  async clearCompleted(): Promise<void> {
    try {
      await this.supervisor.rpc.purgeDownloadResult()
    } catch (error) {
      this.log(`purgeDownloadResult failed: ${(error as Error).message}`)
    }
    await this.tick()
  }

  // ---- detail lookups ------------------------------------------------------

  async getFiles(gid: string): Promise<DownloadFileEntry[]> {
    const item = this.items.get(gid)
    if (item && item.files.length > 0) return item.files
    try {
      const raw = await this.supervisor.rpc.getFiles(gid)
      return (raw as unknown as Aria2RawStatus['files']).map((file) => {
        const filePath = file.path ?? ''
        return {
          index: toNumber(file.index),
          path: filePath,
          name: path.basename(filePath.replace(/\\/g, '/')),
          length: toNumber(file.length),
          completedLength: toNumber(file.completedLength),
          selected: file.selected === 'true',
          uris: (file.uris ?? []).map((uri) => ({ uri: uri.uri, status: uri.status }))
        }
      })
    } catch {
      return []
    }
  }

  async getServers(gid: string): Promise<ServerInfo[]> {
    try {
      const raw = await this.supervisor.rpc.getServers(gid)
      return (raw as unknown as Aria2RawServer[]).map(mapServer)
    } catch {
      return []
    }
  }

  /**
   * The piece map for one download.
   *
   * Fetched on demand rather than polled: the bitfield is proportional to the
   * piece count, so a large torrent would otherwise bloat every single tick.
   * Returns null when aria2 has no bitfield for the item, which is the case
   * before a download starts and for engine-managed media jobs.
   */
  async getPieces(gid: string): Promise<PieceMap | null> {
    if (!this.supervisor.isRunning) return null
    try {
      interface PieceStatus {
        bitfield?: string
        numPieces?: string
        pieceLength?: string
      }
      const raw = await this.supervisor.rpc.call<PieceStatus>('aria2.tellStatus', gid, [
        'bitfield',
        'numPieces',
        'pieceLength'
      ])
      const bitfield = typeof raw.bitfield === 'string' ? raw.bitfield : ''
      const numPieces = toNumber(raw.numPieces)
      if (!bitfield || numPieces <= 0) return null

      const pieces = decodeBitfield(bitfield, numPieces)
      return {
        numPieces,
        pieceLength: toNumber(raw.pieceLength),
        completedPieces: pieces.filter(Boolean).length,
        pieces,
        bitfield
      }
    } catch {
      return null
    }
  }

  async getPeers(gid: string): Promise<PeerInfo[]> {
    try {
      const raw = await this.supervisor.rpc.getPeers(gid)
      return (raw as unknown as Aria2RawPeer[]).map(mapPeer)
    } catch {
      return []
    }
  }

  async getOptions(gid: string): Promise<Record<string, string>> {
    try {
      return await this.supervisor.rpc.getOption(gid)
    } catch {
      return {}
    }
  }

  // ---- history -------------------------------------------------------------

  queryHistory(query: HistoryQuery): HistoryPage {
    return this.history.query(query)
  }

  deleteHistory(gids: string[]): void {
    this.history.remove(gids)
  }

  clearHistory(): void {
    this.history.clear()
  }

  markCompletedHandled(gid: string): void {
    this.history.patchDeferred(gid, { notified: true })
  }

  setPostActionState(gid: string, state: HistoryRecord['postActionState']): void {
    this.history.patchDeferred(gid, { postActionState: state })
  }

  // ---- helpers -------------------------------------------------------------

  private async ensureDirectory(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch (error) {
      throw new Error(t('main.dir.createFailed', { dir, reason: (error as Error).message }))
    }
  }

  /**
   * Report free space. Size is intentionally not compared here because the real
   * size is unknown until aria2 has the response headers (and is unknowable for
   * a magnet link); a precise shortfall surfaces later as aria2 error code 9.
   */
  private async checkDiskSpace(dir: string): Promise<{ warning: string | null; available: number }> {
    try {
      const stats = await fsp.statfs(dir)
      const available = Number(stats.bavail) * Number(stats.bsize)
      if (available > 0 && available < LOW_SPACE_WARNING_BYTES) {
        return {
          warning: t('main.space.low', { dir, mb: Math.round(available / 1024 / 1024) }),
          available
        }
      }
      return { warning: null, available }
    } catch {
      // statfs is unavailable on some filesystems; not worth failing over.
      return { warning: null, available: 0 }
    }
  }

  /** Snapshot used for populating the Add dialog's filename preview. */
  suggestFileName(uri: string): string {
    return fileNameFromUri(uri)
  }

  get speedSeries(): { at: number; download: number; upload: number }[] {
    return this.meter.series()
  }

  get peakSpeed(): number {
    return this.meter.peakDownload
  }
}
