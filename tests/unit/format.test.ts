import { describe, expect, it } from 'vitest'

import { setLocale } from '@shared/i18n'
import {
  formatBytes,
  formatBytesPair,
  formatEta,
  formatPercent,
  formatRelative,
  formatSpeed,
  isTorrentLike,
  parseSize,
  toPercentValue,
  truncateMiddle
} from '@shared/format'

describe('formatBytes', () => {
  it('uses 1024-based units and drops decimals below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
  })
})

describe('formatSpeed', () => {
  it('shows an em dash for an idle or invalid rate', () => {
    expect(formatSpeed(0)).toBe('—')
    expect(formatSpeed(Number.POSITIVE_INFINITY)).toBe('—')
  })

  it('appends per-second units', () => {
    expect(formatSpeed(1024)).toBe('1.0 KB/s')
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s')
  })
})

describe('formatEta', () => {
  it('handles null and zero', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(0)).toBe('0s')
  })

  it('picks the largest meaningful pair of units', () => {
    expect(formatEta(59)).toBe('59s')
    expect(formatEta(90)).toBe('1m 30s')
    expect(formatEta(3600)).toBe('1h 0m')
    expect(formatEta(86_400)).toBe('1d 0h')
  })
})

describe('formatPercent', () => {
  it('clamps the fraction into 0..1', () => {
    expect(formatPercent(0.5)).toBe('50.0%')
    expect(formatPercent(0.256, 2)).toBe('25.60%')
    expect(formatPercent(1.5)).toBe('100.0%')
    expect(formatPercent(-1)).toBe('0.0%')
  })
})

describe('parseSize', () => {
  it('understands bare bytes and K/M/G/T suffixes', () => {
    expect(parseSize('1024')).toBe(1024)
    expect(parseSize('500K')).toBe(500 * 1024)
    expect(parseSize('5M')).toBe(5 * 1024 ** 2)
    expect(parseSize('1.5G')).toBe(Math.round(1.5 * 1024 ** 3))
  })

  it('treats zero and the word unlimited as no limit', () => {
    expect(parseSize('0')).toBe(0)
    expect(parseSize('unlimited')).toBe(0)
    expect(parseSize('無限')).toBe(0)
  })

  it('returns null for input that cannot be parsed', () => {
    expect(parseSize('')).toBeNull()
    expect(parseSize('abc')).toBeNull()
    expect(parseSize('12 parsecs')).toBeNull()
  })
})

describe('toPercentValue / truncateMiddle / formatBytesPair', () => {
  it('converts a fraction to a bounded percentage', () => {
    expect(toPercentValue(0.5)).toBe(50)
    expect(toPercentValue(2)).toBe(100)
    expect(toPercentValue(Number.NaN)).toBe(0)
  })

  it('leaves short text alone and shortens long text from the middle', () => {
    expect(truncateMiddle('short', 60)).toBe('short')
    expect(truncateMiddle('abcdefghij', 5)).toBe('ab…ij')
  })

  it('shows a single size until a total is known', () => {
    expect(formatBytesPair(0, 0)).toBe('0 B')
    expect(formatBytesPair(1024, 2048)).toBe('1.0 KB / 2.0 KB')
  })
})

describe('isTorrentLike', () => {
  it('recognises torrent files and magnet links', () => {
    expect(isTorrentLike('ubuntu.torrent')).toBe(true)
    expect(isTorrentLike('magnet:?xt=urn:btih:x')).toBe(true)
    expect(isTorrentLike('ubuntu.iso')).toBe(false)
  })
})

describe('formatRelative', () => {
  const now = 1_700_000_000_000

  it('reports recent times as just now', () => {
    expect(formatRelative(now - 30_000, now)).toBe('剛剛')
    expect(formatRelative(null, now)).toBe('—')
  })

  it('scales the unit to the gap', () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5 分鐘前')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3 小時前')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 天前')
  })

  it('follows the app language rather than always answering in Chinese', () => {
    setLocale('en')
    try {
      expect(formatRelative(now - 30_000, now)).toBe('just now')
      expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago')
      expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago')
      expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago')
    } finally {
      setLocale('zh-TW')
    }
  })
})
