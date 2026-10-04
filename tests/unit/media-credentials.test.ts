import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'

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
  directUrl: '',
  formatUrls: {}
}

const LOCKED = 'ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info'
const UNDECRYPTABLE = 'ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info'
const STALE_SESSION = 'ERROR: [youtube] abc: The page needs to be reloaded.'
// Instagram handed a sessionid answers with an empty body, which yt-dlp reports
// as a JSON parse failure; the same URL resolves fine with no cookies sent.
const EMPTY_RESPONSE =
  'ERROR: [Instagram] abc: Failed to parse JSON (caused by JSONDecodeError("Expecting value in \'\': line 1 column 1 (char 0)"))'

const cookieDir = mkdtempSync(path.join(tmpdir(), 'ariadm-jobs-cookies-'))

afterAll(() => {
  rmSync(cookieDir, { recursive: true, force: true })
})

function makeJobs(options: { cookieArgs?: string[] } = {}) {
  const jobs = new MediaJobs({
    history: { upsert: vi.fn(), flush: async () => {}, patchDeferred: vi.fn(), remove: vi.fn() } as never,
    getBinaryPath: () => 'yt-dlp.exe',
    getFfmpegPath: () => '',
    getCookieArgs: () => options.cookieArgs ?? STORE_ARGS,
    cookieDir,
    log: () => {}
  })
  return jobs
}

