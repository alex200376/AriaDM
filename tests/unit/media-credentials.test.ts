import { describe, expect, it, vi, beforeEach } from 'vitest'

import { MediaJobs } from '../../src/main/media/jobs'

/**
 * Cookies must never make a download impossible.
 *
 * Two independent things go wrong with credentials, and both used to be fatal:
 * yt-dlp refuses to run at all when a Chromium cookie store cannot be read
 * (issue 10927, app-bound encryption — the browser merely being open is enough),
 * and some sites answer a *logged-in* cookie jar with a page they will not play
 * (YouTube's "The page needs to be reloaded"). Most videos need no session at
 * all, so the app should notice which credential was in use, drop exactly that
 * one, and try once more.
 *
 * The toolchain is faked: these tests are about which arguments AriaDM builds,
 * and a real yt-dlp run would need a live site and a real cookie store.
 */

const state = vi.hoisted(() => ({
  probeFormats: vi.fn(),
  runners: [] as FakeRunnerLike[]
}))

interface FakeRunnerLike {
  options: Record<string, unknown>
  started: boolean
  killed: boolean
  emit(event: string, ...args: unknown[]): boolean
}

vi.mock('../../src/main/media/ytdlp', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeRunner extends EventEmitter implements FakeRunnerLike {
    options: Record<string, unknown>
    started = false
    killed = false
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      state.runners.push(this)
    }
    start(): void {
      this.started = true
    }
    kill(): void {
      this.killed = true
    }
  }
  return { probeFormats: state.probeFormats, YtDlpRunner: FakeRunner }
})

const STORE_ARGS = ['--cookies-from-browser', 'chrome:Default']

const PROBE = {
  url: 'https://www.youtube.com/watch?v=abc',
  title: 'a video',
  id: 'abc',
  durationSeconds: 0,
  thumbnail: '',
  formats: [],
  isPlaylist: false,
  extractor: 'youtube',
  directUrl: ''
}

const LOCKED = 'ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info'
const UNDECRYPTABLE = 'ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info'
const STALE_SESSION = 'ERROR: [youtube] abc: The page needs to be reloaded.'

function makeJobs(options: { cookieArgs?: string[] } = {}) {
  const jobs = new MediaJobs({
    history: { upsert: vi.fn(), flush: async () => {}, patchDeferred: vi.fn(), remove: vi.fn() } as never,
    getBinaryPath: () => 'yt-dlp.exe',
    getFfmpegPath: () => '',
    getCookieArgs: () => options.cookieArgs ?? STORE_ARGS,
    log: () => {}
  })
  return jobs
}

function addInput() {
  return {
    url: PROBE.url,
    formatId: 'bestvideo+bestaudio/best',
    dir: 'C:/downloads',
    audioOnly: false,
    playlist: false,
    maxConcurrent: 0
  }
}

/** The `options` object the nth launched download process was given. */
function runnerOptions(index: number): Record<string, unknown> {
  return state.runners[index]!.options
}

beforeEach(() => {
  state.probeFormats.mockReset()
  state.runners.length = 0
})

describe('MediaJobs credentials', () => {
  it('reads the browser store for a download, not just for the probe', async () => {
    // Without this the probe could succeed on a session the download never sent.
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    await jobs.add(addInput(), probe)

    expect(state.probeFormats.mock.calls[0]![2].cookieArgs).toEqual(STORE_ARGS)
    expect(runnerOptions(0).cookieArgs).toEqual(STORE_ARGS)
  })

  it('retries the probe without cookies when the cookie store cannot be read', async () => {
    state.probeFormats.mockRejectedValueOnce(new Error(UNDECRYPTABLE)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).resolves.toMatchObject({ id: 'abc' })

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
    expect(state.probeFormats.mock.calls[1]![2].cookieArgs).toEqual([])
  })

  it('keeps the store out of the download that such a probe belonged to', async () => {
    // The probe paid for the failure already; the download must not repeat it.
    state.probeFormats.mockRejectedValueOnce(new Error(LOCKED)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    await jobs.add(addInput(), probe)

    expect(runnerOptions(0).cookieArgs).toEqual([])
  })

  it('drops the session the extension handed over when the site refuses it', async () => {
    state.probeFormats.mockRejectedValueOnce(new Error(STALE_SESSION)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url, { cookieHeader: 'SID=stale', referer: PROBE.url })
    expect(state.probeFormats.mock.calls[1]![2].cookieHeader).toBe('')
    // The store was never the one in use, so it must not quietly replace it.
    expect(state.probeFormats.mock.calls[1]![2].cookieArgs).toEqual([])

    await jobs.add(addInput(), probe, { cookieHeader: 'SID=stale' })
    expect(runnerOptions(0).cookieHeader).toBe('')
    expect(runnerOptions(0).cookieArgs).toEqual([])
  })

  it('reports the credential-free failure when both attempts fail', async () => {
    state.probeFormats
      .mockRejectedValueOnce(new Error(LOCKED))
      .mockRejectedValueOnce(new Error('ERROR: [youtube] abc: Video unavailable'))
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).rejects.toThrow(/已被刪除/)
  })

  it('does not retry a failure that is asking for a session rather than blaming one', async () => {
    state.probeFormats.mockRejectedValue(
      new Error("ERROR: [youtube] abc: Sign in to confirm you're not a bot")
    )
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).rejects.toThrow(/要求登入驗證/)
    // Dropping the credentials here would just fail again, as a guest.
    expect(state.probeFormats).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failure that has nothing to do with credentials', async () => {
    state.probeFormats.mockRejectedValue(new Error('ERROR: [youtube] abc: Video unavailable'))
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).rejects.toThrow(/已被刪除/)
    expect(state.probeFormats).toHaveBeenCalledTimes(1)
  })

  it('does not retry when no credentials were available to give up', async () => {
    // A plain signed-out install: there is nothing to drop, so the failure is
    // the download's own.
    state.probeFormats.mockRejectedValue(new Error('ERROR: [youtube] abc: The page needs to be reloaded.'))
    const jobs = makeJobs({ cookieArgs: [] })

    await expect(jobs.probe(PROBE.url)).rejects.toThrow(/無法播放的頁面/)
    expect(state.probeFormats).toHaveBeenCalledTimes(1)
  })

  it('relaunches a failed download once without cookies', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    const { gid } = await jobs.add(addInput(), probe)
    expect(state.runners).toHaveLength(1)

    state.runners[0]!.emit('failed', LOCKED)

    expect(state.runners).toHaveLength(2)
    expect(runnerOptions(1).cookieArgs).toEqual([])
    // The retry is live, not an error row the user has to notice and retry.
    expect(jobs.get(gid)!.status).toBe('active')
  })

  it('gives up after that one credential-free attempt', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    const { gid } = await jobs.add(addInput(), probe)

    state.runners[0]!.emit('failed', LOCKED)
    state.runners[1]!.emit('failed', LOCKED)

    expect(state.runners).toHaveLength(2)
    expect(jobs.get(gid)!.status).toBe('error')
    expect(jobs.get(gid)!.errorMessage).toMatch(/Cookie 資料庫被鎖住/)
  })

  it('ends a download that failed for an unrelated reason', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    const { gid } = await jobs.add(addInput(), probe)

    state.runners[0]!.emit('failed', 'ERROR: [youtube] abc: Video unavailable')

    expect(state.runners).toHaveLength(1)
    expect(jobs.get(gid)!.status).toBe('error')
  })
})
