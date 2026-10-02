import { describe, expect, it } from 'vitest'

import { buildDownloadArgs, parseSubtitles } from '../../src/main/media/ytdlp'

/**
 * Subtitles and audio conversion.
 *
 * Both are opt-in features that reuse the bundled ffmpeg, so the tests pin the
 * argument shapes: a language that has a manual track must win over its
 * auto-generated copy, subtitles are written even when they are not embedded,
 * and the audio is left untouched unless a conversion was actually asked for.
 */

const RUN = {
  binaryPath: 'yt-dlp.exe',
  url: 'https://www.youtube.com/watch?v=abc',
  formatId: '312+bestaudio',
  dir: 'C:/downloads',
  ffmpegDir: '',
  audioOnly: true,
  playlist: false,
  overwrite: false
}

describe('parseSubtitles', () => {
  it('lists manual and automatic tracks, manual winning a shared language', () => {
    const tracks = parseSubtitles({
      subtitles: { ja: [], en: [] },
      automatic_captions: { en: [], de: [] }
    })

    // Sorted, and `en` is reported as the manual track it also has.
    expect(tracks).toEqual([
      { code: 'de', auto: true },
      { code: 'en', auto: false },
      { code: 'ja', auto: false }
    ])
  })

  it('is empty when the extractor reported none', () => {
    expect(parseSubtitles({})).toEqual([])
  })
})

describe('subtitle arguments', () => {
  it('writes the chosen languages, manual and automatic alike', () => {
    const args = buildDownloadArgs({ ...RUN, subtitles: { codes: ['en', 'zh-Hant'], embed: false } })

    // Both switches: the picker cannot know which chosen language has a manual
    // track, so --sub-langs filters whatever either switch turned on.
    expect(args).toContain('--write-subs')
    expect(args).toContain('--write-auto-subs')
    expect(args[args.indexOf('--sub-langs') + 1]).toBe('en,zh-Hant')
    expect(args).not.toContain('--embed-subs')
  })

  it('embeds only when asked', () => {
    const args = buildDownloadArgs({ ...RUN, subtitles: { codes: ['en'], embed: true } })

    expect(args).toContain('--embed-subs')
  })

  it('asks for nothing when no language was picked', () => {
    const args = buildDownloadArgs(RUN)

    expect(args).not.toContain('--write-subs')
    expect(args).not.toContain('--sub-langs')
  })
})

describe('audio conversion arguments', () => {
  it('leaves the site’s own audio alone by default', () => {
    expect(buildDownloadArgs(RUN)).not.toContain('--extract-audio')
  })

  it('converts only for a named format', () => {
    const args = buildDownloadArgs({ ...RUN, audioFormat: 'mp3' })

    expect(args).toContain('--extract-audio')
    expect(args[args.indexOf('--audio-format') + 1]).toBe('mp3')
  })
})
