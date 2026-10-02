import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaJobs, mergeStreamProgress } from '../../src/main/media/jobs'
import { buildDownloadArgs, buildProbeArgs, parseFileLine, parseProgressLine } from '../../src/main/media/ytdlp'

/**
 * How a media download runs, and what it reports while it runs.
 *
 * Two user-visible bugs live here. yt-dlp's `--print` implies `--quiet`, which
 * switches progress output off — so the app asked for a progress template and
 * received nothing, and every row sat on 0 B until it jumped to "completed".
 * And the quality menu is built from video-only streams, so `-f 312` produced a
 * file with no soundtrack at all: "the video has no sound".
 *
 * The toolchain is faked for the job-level cases; the argument and parsing cases
 * run against the real strings, including a progress line captured from the
 * bundled yt-dlp.
 */

const state = vi.hoisted(() => ({ runners: [] as FakeRunnerLike[] }))

interface FakeRunnerLike {
  options: Record<string, unknown>
  emit(event: string, ...args: unknown[]): boolean
}

vi.mock('../../src/main/media/ytdlp', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeRunner extends EventEmitter implements FakeRunnerLike {
    options: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      state.runners.push(this)
    }
    start(): void {}
    kill(): void {}
  }
  // buildDownloadArgs/parseProgressLine are asserted in their own cases below, so
  // the mock has to hand the real implementations through.
  const actual = await vi.importActual<typeof import('../../src/main/media/ytdlp')>(
    '../../src/main/media/ytdlp'
  )
  return { ...actual, YtDlpRunner: FakeRunner, probeFormats: vi.fn() }
})

function format(overrides: Record<string, unknown> = {}) {
  return {
    formatId: '312',
    label: '1080p · webm',
    ext: 'webm',
    resolution: '1080p',
    filesize: null,
    vcodec: 'vp9',
    acodec: 'none',
    note: '',
    needsFfmpeg: true,
    ...overrides
  }
}

const PROBE = {
  url: 'https://www.youtube.com/watch?v=abc',
  title: 'a video',
  id: 'abc',
  durationSeconds: 0,
  thumbnail: '',
  formats: [format()],
  isPlaylist: false,
  extractor: 'youtube',
  directUrl: ''
}

function makeJobs(options: { ffmpeg?: string } = {}) {
  return new MediaJobs({
    history: {
      upsert: vi.fn(),
      flush: async () => {},
      patchDeferred: vi.fn(),
      remove: vi.fn()
    } as never,
    getBinaryPath: () => 'yt-dlp.exe',
    getFfmpegPath: () => (options.ffmpeg === undefined ? 'C:/bin/ffmpeg.exe' : options.ffmpeg),
    getCookieArgs: () => [],
    log: () => {}
  })
}

function addInput(formatId: string) {
  return {
    url: PROBE.url,
    formatId,
    dir: 'C:/downloads',
    audioOnly: false,
    playlist: false,
    maxConcurrent: 0
  }
}

function optionsOf(index: number): Record<string, unknown> {
  return state.runners[index]!.options
}

beforeEach(() => {
  state.runners.length = 0
})

describe('the quality a merged choice downloads', () => {
  it('adds the site’s audio to a video-only stream, which has no soundtrack', async () => {
    // `-f 312` is a picture: it downloads and plays silently, which is exactly
    // what "the video has no sound" was.
    const jobs = makeJobs()
    await jobs.add(addInput('312'), PROBE as never)

    expect(optionsOf(0).formatId).toBe('312+bestaudio')
  })

  it('leaves a composed selector alone', async () => {
    const jobs = makeJobs()
    await jobs.add(addInput('312+bestaudio'), PROBE as never)

    expect(optionsOf(0).formatId).toBe('312+bestaudio')
  })

  it('leaves a stream that is already muxed alone', async () => {
    const probe = { ...PROBE, formats: [format({ formatId: '22', acodec: 'mp4a', needsFfmpeg: false })] }
    const jobs = makeJobs()
    await jobs.add(addInput('22'), probe as never)

    expect(optionsOf(0).formatId).toBe('22')
  })

  it('still refuses a video-only stream when there is nothing to merge with', async () => {
    const jobs = makeJobs({ ffmpeg: '' })
    await expect(jobs.add(addInput('312'), PROBE as never)).rejects.toThrow(/ffmpeg/)
    expect(state.runners).toHaveLength(0)
  })
})

