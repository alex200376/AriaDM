import type { HistoryPage, HistoryQuery, HistoryRow } from '@shared/download'

import { JsonStore } from '../store/json-store'

/**
 * Everything we need to remember about a download that aria2 does not.
 *
 * This exists because aria2 caps and purges its own retained results
 * (`--max-download-result`, and `removed` entries linger until explicitly
 * cleared). Keeping our own record means history is complete and stable, and it
 * is also what lets a retry re-apply the original options.
 */
export interface HistoryRecord extends HistoryRow {
  // Options carried forward so a retry or a restart behaves identically.
  // Note: aria2's own session file stores these in plain text too, so this is
  // consistent with how the engine already works.
  maxDownloadLimit: number
  split: number
  maxConnectionPerServer: number
  minSplitSize: number
  referer: string
  userAgent: string
  cookieHeader: string
  headers: string[]
  username: string
  password: string
  proxy: string
  pausedQueued: boolean
}

interface HistoryDocument {
  records: Record<string, HistoryRecord>
}

const MAX_RECORDS = 5000

export class HistoryStore {
  private readonly store: JsonStore<HistoryDocument>

  constructor(filePath: string) {
    this.store = new JsonStore<HistoryDocument>(filePath, { records: {} })
  }

  async load(): Promise<void> {
    await this.store.load()
  }

  private get records(): Record<string, HistoryRecord> {
    return this.store.get().records
  }

  get(gid: string): HistoryRecord | undefined {
    return this.records[gid]
  }

  all(): HistoryRecord[] {
    return Object.values(this.records)
  }

  count(): number {
    return Object.keys(this.records).length
  }

  upsert(record: HistoryRecord): void {
    this.records[record.gid] = record
    this.store.scheduleSave()
    this.pruneIfNeeded()
  }

  /**
   * Debounced variant used by the poller, which touches records on every tick.
   * Mutates in place and lets the store coalesce the write.
   */
  patchDeferred(gid: string, patch: Partial<HistoryRecord>): void {
    const existing = this.records[gid]
    if (!existing) return
    this.store.get().records[gid] = { ...existing, ...patch }
    this.store.scheduleSave()
  }

  /**
   * Deletions mutate the live document in place rather than going through
   * `patch`: patching deep-merges, and a merge cannot express the removal of a
   * key, so a patched deletion would silently leave the record in place.
   */
  remove(gids: string[]): void {
    const records = this.records
    let changed = false
    for (const gid of gids) {
      if (gid in records) {
        delete records[gid]
        changed = true
      }
    }
    if (changed) this.store.scheduleSave()
  }

  clear(): void {
    const records = this.records
    const keys = Object.keys(records)
    if (keys.length === 0) return
    for (const key of keys) delete records[key]
    this.store.scheduleSave()
  }

  findByUri(uri: string): HistoryRecord | undefined {
    const needle = uri.trim()
    return this.all().find((record) => record.uris.some((candidate) => candidate === needle))
  }

  query(query: HistoryQuery): HistoryPage {
    const needle = query.search.trim().toLowerCase()
    let rows: HistoryRecord[] = this.all()

    if (query.status !== 'all') {
      rows = rows.filter((record) => record.status === query.status)
    }
    if (query.category !== 'all') {
      rows = rows.filter((record) => record.category === query.category)
    }
    if (needle) {
      rows = rows.filter((record) => {
        if (record.name.toLowerCase().includes(needle)) return true
        if (record.dir.toLowerCase().includes(needle)) return true
        return record.uris.some((uri) => uri.toLowerCase().includes(needle))
      })
    }

    const direction = query.direction === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      let comparison = 0
      switch (query.sort) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'size':
          comparison = a.totalLength - b.totalLength
          break
        case 'completedAt':
          comparison = (a.completedAt ?? 0) - (b.completedAt ?? 0)
          break
        default:
          comparison = a.addedAt - b.addedAt
      }
      return comparison * direction
    })

    const total = rows.length
    const offset = Math.max(0, query.offset)
    const limit = Math.max(1, query.limit)
    return { total, rows: rows.slice(offset, offset + limit) }
  }

  /**
   * Keep the document bounded. Oldest finished records go first; anything still
   * in flight is never pruned.
   */
  private pruneIfNeeded(): void {
    const records = this.records
    const keys = Object.keys(records)
    if (keys.length <= MAX_RECORDS) return

    const removable = keys
      .map((key) => records[key]!)
      .filter((record) => record.status === 'complete' || record.status === 'error' || record.status === 'removed')
      .sort((a, b) => a.addedAt - b.addedAt)

    const excess = keys.length - MAX_RECORDS
    const doomed = new Set(removable.slice(0, excess).map((record) => record.gid))
    if (doomed.size === 0) return

    for (const gid of doomed) delete records[gid]
    this.store.scheduleSave()
  }

  async flush(): Promise<void> {
    await this.store.save()
  }
}
