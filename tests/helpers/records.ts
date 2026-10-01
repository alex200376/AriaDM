import type { AddDownloadInput } from '@shared/settings'

import type { HistoryRecord } from '../../src/main/downloads/history-store'

export function makeInput(overrides: Partial<AddDownloadInput> = {}): AddDownloadInput {
  return {
    uris: [],
    out: '',
    dir: '',
    split: 0,
    maxConnectionPerServer: 0,
    minSplitSize: 0,
    maxDownloadLimit: 0,
    referer: '',
    userAgent: '',
    cookieHeader: '',
    headers: [],
    username: '',
    password: '',
    proxy: '',
    paused: false,
    seedRatio: 0,
    seedTime: 0,
    selectFileIndices: [],
    category: '',
    tags: [],
    source: 'manual',
    torrentBase64: null,
    metalinkBase64: null,
    allowDuplicate: false,
    engine: 'auto',
    ...overrides
  }
}

export function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    gid: 'gid-0',
    name: 'file.bin',
    dir: '/downloads',
    category: 'other',
    tags: [],
    kind: 'http',
    engine: 'aria2',
    uris: ['https://example.com/file.bin'],
    totalLength: 0,
    addedAt: 1_000,
    completedAt: null,
    source: 'manual',
    status: 'active',
    mediaFormat: null,
    errorCode: 0,
    errorMessage: '',
    postActionState: 'idle',
    notified: false,
    maxDownloadLimit: 0,
    split: 1,
    maxConnectionPerServer: 1,
    minSplitSize: 0,
    referer: '',
    userAgent: '',
    cookieHeader: '',
    headers: [],
    username: '',
    password: '',
    proxy: '',
    pausedQueued: false,
    ...overrides
  }
}

export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const intervalMs = options.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? 'condition'}`)
}