describe('yt-dlp arguments that make progress arrive', () => {
  const run = {
    binaryPath: 'yt-dlp.exe',
    url: 'https://www.youtube.com/watch?v=abc',
    formatId: '312+bestaudio',
    dir: 'C:/downloads',
    ffmpegDir: '',
    audioOnly: false,
    playlist: false,
    overwrite: false
  }

  it('re-enables progress, which --print had switched off', () => {
    const args = buildDownloadArgs(run)
    expect(args).toContain('--progress')
  })

  it('marks every progress line with the prefix the parser reads', () => {
    // The first `download:` is yt-dlp's type selector and is consumed rather than
    // printed, so the literal one after it is what has to survive — without it
    // the parser sees a bare `1024|8388608|…` and ignores every line.
    const args = buildDownloadArgs(run)
    const template = args[args.indexOf('--progress-template') + 1]!

    expect(template.startsWith('download:download:')).toBe(true)
    expect(template).toContain('%(progress.filename)j')
  })

  it('asks for both paths as JSON, so a code page cannot mangle them', () => {
    const args = buildDownloadArgs(run)
    const print = args[args.indexOf('--print') + 1]!

    expect(print).toBe('after_move:ariadm-file:%(filepath)j')
  })
})

/**
 * Fragmented downloads and the one path that is never allowed to touch them.
 *
 * yt-dlp removed support for downloading HLS/DASH through aria2c in 2026.06.09
 * (GHSA-vx4q-3cr2-7cg2): a hostile manifest could inject aria2c input-file
 * options and write arbitrary files. The guard below is what keeps that path
 * closed no matter what a config, a flag or a future upgrade tries to set.
 */
describe('fragmented downloads stay on the native downloader', () => {
  const run = {
    binaryPath: 'yt-dlp.exe',
    url: 'https://www.youtube.com/watch?v=abc',
    formatId: '312+bestaudio',
    dir: 'C:/downloads',
    ffmpegDir: '',
    audioOnly: false,
    playlist: false,
    overwrite: false
  }

  it('pins dash/m3u8 to the native downloader, always', () => {
    const args = buildDownloadArgs(run)

    expect(args[args.indexOf('--downloader') + 1]).toBe('dash,m3u8:native')
  })

  it('runs in parallel only when asked, and never absurdly', () => {
    const serial = buildDownloadArgs(run)
    expect(serial).not.toContain('--concurrent-fragments')

    const parallel = buildDownloadArgs({ ...run, concurrentFragments: 5 })
    expect(parallel[parallel.indexOf('--concurrent-fragments') + 1]).toBe('5')

    const capped = buildDownloadArgs({ ...run, concurrentFragments: 99 })
    expect(capped[capped.indexOf('--concurrent-fragments') + 1]).toBe('16')
  })

  it('never reads a config file, on either the probe or the download', () => {
    // A `yt-dlp.conf` in the working directory is another way an attacker's
    // options reached the command line, so both invocations opt out.
    expect(buildDownloadArgs(run)).toContain('--ignore-config')
    expect(buildProbeArgs('https://www.youtube.com/watch?v=abc')).toContain('--ignore-config')
  })
})

/**
 * The same code-page problem, from the other end: a Chinese filename has to
 * survive being printed by yt-dlp and read back by us.
 */
describe('output paths that are not ASCII', () => {
  // What the bundled yt-dlp prints for 測試影片 中文標題.mp4, byte for byte: the
  // separators are JSON-escaped, and so is every character of the title, because
  // its stdout is the console code page and not UTF-8.
  const escaped = String.raw`ariadm-file:"C:\\Users\\me\\Videos\\\u6e2c\u8a66\u5f71\u7247 \u4e2d\u6587\u6a19\u984c.mp4"`

  it('recovers the real path from the JSON yt-dlp printed', () => {
    expect(parseFileLine(escaped)).toBe('C:\\Users\\me\\Videos\\測試影片 中文標題.mp4')
  })

  it('reads a plain path when the conversion was not applied', () => {
    // Non-ASCII aside, an older build that does not know the conversion still
    // prints something usable.
    expect(parseFileLine('ariadm-file:C:\\Users\\me\\Videos\\plain.mp4')).toBe(
      'C:\\Users\\me\\Videos\\plain.mp4'
    )
  })

  it('ignores every other line', () => {
    expect(parseFileLine('download:"x"|1|2|3|4')).toBeNull()
    expect(parseFileLine('')).toBeNull()
  })

  it('decodes the stream name in a progress line the same way', () => {
    const line = String.raw`download:"\u6e2c\u8a66.mp4"|2048|4096|100|3`

    expect(parseProgressLine(line)).toEqual({
      file: '測試.mp4',
      downloadedBytes: 2048,
      totalBytes: 4096,
      speed: 100,
      eta: 3
    })
  })
})

