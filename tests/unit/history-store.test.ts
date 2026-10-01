import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HistoryStore } from '../../src/main/downloads/history-store'

import { makeRecord } from '../helpers/records'

let dir = ''
let file = ''
let store: HistoryStore

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ariadm-history-'))
  file = path.join(dir, 'history.json')
  store = new HistoryStore(file)
  await store.load()
})

afterEach(() => {
  store.clear()
})

describe('HistoryStore', () => {
  it('starts empty when there is no file on disk', () => {
    expect(store.count()).toBe(0)
    expect(store.all()).toEqual([])
  })

  it('upserts, reads back, and persists to disk', async () => {
    store.upsert(makeRecord({ gid: 'a', name: 'a.bin' }))
    store.upsert(makeRecord({ gid: 'b', name: 'b.bin' }))
    await store.flush()

    expect(store.count()).toBe(2)
    expect(store.get('a')?.name).toBe('a.bin')

    const raw = JSON.parse(readFileSync(file, 'utf8')) as { records: Record<string, { name: string }> }
    expect(Object.keys(raw.records)).toEqual(['a', 'b'])
  })

  it('overwrites rather than duplicates on a second upsert of the same gid', async () => {
    store.upsert(makeRecord({ gid: 'a', name: 'first.bin' }))
    store.upsert(makeRecord({ gid: 'a', name: 'second.bin' }))
    await store.flush()

    expect(store.count()).toBe(1)
    expect(store.get('a')?.name).toBe('second.bin')
  })

  it('applies deferred patches in place, as the poller needs', () => {
    store.upsert(makeRecord({ gid: 'a', status: 'active' }))
    store.patchDeferred('a', { status: 'complete', totalLength: 4096 })

    expect(store.get('a')?.status).toBe('complete')
    expect(store.get('a')?.totalLength).toBe(4096)
  })

  it('ignores a deferred patch for a gid it does not know', () => {
    store.patchDeferred('ghost', { status: 'complete' })
    expect(store.get('ghost')).toBeUndefined()
    expect(store.count()).toBe(0)
  })

  it('finds a record by any of its mirror URIs', () => {
    store.upsert(makeRecord({ gid: 'a', uris: ['https://m1/f.bin', 'https://m2/f.bin'] }))
    expect(store.findByUri('https://m2/f.bin')?.gid).toBe('a')
    expect(store.findByUri('  https://m1/f.bin  ')?.gid).toBe('a')
    expect(store.findByUri('https://other/f.bin')).toBeUndefined()
  })

  it('removes and clears records', async () => {
    store.upsert(makeRecord({ gid: 'a' }))
    store.upsert(makeRecord({ gid: 'b' }))
    store.remove(['a'])
    expect(store.all().map((record) => record.gid)).toEqual(['b'])

    store.clear()
    await store.flush()
    expect(store.count()).toBe(0)
  })
})

describe('HistoryStore.query', () => {
  const query = (overrides: Partial<Parameters<HistoryStore['query']>[0]> = {}) => ({
    search: '',
    status: 'all' as const,
    category: 'all' as const,
    sort: 'addedAt' as const,
    direction: 'desc' as const,
    offset: 0,
    limit: 100,
    ...overrides
  })

  beforeEach(() => {
    store.upsert(
      makeRecord({
        gid: 'a',
        name: 'ubuntu.iso',
        dir: 'D:/Downloads/archive',
        category: 'archive',
        status: 'complete',
        addedAt: 100,
        totalLength: 700
      })
    )
    store.upsert(
      makeRecord({
        gid: 'b',
        name: 'movie.mkv',
        dir: 'D:/Downloads/video',
        category: 'video',
        status: 'active',
        addedAt: 200,
        totalLength: 900
      })
    )
    store.upsert(
      makeRecord({
        gid: 'c',
        name: 'song.mp3',
        dir: 'D:/Downloads/audio',
        category: 'audio',
        status: 'complete',
        addedAt: 300,
        totalLength: 100
      })
    )
  })

  it('filters by status', () => {
    const page = store.query(query({ status: 'complete' }))
    expect(page.total).toBe(2)
    expect(page.rows.map((row) => row.gid).sort()).toEqual(['a', 'c'])
  })

  it('filters by category', () => {
    expect(store.query(query({ category: 'video' })).rows.map((row) => row.gid)).toEqual(['b'])
  })

  it('searches name, directory and URIs', () => {
    expect(store.query(query({ search: 'UBUNTU' })).rows.map((row) => row.gid)).toEqual(['a'])
    expect(store.query(query({ search: 'audio' })).rows.map((row) => row.gid)).toEqual(['c'])
    expect(store.query(query({ search: 'example.com' })).total).toBe(3)
  })

  it('sorts by size ascending and descending', () => {
    expect(store.query(query({ sort: 'size', direction: 'asc' })).rows.map((row) => row.gid)).toEqual(['c', 'a', 'b'])
    expect(store.query(query({ sort: 'size', direction: 'desc' })).rows.map((row) => row.gid)).toEqual(['b', 'a', 'c'])
  })

  it('paginates without losing the total', () => {
    const page = store.query(query({ sort: 'addedAt', direction: 'asc', offset: 1, limit: 1 }))
    expect(page.total).toBe(3)
    expect(page.rows.map((row) => row.gid)).toEqual(['b'])
  })

  it('returns everything when nothing matches the filter', () => {
    const page = store.query(query({ search: 'nothing-matches-this' }))
    expect(page.total).toBe(0)
    expect(page.rows).toEqual([])
  })
})
