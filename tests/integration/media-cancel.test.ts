import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MediaJobs } from '../../src/main/media/jobs'

import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server'
import { waitFor } from '../helpers/records'

/**
 * What a cancelled download leaves in the folder, with the real yt-dlp doing it.
 *
 * The unit cases cover the names and the policy; what they cannot cover is the
 * part that only happens for real — a child process that is killed while it still
 * has `.part` open. On Windows a file a live process holds cannot be removed at
 * all, so a delete that is issued before the process is gone does not fail loudly:
 * it leaves the file exactly where it was, which is the reported bug.
 *
 * The bundled binary is what runs here, so the suite only runs where it has been
 * fetched — same rule as the aria2 engine tests.
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const binary = (name: string): string =>
  path.join(projectRoot, 'resources', 'bin', process.platform === 'win32' ? `${name}.exe` : name)

const ytdlpBinary = binary('yt-dlp')
const ffmpegBinary = binary('ffmpeg')

const suite = existsSync(ytdlpBinary) ? describe : describe.skip

/** A probe answer, so a download can be queued without running one first. */
function probe(url: string) {
  return {
    url,
    title: 'cancel me',
    id: 'cancel-me',
    durationSeconds: 0,
    thumbnail: '',
    formats: [
      {
        formatId: 'best',
        label: 'best · mp4',
        ext: 'mp4',
        resolution: '1080p',
        filesize: null,
        vcodec: 'avc1',
        acodec: 'mp4a',
        note: '',
        needsFfmpeg: false
      }
    ],
    isPlaylist: false,
    extractor: 'generic',
    directUrl: '',
    formatUrls: {}
  }
}

suite('cancelling a download a real yt-dlp is running', () => {
  let root = ''
  let server: FixtureServer
  let jobs: MediaJobs
  const logs: string[] = []

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-cancel-e2e-'))
    // Slow enough that a segment takes about two seconds: the fragment files
    // only exist while a piece is in flight, so a server that answers at once
    // would let a run finish before anything could be observed.
    server = await startFixtureServer({
      slowSizeBytes: 64 * 1024 * 1024,
      slowChunkBytes: 128 * 1024,
      slowDelayMs: 120,
      hlsSegments: 60,
      hlsSegmentBytes: 2 * 1024 * 1024
    })

    jobs = new MediaJobs({
      history: {
        upsert: () => {},
        flush: async () => {},
        patchDeferred: () => {},
        remove: () => {}
      } as never,
      getBinaryPath: () => ytdlpBinary,
      getFfmpegPath: () => (existsSync(ffmpegBinary) ? ffmpegBinary : ''),
      getCookieArgs: () => [],
      getConcurrentFragments: () => 4,
      log: (line) => logs.push(line)
    })
  }, 120_000)

  afterAll(async () => {
    jobs?.killAll()
    await server?.close()
    await fsp.rm(root, { recursive: true, force: true })
  })

  /** A folder of its own per case, so one run's debris cannot answer for another. */
  function folder(name: string): string {
    const dir = path.join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function names(dir: string): string[] {
    return readdirSync(dir).sort()
  }

  it('deletes the .part file of a download cancelled mid-flight', async () => {
    const dir = folder('plain')
    const { gid } = await jobs.add(
      {
        url: `${server.origin}/slow.bin`,
        formatId: 'best',
        dir,
        audioOnly: false,
        playlist: false,
        maxConcurrent: 0,
        title: 'cancel-me'
      },
      probe(`${server.origin}/slow.bin`) as never
    )

    // The run is writing `<name>.<ext>.part` by now — that file is the byte
    // evidence, and it is what has to be gone afterwards.
    await waitFor(() => names(dir).some((name) => name.endsWith('.part')), {
      timeoutMs: 60_000,
      label: 'the .part file of the running download'
    })
    const before = names(dir)
    expect(before.some((name) => name.startsWith('cancel-me'))).toBe(true)

    await jobs.remove(gid, false)

    expect(names(dir)).toEqual([])
    expect(jobs.items()).toEqual([])
    expect(logs.filter((line) => line.includes('failed to delete'))).toEqual([])
  }, 120_000)

  it('deletes the fragments and the .ytdl of a segmented download cancelled mid-flight', async () => {
    // This is the case the report came from: an HLS download fetched in pieces
    // leaves `index [index].mp4.part`, one `<…>.part-FragN` per piece that has
    // arrived, a `<…>.part-FragN.part` for each still arriving, and the `.ytdl`
    // session file — nine of them in the screenshot, none of which went away.
    const dir = folder('hls')
    const { gid } = await jobs.add(
      {
        url: server.hlsUrl,
        formatId: 'best',
        dir,
        audioOnly: false,
        playlist: false,
        maxConcurrent: 0,
        title: 'hls-cancel'
      },
      probe(server.hlsUrl) as never
    )

    await waitFor(() => names(dir).some((name) => name.includes('.part-Frag')), {
      timeoutMs: 60_000,
      label: 'a fragment file of the running download'
    })
    const before = names(dir)
    expect(before.some((name) => name.endsWith('.ytdl'))).toBe(true)

    await jobs.remove(gid, false)

    expect(names(dir)).toEqual([])
    expect(logs.filter((line) => line.includes('failed to delete'))).toEqual([])
  }, 120_000)

  it('keeps the partial file when the download is only paused', async () => {
    // Pausing is not cancelling: `-c` continues from that file, so a pause that
    // took it away would make resume start the download over.
    const dir = folder('paused')
    const { gid } = await jobs.add(
      {
        url: `${server.origin}/slow.bin`,
        formatId: 'best',
        dir,
        audioOnly: false,
        playlist: false,
        maxConcurrent: 0,
        title: 'paused-job'
      },
      probe(`${server.origin}/slow.bin`) as never
    )

    await waitFor(() => names(dir).some((name) => name.endsWith('.part')), {
      timeoutMs: 60_000,
      label: 'the .part file of the running download'
    })

    await jobs.pause(gid)

    expect(jobs.get(gid)!.status).toBe('paused')
    expect(names(dir).some((name) => name.endsWith('.part'))).toBe(true)

    // And it goes when the row does, since nothing can resume it any more.
    await jobs.remove(gid, false)
    expect(names(dir)).toEqual([])
  }, 120_000)
})