describe('progress line parsing', () => {
  it('reads a line the bundled yt-dlp actually printed', () => {
    const line =
      'download:C:\\Users\\me\\Temp\\a video.unknown_video|2096128|8388608|467201512.1|12'

    expect(parseProgressLine(line)).toEqual({
      file: 'C:\\Users\\me\\Temp\\a video.unknown_video',
      downloadedBytes: 2096128,
      totalBytes: 8388608,
      speed: 467201512.1,
      eta: 12
    })
  })

  it('treats the values yt-dlp has no answer for as zero', () => {
    expect(parseProgressLine('download:f|1024|NA|NA|NA')).toMatchObject({
      downloadedBytes: 1024,
      totalBytes: 0,
      speed: 0,
      eta: 0
    })
  })

  it('ignores anything that is not one of our lines', () => {
    expect(parseProgressLine('[download] 42% of 8MiB')).toBeNull()
    // Four fields is the old shape, whose first field was a byte count: reading
    // it as a filename would invent a file called "1024".
    expect(parseProgressLine('download:1024|8388608|NA|NA')).toBeNull()
  })
})

describe('progress totals across the streams of a merge', () => {
  it('keeps the row moving forward when the second stream starts', () => {
    // yt-dlp reports the video and the audio one after the other, with counters
    // that restart. Read one line at a time, the bar would fall back to nothing
    // as the audio began and the size would shrink to the audio file.
    const streams = new Map<string, { downloaded: number; total: number }>()

    expect(mergeStreamProgress(streams, { file: 'v', downloadedBytes: 22_000_000, totalBytes: 22_000_000, speed: 1, eta: 0 }))
      .toEqual({ downloadedBytes: 22_000_000, totalBytes: 22_000_000 })

    const withAudio = mergeStreamProgress(streams, {
      file: 'a',
      downloadedBytes: 4_000,
      totalBytes: 1_500_000,
      speed: 1,
      eta: 0
    })

    expect(withAudio.downloadedBytes).toBe(22_004_000)
    expect(withAudio.totalBytes).toBe(23_500_000)
    // The finished size, which is also what the merged file will be.
    expect(withAudio.totalBytes).toBeGreaterThan(22_000_000)
  })

  it('replaces a stream’s numbers rather than adding them again', () => {
    const streams = new Map<string, { downloaded: number; total: number }>()
    mergeStreamProgress(streams, { file: 'v', downloadedBytes: 100, totalBytes: 1000, speed: 0, eta: 0 })
    const again = mergeStreamProgress(streams, { file: 'v', downloadedBytes: 500, totalBytes: 1000, speed: 0, eta: 0 })

    expect(again).toEqual({ downloadedBytes: 500, totalBytes: 1000 })
  })
})

describe('what a finished row reports', () => {
  it('reads the finished file’s size instead of relying on progress output', async () => {
    // A download that printed no progress at all used to end as "Completed · 0 B"
    // beside a full bar, which is what the missing progress looked like.
    const dir = mkdtempSync(path.join(tmpdir(), 'ariadm-media-'))
    const file = path.join(dir, 'finished.mp4')
    writeFileSync(file, Buffer.alloc(4096))

    const jobs = makeJobs()
    const { gid } = await jobs.add(addInput('312'), PROBE as never)

    state.runners[0]!.emit('file', file)
    state.runners[0]!.emit('done')

    await vi.waitFor(() => expect(jobs.get(gid)!.totalLength).toBe(4096))
    expect(jobs.get(gid)!.completedLength).toBe(4096)
    expect(jobs.get(gid)!.status).toBe('complete')
  })
})
