import { describe, expect, it } from 'vitest'

import { DEFAULT_CATEGORIES } from '@shared/settings'

import { categorize } from '../../src/main/downloads/categorizer'
import { suggestedDownloadName } from '../../src/main/downloads/suggested-name'

/**
 * Regression guard for a precedence bug that made every URI download be filed as
 * "torrent": `fresh[0] ?? input.torrentBase64 ? 'torrent' : ''` parses as
 * `(fresh[0] ?? input.torrentBase64) ? 'torrent' : ''`, so any non-empty URL
 * produced the literal name "torrent" — and the categoriser then matched its
 * `.torrent` extension, filing videos under the torrent category.
 */
describe('suggestedDownloadName', () => {
  it('derives the name from the first URI, not from a truthiness test', () => {
    expect(suggestedDownloadName({ out: '', torrentBase64: null }, ['https://example.com/file.zip'])).toBe(
      'file.zip'
    )
  })

  it('never names a media page "torrent"', () => {
    const name = suggestedDownloadName({ out: '', torrentBase64: null }, [
      'https://www.youtube.com/watch?v=jskwGFcI4AA'
    ])
    expect(name).not.toBe('torrent')
    expect(categorize(name, DEFAULT_CATEGORIES)).not.toBe('torrent')
  })

  it('categorises a plain video link as a video, not a torrent', () => {
    const name = suggestedDownloadName({ out: '', torrentBase64: null }, [
      'https://cdn.example.com/clips/holiday.mp4'
    ])
    expect(categorize(name, DEFAULT_CATEGORIES)).toBe('video')
  })

  it('uses "torrent" only as a placeholder when a torrent body has no URI', () => {
    expect(suggestedDownloadName({ out: '', torrentBase64: 'AAA' }, [])).toBe('torrent')
    // With a URI present the URI wins, even for a torrent body.
    expect(suggestedDownloadName({ out: '', torrentBase64: 'AAA' }, ['magnet:?xt=urn:btih:abc&dn=Ubuntu'])).toBe(
      'Ubuntu'
    )
  })

  it('lets an explicit name win, sanitised', () => {
    expect(suggestedDownloadName({ out: 'My:File?.zip', torrentBase64: null }, ['https://example.com/x'])).toBe(
      'My_File_.zip'
    )
  })
})
