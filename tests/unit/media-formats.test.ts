import { describe, expect, it } from 'vitest'

import {
  defaultFormatId,
  formatChoices,
  provisionalFormatId,
  provisionalFormatOption
} from '../../src/shared/media-formats'
import type { MediaFormatInfo } from '../../src/shared/settings'

/**
 * The choices offered *outside* the app have to be short.
 *
 * The download dialog can afford the extractor's whole catalogue, one line each.
 * The browser extension has a panel the size of a video corner, so it gets one
 * entry per resolution — and the picker still has to keep the one-click path
 * (whatever `defaultFormatId` would have chosen) available.
 */

function format(overrides: Partial<MediaFormatInfo>): MediaFormatInfo {
  return {
    formatId: 'x',
    label: 'x',
    ext: 'mp4',
    resolution: '',
    filesize: null,
    vcodec: 'avc1',
    acodec: 'mp4a',
    note: '',
    needsFfmpeg: false,
    ...overrides
  }
}

/** Roughly what a YouTube watch page produces: muxed tiers plus video-only ones. */
const YOUTUBE: MediaFormatInfo[] = [
  format({ formatId: 'bestvideo+bestaudio/best', label: '最佳畫質（自動合併音訊）', resolution: '1080p', needsFfmpeg: true }),
  format({ formatId: '18', label: '360p · mp4', resolution: '640x360' }),
  format({ formatId: '22', label: '720p · mp4', resolution: '1280x720' }),
  format({ formatId: '137', label: '1080p · mp4', resolution: '1920x1080', vcodec: 'avc1', acodec: 'none', needsFfmpeg: true }),
  format({ formatId: '248', label: '1080p · webm', resolution: '1920x1080', vcodec: 'vp9', acodec: 'none', needsFfmpeg: true }),
  format({ formatId: '271', label: '1440p · webm', resolution: '2560x1440', vcodec: 'vp9', acodec: 'none', needsFfmpeg: true }),
  format({ formatId: '140', label: '純音訊 · m4a · 128kbps', resolution: 'audio', vcodec: 'none' }),
  format({ formatId: 'bestaudio/best', label: '純音訊（最佳）', resolution: 'audio', vcodec: 'none' })
]

describe('formatChoices', () => {
  it('offers one entry per resolution, highest first', () => {
    const choices = formatChoices(YOUTUBE, { hasFfmpeg: true })

    expect(choices.map((choice) => choice.formatId)).toEqual(['271', '137', '22', '18', 'bestaudio/best'])
  })

  it('prefers a stream that needs no merging when a tier offers both', () => {
    // 1080p exists as a muxed fallback and as two video-only streams; the entry
    // that plays without ffmpeg is the more useful one to offer.
    const choices = formatChoices(
      [
        format({ formatId: '137', resolution: '1920x1080', acodec: 'none', needsFfmpeg: true }),
        format({ formatId: '22', resolution: '1920x1080' })
      ],
      { hasFfmpeg: true }
    )

    expect(choices.map((choice) => choice.formatId)).toEqual(['22'])
  })

  it('drops video-only tiers when there is no ffmpeg to mux them', () => {
    const choices = formatChoices(YOUTUBE, { hasFfmpeg: false })

    expect(choices.map((choice) => choice.formatId)).toEqual(['22', '18', 'bestaudio/best'])
  })

  it('never offers the synthetic best entry as something to choose', () => {
    // It is a request ("give me the best"), not a stream, and it is already what
    // a click with no choice makes.
    for (const choice of formatChoices(YOUTUBE, { hasFfmpeg: true })) {
      expect(choice.formatId).not.toBe('bestvideo+bestaudio/best')
    }
  })

  it('stays short even when the site serves dozens of formats', () => {
    const many: MediaFormatInfo[] = Array.from({ length: 40 }, (_, index) =>
      format({
        formatId: `f${index}`,
        resolution: `${100 + index}p`,
        vcodec: `codec${index}`,
        acodec: 'none',
        needsFfmpeg: true
      })
    )

    expect(formatChoices(many, { hasFfmpeg: true })).toHaveLength(5)
  })

  it('offers nothing for a page with no formats', () => {
    expect(formatChoices([], { hasFfmpeg: true })).toEqual([])
  })
})

describe('defaultFormatId', () => {
  it('is the app entry point the picker keeps as its first row', () => {
    expect(defaultFormatId(YOUTUBE, true)).toBe('bestvideo+bestaudio/best')
  })

  it('falls back to a muxed stream when ffmpeg is missing', () => {
    // The best entry means "merge two streams", which is exactly what cannot
    // happen without ffmpeg — the reason "I can't download YouTube videos"
    // happened on a machine that looked fully installed.
    expect(defaultFormatId(YOUTUBE, false)).toBe('18')
  })
})

describe('provisionalFormatId', () => {
  it('names the merged best entry when ffmpeg can produce it', () => {
    expect(provisionalFormatId(true, false)).toBe('bestvideo+bestaudio/best')
  })

  it('names a single-file stream without ffmpeg, which is what can actually be made', () => {
    expect(provisionalFormatId(false, false)).toBe('best')
  })

  it('names the best audio for an audio-only request, ffmpeg or not', () => {
    expect(provisionalFormatId(true, true)).toBe('bestaudio/best')
    expect(provisionalFormatId(false, true)).toBe('bestaudio/best')
  })
})

describe('provisionalFormatOption', () => {
  it('agrees with the id provisionalFormatId chose, in every combination', () => {
    for (const hasFfmpeg of [true, false]) {
      for (const audioOnly of [true, false]) {
        expect(provisionalFormatOption(hasFfmpeg, audioOnly).formatId).toBe(
          provisionalFormatId(hasFfmpeg, audioOnly)
        )
      }
    }
  })

  it('does not promise a merge a machine without ffmpeg cannot finish', () => {
    expect(provisionalFormatOption(false, false).needsFfmpeg).toBe(false)
    expect(provisionalFormatOption(true, false).needsFfmpeg).toBe(true)
  })

  it('marks the audio row as audio so the pure-audio toggle settles', () => {
    expect(provisionalFormatOption(true, true).resolution).toBe('audio')
    expect(provisionalFormatOption(true, true).needsFfmpeg).toBe(false)
  })
})
