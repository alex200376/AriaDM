import { describe, expect, it } from 'vitest'

import { resolveHandoffEngine } from '../../src/shared/media-sites'

/**
 * The extension's video button is offered on any page, and it says `media: true`
 * whether or not the site is one we recognise. That flag used to be taken as an
 * instruction, which sent plain files to yt-dlp — a single connection, an
 * extraction pass and its own startup, measured at tens of times slower than
 * aria2 on the same 3.5 MB CDN file, with no size, so the row's speed and ETA
 * were noise.
 *
 * The flag is a hint now: a URL that names a file stays a file.
 */

const PAGE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const FILE = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/02d394de/transcode=true,original=true/LTX_2.3_i2v_00123_.webm'

describe('resolveHandoffEngine', () => {
  it('leaves an ordinary handoff to detection', () => {
    expect(resolveHandoffEngine({ urls: [PAGE] })).toBe('auto')
  })

  it('takes the video hint for a media page', () => {
    expect(resolveHandoffEngine({ urls: [PAGE], media: true })).toBe('ytdlp')
  })

  it('keeps the video hint off a URL that names a file', () => {
    // The reported case: the extension's video button on a direct CDN payload.
    expect(resolveHandoffEngine({ urls: [FILE], media: true })).toBe('auto')
  })

  it('still routes a file URL to aria2 even when detection is on', () => {
    // 'auto' is what lets chooseEngine run; a file URL is never a media site URL,
    // so it lands on aria2 either way.
    expect(resolveHandoffEngine({ urls: ['https://x.com/clip.mp4'], media: true })).toBe('auto')
  })

  it('honours an engine the caller named outright', () => {
    expect(resolveHandoffEngine({ urls: [PAGE], engine: 'aria2', media: true })).toBe('aria2')
    expect(resolveHandoffEngine({ urls: [FILE], engine: 'ytdlp', media: false })).toBe('ytdlp')
  })

  it('treats a batch as files rather than a media page', () => {
    // A pasted list is a batch of links, and the hint has nothing to say about it.
    expect(resolveHandoffEngine({ urls: [FILE, PAGE], media: true })).toBe('auto')
  })

  it('does not guess when there is no URL to look at', () => {
    expect(resolveHandoffEngine({ urls: [], media: true })).toBe('ytdlp')
  })
})
