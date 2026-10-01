import { describe, expect, it } from 'vitest'

import { decodeBitfield, groupPieces } from '@shared/download'

describe('decodeBitfield', () => {
  it('reads one bit per piece, most significant bit first', () => {
    // 0xe0 = 1110 0000, and a 3 MiB download split at 1 MiB has 3 pieces.
    expect(decodeBitfield('e0', 3)).toEqual([true, true, true])
    // 0xa0 = 1010 0000
    expect(decodeBitfield('a0', 4)).toEqual([true, false, true, false])
    // 0x0f = 0000 1111
    expect(decodeBitfield('0f', 8)).toEqual([false, false, false, false, true, true, true, true])
  })

  it('discards padding bits past the piece count', () => {
    expect(decodeBitfield('ff', 3)).toEqual([true, true, true])
    expect(decodeBitfield('ffff', 5)).toHaveLength(5)
  })

  it('returns nothing for an empty field or a zero piece count', () => {
    expect(decodeBitfield('', 8)).toEqual([])
    expect(decodeBitfield('e0', 0)).toEqual([])
  })

  it('stops at the first character that is not hex rather than inventing pieces', () => {
    // 'z' is not hex, so the eight bits decoded so far stand and nothing more.
    expect(decodeBitfield('e0z', 12)).toEqual([true, true, true, false, false, false, false, false])
  })

  it('handles a long field of a high piece count', () => {
    const pieces = decodeBitfield('ff'.repeat(4), 32)
    expect(pieces).toHaveLength(32)
    expect(pieces.every(Boolean)).toBe(true)
  })
})

describe('groupPieces', () => {
  it('returns nothing for no pieces', () => {
    expect(groupPieces([], 512)).toEqual([])
  })

  it('keeps every piece when they already fit the budget', () => {
    expect(groupPieces([true, false, true], 512)).toEqual([
      { complete: 1, total: 1 },
      { complete: 0, total: 1 },
      { complete: 1, total: 1 }
    ])
  })

  it('merges neighbours once the budget is exceeded and never exceeds it', () => {
    const groups = groupPieces(new Array(2000).fill(true), 512)
    expect(groups.length).toBeLessThanOrEqual(512)
    // Every piece is still accounted for exactly once.
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(2000)
    expect(groups.every((group) => group.complete === group.total)).toBe(true)
  })

  it('keeps a partly finished cell truthful instead of rounding it', () => {
    const groups = groupPieces([true, false, true, false], 1)
    expect(groups).toEqual([{ complete: 2, total: 4 }])
  })

  it('treats a non-positive budget as a single cell', () => {
    expect(groupPieces([true, false], 0)).toEqual([{ complete: 1, total: 2 }])
  })
})
