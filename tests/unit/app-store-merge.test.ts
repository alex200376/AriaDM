import { describe, expect, it } from 'vitest'

import type { DownloadItem } from '@shared/download'

import { mergeItems } from '@shared/merge-items'

/**
 * The renderer half of the tick protocol.
 *
 * A tick carries only what changed, so this merge is what turns it back into the
 * list the table draws. Getting it wrong is invisible in the payloads and very
 * visible on screen — a finished download that never appears, or a removed one
 * that stays — so it is pinned here rather than only through the manager.
 */
function item(gid: string, overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    gid,
    engine: 'aria2',
    kind: 'http',
    status: 'active',
    name: `${gid}.bin`,
    dir: '/downloads',
    files: [],
    numFiles: 1,
    totalLength: 100,
    completedLength: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connections: 1,
    numSeeders: 0,
    seeder: false,
    pieceLength: 0,
    numPieces: 0,
    errorCode: 0,
    errorMessage: '',
    verifiedLength: 0,
    verifyIntegrityPending: false,
    infoHash: null,
    bittorrent: null,
    category: 'other',
    tags: [],
    addedAt: 1,
    completedAt: null,
    ...overrides
  } as DownloadItem
}

describe('mergeItems', () => {
  it('adds an item the renderer has never seen', () => {
    const merged = mergeItems([item('a')], [item('b')], [])
    expect(merged.map((entry) => entry.gid)).toEqual(['a', 'b'])
  })

  it('replaces an item in place rather than appending it again', () => {
    const first = item('a')
    const second = item('a', { status: 'complete', completedLength: 100 })
    const other = item('b')

    const merged = mergeItems([first, other], [second], [])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(second)
    // The order the renderer already had is kept, so a progress update cannot
    // make a row jump to the end of the list.
    expect(merged.map((entry) => entry.gid)).toEqual(['a', 'b'])
  })

  it('drops the gids a removal named', () => {
    const merged = mergeItems([item('a'), item('b')], [], ['a'])
    expect(merged.map((entry) => entry.gid)).toEqual(['b'])
  })

  it('handles a payload that both changes and removes', () => {
    const merged = mergeItems([item('a'), item('b'), item('c')], [item('c', { name: 'c-v2.bin' })], ['b'])
    expect(merged.map((entry) => entry.gid)).toEqual(['a', 'c'])
    expect(merged[1]!.name).toBe('c-v2.bin')
  })

  it('leaves an empty tick alone', () => {
    const current = [item('a')]
    expect(mergeItems(current, [], [])).toEqual(current)
  })
})
