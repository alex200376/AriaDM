import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaJobs } from '../../src/main/media/jobs'
import { isPartialOf, partialStem } from '../../src/main/media/partial-files'

/**
 * What a cancelled download leaves behind.
 *
 * yt-dlp does not write into the file it was asked for: the bytes go into
 * `<name>.part`, a fragmented stream is fetched as one `<name>.part-Frag<N>` per
 * piece, and a run being continued keeps a `<name>.ytdl` beside them. Cancelling a
 * download used to delete none of it — the code deleted only from `outputPaths`,
 * which is filled by a stream that has been *moved into place*, so a run killed
 * mid-flight had no name at all and the folder filled up instead.
 *
 * The runner is faked so a run can be stopped and its exit held back; the files
 * are real ones in a temporary folder, so these cases are about what is on disk
 * afterwards rather than about a call being made.
 */

const state = vi.hoisted(() => ({ runners: [] as FakeRunnerLike[] }))

interface FakeRunnerLike {
  options: Record<string, unknown>
  killed: boolean
  release(): void
  emit(event: string, ...args: unknown[]): boolean
}

vi.mock('../../src/main/media/ytdlp', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeRunner extends EventEmitter implements FakeRunnerLike {
    options: Record<string, unknown>
    killed = false
    exited: Promise<void>
    release!: () => void

    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      this.exited = new Promise((resolve) => {
        this.release = resolve
      })
      state.runners.push(this)
    }

    start(): void {}
    kill(): void {
      this.killed = true
    }
  }

  const actual = await vi.importActual<typeof import('../../src/main/media/ytdlp')>(
    '../../src/main/media/ytdlp'
  )
  return { ...actual, YtDlpRunner: FakeRunner, probeFormats: vi.fn() }
})

const PROBE = {
  url: 'https://example.com/watch?v=abc',
  title: 'a video',
  id: 'abc',
  durationSeconds: 0,
  thumbnail: '',
  formats: [
    {
      formatId: '312',
      label: '1080p · webm',
      ext: 'webm',
      resolution: '1080p',
      filesize: null,
      vcodec: 'vp9',
      acodec: 'none',
      note: '',
      needsFfmpeg: true
    }
  ],
  isPlaylist: false,
  extractor: 'example',
  directUrl: '',
  formatUrls: {}
}

function makeJobs() {
  return new MediaJobs({
    history: {
      upsert: vi.fn(),
      flush: async () => {},
      patchDeferred: vi.fn(),
      remove: vi.fn()
    } as never,
    getBinaryPath: () => 'yt-dlp.exe',
    getFfmpegPath: () => 'C:/bin/ffmpeg.exe',
    getCookieArgs: () => [],
    log: () => {}
  })
}

/** A download folder holding the debris of a cancelled run, and one bystander. */
function folderWith(name: string, files: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ariadm-cancel-'))
  for (const file of files) writeFileSync(path.join(dir, file), 'partial')
  writeFileSync(path.join(dir, 'holiday photo.jpg'), 'not ours')
  return { dir, target: path.join(dir, name) }
}

const DEFAULTS = {
  formatId: '312',
  audioOnly: false,
  playlist: false,
  maxConcurrent: 0
}

beforeEach(() => {
  state.runners.length = 0
})

describe('cancelling a media download', () => {
  const DEBRIS = [
    'index [index].mp4.part',
    'index [index].mp4.part-Frag3',
    'index [index].mp4.part-Frag7.part',
    'index [index].mp4.ytdl'
  ]

  it('deletes the working files of a run that never finished', async () => {
    // The name is only knowable from what yt-dlp was still writing: no stream
    // has been moved yet, so outputPaths is empty and every one of these files
    // used to survive the cancel.
    const { dir, target } = folderWith('index [index].mp4', DEBRIS)
    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)

    state.runners[0]!.emit('progress', {
      file: target,
      downloadedBytes: 1024,
      totalBytes: 4096,
      speed: 1,
      eta: 3
    })

    const removing = jobs.remove(gid, false)
    state.runners[0]!.release()
    await removing

    for (const file of DEBRIS) {
      expect(existsSync(path.join(dir, file)), file).toBe(false)
    }
    // The download is not a candidate: removing a row is not deleting a file.
    expect(existsSync(path.join(dir, 'holiday photo.jpg'))).toBe(true)
    expect(jobs.get(gid)).toBeUndefined()
  })

  it('recognises the fragments from the name yt-dlp reports for a piece', async () => {
    // With `--concurrent-fragments` the progress lines name the piece itself, so
    // the app may never see the download's own name while it is running.
    const { dir } = folderWith('index [index].mp4', DEBRIS)
    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)

    state.runners[0]!.emit('progress', {
      file: path.join(dir, 'index [index].mp4.part-Frag7.part'),
      downloadedBytes: 1024,
      totalBytes: 4096,
      speed: 1,
      eta: 3
    })

    const removing = jobs.remove(gid, false)
    state.runners[0]!.release()
    await removing

    for (const file of DEBRIS) {
      expect(existsSync(path.join(dir, file)), file).toBe(false)
    }
  })

  it('waits for the process to be gone before deleting, and keeps the .part until then', async () => {
    // Windows will not remove a file a live process still has open, and a kill is
    // a signal rather than an outcome: the exit arrives after it. Deleting first
    // is what left the files behind even for a cancel that did know their names.
    const { dir, target } = folderWith('index [index].mp4', DEBRIS)
    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)
    state.runners[0]!.emit('progress', {
      file: target,
      downloadedBytes: 1024,
      totalBytes: 4096,
      speed: 1,
      eta: 3
    })

    const removing = jobs.remove(gid, false)

    expect(state.runners[0]!.killed).toBe(true)
    expect(existsSync(path.join(dir, 'index [index].mp4.part'))).toBe(true)

    state.runners[0]!.release()
    await removing
    expect(existsSync(path.join(dir, 'index [index].mp4.part'))).toBe(false)
  })

  it('leaves the partial file alone while a download is merely paused', async () => {
    // Resume is what a .part is for, and pausing is not cancelling: the file is
    // only removed once there is no row left to resume from.
    const { dir, target } = folderWith('index [index].mp4', DEBRIS)
    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)
    state.runners[0]!.emit('progress', {
      file: target,
      downloadedBytes: 1024,
      totalBytes: 4096,
      speed: 1,
      eta: 3
    })

    await jobs.pause(gid)
    expect(jobs.get(gid)!.status).toBe('paused')
    expect(existsSync(path.join(dir, 'index [index].mp4.part'))).toBe(true)

    const removing = jobs.remove(gid, false)
    state.runners[0]!.release()
    await removing
    expect(existsSync(path.join(dir, 'index [index].mp4.part'))).toBe(false)
  })
})

