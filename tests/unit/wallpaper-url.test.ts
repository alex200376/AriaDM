import { describe, expect, it } from 'vitest'

import {
  CSS_DECLARATION_CHAR_LIMIT,
  pictureBlobFrom,
  wallpaperCssUrl
} from '../../src/shared/wallpaper-url'

/**
 * The wallpaper has to reach CSS as a few dozen characters, whatever the picture
 * weighs.
 *
 * This exists because of a real report: a 1.7 MB PNG was set, the setting was
 * saved, the file was a valid image that Chromium decoded happily — and the window
 * showed no picture. The data URL for it is 2.36 million characters, and Blink
 * drops a CSS declaration longer than 2 MiB **without any error**. A small picture
 * stayed under the cap, so some wallpapers worked and some silently did not.
 *
 * So the assertion here is not "the conversion works" but "the declaration never
 * holds the data URL": that is the property the bug violated.
 */

/** A base64 data URL of `bytes` bytes, as the main process would produce. */
function dataUrlOf(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** Something big enough to be a photograph, and past the CSS limit as a data URL. */
function largeImage(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes)
  for (let index = 0; index < bytes; index += 1) data[index] = (index * 31 + 7) & 0xff
  // A real PNG's first bytes, so nothing here depends on the container being fake.
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return data
}

describe('wallpaperCssUrl', () => {
  it('hands CSS a short blob URL instead of the data URL', () => {
    const dataUrl = dataUrlOf(largeImage(1_700_000))
    // The exact shape of the reported case: over the limit, so a declaration
    // holding it would be dropped and the picture would never paint.
    expect(dataUrl.length).toBeGreaterThan(CSS_DECLARATION_CHAR_LIMIT)

    let blob: Blob | null = null
    const url = wallpaperCssUrl(dataUrl, (created) => {
      blob = created
      return 'blob:http://localhost/9c1f0e3a-0000-4000-8000-000000000000'
    })

    expect(url.startsWith('blob:')).toBe(true)
    // The point: a declaration is now tiny, so the limit cannot be reached by any
    // picture the reader will ever hand over.
    expect(url.length).toBeLessThan(1024)
    expect(url).not.toContain('base64')
    expect(blob).not.toBeNull()
  })

  it('carries the picture byte for byte, with its MIME type', async () => {
    const bytes = largeImage(200_000)
    const dataUrl = dataUrlOf(bytes, 'image/webp')
    let blob: Blob | null = null

    wallpaperCssUrl(dataUrl, (created) => {
      blob = created
      return 'blob:http://localhost/1'
    })

    expect(blob!.type).toBe('image/webp')
    expect(blob!.size).toBe(bytes.length)
    const round = new Uint8Array(await blob!.arrayBuffer())
    expect(Buffer.from(round).equals(Buffer.from(bytes))).toBe(true)
  })

  it('stays under the declaration limit for every size the reader allows', () => {
    // The reader's own cap is 8 MB, so the data URL can be nearly 11 MB — several
    // times the limit. Nothing that big may ever be written into a declaration.
    const worstCase = dataUrlOf(largeImage(8 * 1024 * 1024))
    const url = wallpaperCssUrl(worstCase, () => 'blob:http://localhost/2')

    expect(worstCase.length).toBeGreaterThan(CSS_DECLARATION_CHAR_LIMIT * 4)
    expect(url.length).toBeLessThan(1024)
  })

  it('falls back to what it was given when the value is not a base64 data URL', () => {
    // A hand-edited setting, or a form of data URL this cannot decode: the caller
    // is better off with the old behaviour than with nothing at all.
    const create = (): string => {
      throw new Error('must not be called')
    }

    expect(wallpaperCssUrl('https://example.com/a.png', create)).toBe('https://example.com/a.png')
    expect(wallpaperCssUrl('data:image/png,not-base64', create)).toBe('data:image/png,not-base64')
    expect(wallpaperCssUrl('', create)).toBe('')
    expect(wallpaperCssUrl('data:image/png;base64,!!!not base64!!!', create)).toBe(
      'data:image/png;base64,!!!not base64!!!'
    )
  })
})

describe('pictureBlobFrom', () => {
  it('decodes what a PNG header looks like, and nothing it cannot read', () => {
    const png = largeImage(32)
    const blob = pictureBlobFrom(dataUrlOf(png))

    expect(blob?.size).toBe(32)
    expect(blob?.type).toBe('image/png')
    expect(pictureBlobFrom('data:text/plain;base64,aGk=')?.type).toBe('text/plain')
    expect(pictureBlobFrom('not a data url')).toBeNull()
    expect(pictureBlobFrom('data:image/png;base64,')).toBeNull()
  })
})