/** Wait, briefly, for an asynchronously deleted file to disappear. */
async function waitUntilGone(file: string): Promise<void> {
  for (let index = 0; index < 50 && existsSync(file); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
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

  it('shares one run between probes asked for at the same time', async () => {
    // The quality menu and the optimistic download now race for the same link, so
    // the second ask must join the first run rather than spawn a second yt-dlp —
    // the whole point of starting the download before the probe answers.
    let release: ((value: typeof PROBE) => void) | null = null
    state.probeFormats.mockImplementation(
      () => new Promise<typeof PROBE>((resolve) => { release = resolve })
    )
    const jobs = makeJobs()

    const first = jobs.probe(PROBE.url)
    const second = jobs.probe(PROBE.url)
    // Let the shared run reach the (faked) yt-dlp before answering it.
    for (let index = 0; index < 50 && release === null; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    release!(PROBE)

    const [a, b] = await Promise.all([first, second])
    expect(state.probeFormats).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('runs again once the shared run has settled', async () => {
    // An in-flight entry is not a cache: a later ask gets its own yt-dlp run.
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url, {}, { reuse: false })
    await jobs.probe(PROBE.url, {}, { reuse: false })

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
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

  it('writes the extension session to a cookies file the run can read', async () => {
    // The whole point of Part 1: a `Cookie:` header never fills yt-dlp's jar, so
    // the extension's session is written to a file and passed as `--cookies`.
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url, { cookieHeader: 'auth_token=abc' })
    expect(state.probeFormats.mock.calls[0]![2].cookieFile).toBeTruthy()

    const probe = await jobs.probe(PROBE.url, { cookieHeader: 'auth_token=abc' })
    const { gid } = await jobs.add(addInput(), probe, { cookieHeader: 'auth_token=abc' })

    const file = runnerOptions(0).cookieFile as string
    expect(file).toBeTruthy()
    expect(existsSync(file)).toBe(true)

    // The file is a credential, so it does not outlive the run.
    await jobs.remove(gid, false)
    await waitUntilGone(file)
    expect(existsSync(file)).toBe(false)
  })

  it('drops the session when the site answers with nothing at all', async () => {
    // The live Instagram failure: the panel hands over the browser's own cookies
    // (which include a sessionid), and yt-dlp's extractor sees an empty body.
    state.probeFormats.mockRejectedValueOnce(new Error(EMPTY_RESPONSE)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    await expect(
      jobs.probe(PROBE.url, { cookieHeader: 'sessionid=abc', referer: PROBE.url })
    ).resolves.toMatchObject({ id: 'abc' })

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
    expect(state.probeFormats.mock.calls[1]![2].cookieHeader).toBe('')
    expect(state.probeFormats.mock.calls[1]![2].cookieArgs).toEqual([])
  })

  it('blames the cookie store for an empty response when the store was in use', async () => {
    state.probeFormats.mockRejectedValueOnce(new Error(EMPTY_RESPONSE)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).resolves.toMatchObject({ id: 'abc' })
    expect(state.probeFormats.mock.calls[1]![2].cookieArgs).toEqual([])
    expect(state.probeFormats.mock.calls[1]![2].cookieHeader).toBeFalsy()
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

describe('MediaJobs probe reuse', () => {
  /**
   * The quality menu and the download it leads to ask the same question a second
   * apart, and each answer costs a yt-dlp run. Reusing the first is what turns a
   * two-probe click into a one-probe click; over Instagram, where the first
   * attempt with a `sessionid` always fails, it also removes the doomed retry.
   */
  it('answers a repeated probe from the first run', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url)
    const again = await jobs.probe(PROBE.url)

    expect(state.probeFormats).toHaveBeenCalledTimes(1)
    expect(again).toMatchObject({ id: 'abc' })
  })

  it('treats a different cookie header as a different question', async () => {
    // Two sessions can disagree: one resolves and one is refused, so they must
    // not share an answer.
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url, { cookieHeader: 'sessionid=one' })
    await jobs.probe(PROBE.url, { cookieHeader: 'sessionid=two' })

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
  })

  it('carries the credentials that made the probe work into the download', async () => {
    // The store failed, so the verdict dropped it. A reused probe must restore
    // that verdict, or the download would send the credential the probe already
    // proved unusable.
    state.probeFormats.mockRejectedValueOnce(new Error(LOCKED)).mockResolvedValueOnce(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url)
    const probe = await jobs.probe(PROBE.url)
    await jobs.add(addInput(), probe)

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
    expect(runnerOptions(0).cookieArgs).toEqual([])
  })

  it('asks again when the caller says so', async () => {
    // What the menu's own refresh means: the answer on screen is the one the
    // user is replacing.
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    await jobs.probe(PROBE.url, {}, { reuse: false })
    await jobs.probe(PROBE.url, {}, { reuse: false })

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
  })

  it('never remembers a failure', async () => {
    state.probeFormats.mockRejectedValue(new Error('ERROR: [youtube] abc: Video unavailable'))
    const jobs = makeJobs()

    await expect(jobs.probe(PROBE.url)).rejects.toThrow()
    await expect(jobs.probe(PROBE.url)).rejects.toThrow()

    expect(state.probeFormats).toHaveBeenCalledTimes(2)
  })

  it('forgets a link whose download failed', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()

    const probe = await jobs.probe(PROBE.url)
    const { gid } = await jobs.add(addInput(), probe)
    state.runners[0]!.emit('failed', 'ERROR: [youtube] abc: Video unavailable')
    expect(jobs.get(gid)!.status).toBe('error')

    await jobs.probe(PROBE.url)

    // The answer was good enough to build a menu from, not good enough to
    // download, so asking again has to reach yt-dlp.
    expect(state.probeFormats).toHaveBeenCalledTimes(2)
  })

  it('keeps only the newest handful of answers', async () => {
    state.probeFormats.mockResolvedValue(PROBE)
    const jobs = makeJobs()
    const urls = Array.from({ length: 9 }, (_, index) => `https://example.test/v/${index}`)

    for (const url of urls) await jobs.probe(url)
    expect(state.probeFormats).toHaveBeenCalledTimes(9)

    // The first one has aged out...
    await jobs.probe(urls[0]!)
    expect(state.probeFormats).toHaveBeenCalledTimes(10)
    // ...while the newest are still there.
    await jobs.probe(urls[8]!)
    expect(state.probeFormats).toHaveBeenCalledTimes(10)
  })
})