describe('removing a media download and its files', () => {
  it('deletes the finished file and whatever partials are beside it', async () => {
    const { dir, target } = folderWith('a video.mp4', [
      'a video.mp4.part',
      'a video.mp4.part-Frag2',
      'a video.mp4.ytdl'
    ])
    writeFileSync(target, 'finished')
    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)

    state.runners[0]!.emit('file', target)
    state.runners[0]!.emit('done')
    await vi.waitFor(() => expect(jobs.get(gid)!.status).toBe('complete'))

    const removing = jobs.remove(gid, true)
    state.runners[0]!.release()
    await removing

    expect(existsSync(target)).toBe(false)
    expect(existsSync(path.join(dir, 'a video.mp4.part'))).toBe(false)
    expect(existsSync(path.join(dir, 'a video.mp4.part-Frag2'))).toBe(false)
    expect(existsSync(path.join(dir, 'a video.mp4.ytdl'))).toBe(false)
    expect(existsSync(path.join(dir, 'holiday photo.jpg'))).toBe(true)
  })

  it('leaves a neighbour whose name only starts the same way', async () => {
    // The scan is scoped to the download's own name and to the suffixes yt-dlp
    // writes, so nothing else in the folder is in scope however it is named.
    const { dir, target } = folderWith('a video.mp4', ['a video.mp4.temp.mp4'])
    writeFileSync(path.join(dir, 'a video.mp4.partial-notes.txt'), 'mine')

    const jobs = makeJobs()
    const { gid } = await jobs.add({ ...DEFAULTS, url: PROBE.url, dir }, PROBE as never)
    state.runners[0]!.emit('file', target)
    const removing = jobs.remove(gid, false)
    state.runners[0]!.release()
    await removing

    expect(existsSync(path.join(dir, 'a video.mp4.partial-notes.txt'))).toBe(true)
    // A merge's own temp file is ours, though: it is named after the download.
    expect(existsSync(path.join(dir, 'a video.mp4.temp.mp4'))).toBe(false)
  })
})

describe('the names a partial file belongs to', () => {
  it('strips every temporary suffix back to the download', () => {
    expect(partialStem('C:\\vids\\影片.mp4')).toBe('C:\\vids\\影片.mp4')
    expect(partialStem('C:\\vids\\影片.mp4.part')).toBe('C:\\vids\\影片.mp4')
    expect(partialStem('C:\\vids\\影片.mp4.part-Frag12')).toBe('C:\\vids\\影片.mp4')
    expect(partialStem('C:\\vids\\影片.mp4.part-Frag12.part')).toBe('C:\\vids\\影片.mp4')
    // Not a suffix, so the name is untouched.
    expect(partialStem('C:\\vids\\my.part.song.mp4')).toBe('C:\\vids\\my.part.song.mp4')
  })

  it('matches only the download’s own working files', () => {
    expect(isPartialOf('影片.mp4', '影片.mp4.part')).toBe(true)
    expect(isPartialOf('影片.mp4', '影片.mp4.part-Frag3')).toBe(true)
    expect(isPartialOf('影片.mp4', '影片.mp4.part-Frag3.part')).toBe(true)
    expect(isPartialOf('影片.mp4', '影片.mp4.ytdl')).toBe(true)
    // What an ffmpeg merge writes before renaming it onto the download.
    expect(isPartialOf('影片.mp4', '影片.mp4.temp.mp4')).toBe(true)

    // Never the download itself, and never a neighbour that merely shares the
    // first few characters.
    expect(isPartialOf('影片.mp4', '影片.mp4')).toBe(false)
    expect(isPartialOf('影片.mp4', '影片.mp4.bak')).toBe(false)
    expect(isPartialOf('影片.mp4', '影片.mp4.partial-notes.txt')).toBe(false)
    expect(isPartialOf('影片.mp4', 'other 影片.mp4.part')).toBe(false)
  })
})
