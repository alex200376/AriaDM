import { describe, expect, it } from 'vitest'

import type { MediaFormatInfo } from '../../src/shared/settings'
import { directFormatUrls, resolveDirectFile, type MediaProbe } from '../../src/main/media/ytdlp'

function format(overrides: Partial<MediaFormatInfo> = {}): MediaFormatInfo {
  return {
    formatId: 'id',
    label: 'label',
    ext: 'mp4',
    resolution: '720p',
    filesize: null,
    vcodec: 'avc1',
    acodec: 'mp4a',
    note: '',
    needsFfmpeg: false,
    ...overrides
  }
}

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    url: 'https://example.com/watch',
    title: 'My Clip',
    id: 'abc',
    durationSeconds: 0,
    thumbnail: '',
    formats: [],
    subtitles: [],
    isPlaylist: false,
    extractor: 'example',
    directUrl: '',
    formatUrls: {},
    ...overrides
  }
}

describe('directFormatUrls', () => {
  it('keeps only plain http/https formats, keyed by id', () => {
    const urls = directFormatUrls({
      formats: [
        { format_id: 'plain', url: 'https://cdn.example.com/x.mp4', protocol: 'https' },
        { format_id: 'hls', url: 'https://cdn.example.com/y.m3u8', protocol: 'm3u8_native' },
        { format_id: 'dash', url: 'https://cdn.example.com/z', protocol: 'http_dash_segments' },
        { format_id: 'legacy', url: 'http://cdn.example.com/w.mp4', protocol: 'http' },
        // No protocol reported is not the same as a plain one.
        { format_id: 'unknown', url: 'https://cdn.example.com/u.mp4' },
        // A format with no id cannot be selected or looked up.
        { url: 'https://cdn.example.com/no-id.mp4', protocol: 'https' }
      ]
    } as never)

    expect(urls).toEqual({
      plain: 'https://cdn.example.com/x.mp4',
      legacy: 'http://cdn.example.com/w.mp4'
    })
  })

  it('matches the protocol case-insensitively', () => {
    const urls = directFormatUrls({
      formats: [{ format_id: 'x', url: 'https://cdn.example.com/x.mp4', protocol: 'HTTPS' }]
    } as never)

    expect(urls).toEqual({ x: 'https://cdn.example.com/x.mp4' })
  })

  it('returns nothing for a payload with no formats', () => {
    expect(directFormatUrls({} as never)).toEqual({})
  })
})

describe('resolveDirectFile', () => {
  it('returns the URL and a titled filename for a self-contained plain file', () => {
    const url = 'https://cdn.example.com/v/abc.mp4'
    const result = resolveDirectFile(
      probe({ formats: [format({ formatId: 'hd', ext: 'mp4' })], formatUrls: { hd: url } }),
      'hd'
    )

    expect(result).toEqual({ url, out: 'My Clip.mp4' })
  })

  it('accepts an audio-only format, which needs no muxing', () => {
    const url = 'https://cdn.example.com/a/abc.m4a'
    const result = resolveDirectFile(
      probe({
        formats: [format({ formatId: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'mp4a' })],
        formatUrls: { audio: url }
      }),
      'audio'
    )

    expect(result).toEqual({ url, out: 'My Clip.m4a' })
  })

  it('refuses a format that needs muxing even when it has a plain URL', () => {
    const result = resolveDirectFile(
      probe({
        formats: [format({ formatId: 'video-only', acodec: 'none', needsFfmpeg: true })],
        formatUrls: { 'video-only': 'https://cdn.example.com/v/only.mp4' }
      }),
      'video-only'
    )

    expect(result).toBeNull()
  })

  it('refuses a format with no plain-URL mapping', () => {
    const result = resolveDirectFile(
      probe({ formats: [format({ formatId: 'dash' })], formatUrls: {} }),
      'dash'
    )

    expect(result).toBeNull()
  })

  it('refuses an unknown format id', () => {
    expect(resolveDirectFile(probe(), 'nope')).toBeNull()
  })

  it('refuses an empty format id', () => {
    expect(resolveDirectFile(probe(), '')).toBeNull()
  })

  it('refuses anything for a playlist', () => {
    const result = resolveDirectFile(
      probe({
        isPlaylist: true,
        formats: [format({ formatId: 'hd' })],
        formatUrls: { hd: 'https://cdn.example.com/x.mp4' }
      }),
      'hd'
    )

    expect(result).toBeNull()
  })

  it('leaves the filename empty when the title is missing', () => {
    const result = resolveDirectFile(
      probe({
        title: '   ',
        formats: [format({ formatId: 'hd' })],
        formatUrls: { hd: 'https://cdn.example.com/x.mp4' }
      }),
      'hd'
    )

    expect(result).toEqual({ url: 'https://cdn.example.com/x.mp4', out: '' })
  })
})
