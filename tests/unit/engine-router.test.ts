import { describe, expect, it, vi } from 'vitest'

import type { AddDownloadInput } from '../../src/shared/settings'
import type { MediaProbe } from '../../src/main/media/ytdlp'
import type { PageScan } from '../../src/main/media/page-sniff'
import { EngineRouter } from '../../src/main/downloads/engine-router'

/**
 * The router is what decides whether a handoff becomes a video download or a
 * plain file download, so its failure modes are worth pinning down: an explicit
 * "this is a video" request must not silently become an HTML file, an auto-routed
 * link should still fall back rather than fail outright, and a probe that found
 * nothing but a bare file must not be handed to yt-dlp — that is the slow path.
 *
 * The page sniff feeds this in, and what it *returns* is as important as its
 * verdict: an unknown-host player page is not something yt-dlp can read, so the
 * manifest the screen hid has to be carried through to the command line, and a
 * play list must never be handed to aria2.
 */

function input(overrides: Partial<AddDownloadInput> = {}): AddDownloadInput {
  return { uris: ['https://www.youtube.com/watch?v=abc'], engine: 'auto', ...overrides } as AddDownloadInput
}

function probeResult(directUrl = '', overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'a video',
    id: 'abc',
    durationSeconds: 0,
    thumbnail: '',
    subtitles: [],
    formats: [
      {
        formatId: 'bestvideo+bestaudio/best',
        label: '最佳畫質（自動合併音訊）',
        ext: 'mp4',
        resolution: '1080p',
        filesize: null,
        vcodec: 'auto',
        acodec: 'auto',
        note: '',
        needsFfmpeg: true
      },
      {
        formatId: '137',
        label: '1080p · mp4',
        ext: 'mp4',
        resolution: '1080p',
        filesize: null,
        vcodec: 'avc1',
        acodec: 'none',
        note: '',
        needsFfmpeg: true
      }
    ],
    isPlaylist: false,
    extractor: directUrl ? 'generic' : 'youtube',
    directUrl,
    formatUrls: {},
    ...overrides
  }
}

function makeRouter(
  options: {
    failProbe?: boolean
    hangProbe?: boolean
    directUrl?: string
    probe?: Partial<MediaProbe>
    ytdlpAvailable?: boolean
    autoDetect?: boolean
    scan?: Partial<PageScan>
  } = {}
): {
  router: EngineRouter
  add: ReturnType<typeof vi.fn>
  addMedia: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  scan: ReturnType<typeof vi.fn>
} {
  const add = vi.fn(async () => ({ gids: ['aria2-gid'], duplicates: [], warnings: [] }))
  const addMedia = vi.fn(async () => ({ gid: 'ytdlp:1' }))
  const probe = vi.fn(async () => {
    // A probe that never answers stands in for the credential-free retry that
    // runs until its timeout on a site that refuses the session.
    if (options.hangProbe) return new Promise<MediaProbe>(() => {})
    if (options.failProbe) throw new Error('unsupported url')
    return probeResult(options.directUrl, options.probe)
  })
  const scan = vi.fn(async () => ({
    verdict: 'not-media',
    mediaUrls: [],
    streamUrls: [],
    title: '',
    blocked: false,
    ...options.scan
  }))

  const router = new EngineRouter({
    manager: { add } as never,
    mediaJobs: {
      binaryAvailable: options.ytdlpAvailable ?? true,
      hasFfmpeg: true,
      probe,
      add: addMedia
    } as never,
    sniffer: { scan } as never,
    getSettings: () => ({
      ytdlpEnabled: true,
      ytdlpDetectSites: options.autoDetect ?? true,
      downloadDir: 'C:/downloads'
    }) as never,
    log: () => {}
  })

  return { router, add, addMedia, probe, scan }
}

describe('EngineRouter', () => {
  it('routes an explicit video request to yt-dlp', async () => {
    const { router, addMedia } = makeRouter()
    const result = await router.add(input({ engine: 'ytdlp' }))

    expect(result.gids).toEqual(['ytdlp:1'])
    expect(addMedia).toHaveBeenCalledOnce()
  })

  it('still downloads the default quality when a video probe fails', async () => {
    // The browser's "download this video" names no quality, so a probe that is
    // refused or left unanswered must not fail the click: yt-dlp resolves the
    // default selector in the download run itself. What must never happen is
    // handing the page URL to aria2, or the user ends up with the web page
    // saved as a file.
    const { router, add, addMedia } = makeRouter({ failProbe: true })

    const result = await router.add(input({ engine: 'ytdlp' }))

    expect(result.gids).toEqual(['ytdlp:1'])
    expect(addMedia).toHaveBeenCalledOnce()
    expect(addMedia.mock.calls[0]![0]).toMatchObject({ formatId: 'bestvideo+bestaudio/best' })
    expect(add).not.toHaveBeenCalled()
  })

  it('does not wait out a stalled probe before starting the default download', async () => {
    // The probe is not required for a request that named no quality, so a probe
    // that hangs — the credential-free retry on a site that refuses the session
    // — must not hold the click. The download starts on the provisional default
    // as soon as the short budget expires; before this, the extension's button
    // sat on the probe's own timeout (tens of seconds) and then failed.
    vi.useFakeTimers()
    try {
      const { router, addMedia } = makeRouter({ hangProbe: true })
      const started = router.add(input({ engine: 'ytdlp' }))

      await vi.advanceTimersByTimeAsync(4_000)
      const result = await started

      expect(result.gids).toEqual(['ytdlp:1'])
      expect(addMedia.mock.calls[0]![0]).toMatchObject({ formatId: 'bestvideo+bestaudio/best' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an audio-only request to the audio track', async () => {
    // The extension's panel over an <audio> element is the only place that knows
    // the page is music, and nothing downstream can recover that from the page
    // URL — so it travels as a flag, and it has to arrive as one.
    const { router, addMedia } = makeRouter({})

    const result = await router.add(input({ engine: 'ytdlp', mediaAudioOnly: true }))

    expect(result.gids).toEqual(['ytdlp:1'])
    expect(addMedia.mock.calls[0]![0]).toMatchObject({ audioOnly: true, formatId: 'bestaudio/best' })
  })

  it('asks for the best audio even when the probe never answers', async () => {
    const { router, addMedia } = makeRouter({ failProbe: true })

    await router.add(input({ engine: 'ytdlp', mediaAudioOnly: true }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ audioOnly: true, formatId: 'bestaudio/best' })
  })

  it('still defaults to video when the audio flag is absent', async () => {
    const { router, addMedia } = makeRouter({})

    await router.add(input({ engine: 'ytdlp' }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ audioOnly: false })
  })

  it('refuses a named quality when the probe that offered it cannot answer', async () => {
    // A quality is only real against the list it was chosen from, so without a
    // probe there is nothing to honour — and silently downloading a different
    // one would be worse than saying the video could not be fetched.
    const { router, addMedia } = makeRouter({ failProbe: true })

    await expect(router.add(input({ engine: 'ytdlp', mediaFormatId: '137' }))).rejects.toThrow(
      /無法取得影片/
    )
    expect(addMedia).not.toHaveBeenCalled()
  })

  it('still falls back to aria2 for an auto-routed media link', async () => {
    const { router, add } = makeRouter({ failProbe: true })
    const result = await router.add(input({ engine: 'auto' }))

    expect(add).toHaveBeenCalledOnce()
    expect(result.warnings.join()).toMatch(/yt-dlp/)
  })

  it('does not label an aria2 fallback as a yt-dlp download', async () => {
    // yt-dlp is missing, so the explicit video request cannot be honoured. The
    // row must say aria2 — claiming yt-dlp is how a page-saved-as-a-file looked
    // like a video download.
    const { router, add } = makeRouter({ ytdlpAvailable: false })

    const result = await router.add(input({ engine: 'ytdlp' }))

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ engine: 'aria2' }))
    expect(result.warnings.join()).toMatch(/yt-dlp/)
  })

  it('gives a browser capture the app\u2019s download folder', async () => {
    // A handoff carries no directory, and aria2 hides that: it falls back to the
    // engine's own --dir. yt-dlp is told where to write per run, so an empty
    // value meant `--paths ''` and the file went next to the app's executable —
    // inside Program Files, reported as "[Errno 13] Permission denied".
    const { router, addMedia } = makeRouter()

    await router.add(input({ engine: 'ytdlp', dir: '' }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ dir: 'C:/downloads' })
  })

  it('keeps the directory a request did ask for', async () => {
    const { router, addMedia } = makeRouter()

    await router.add(input({ engine: 'ytdlp', dir: 'D:/videos' }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ dir: 'D:/videos' })
  })

  it('downloads the quality the caller picked', async () => {
    const { router, addMedia } = makeRouter()

    await router.add(input({ engine: 'ytdlp', mediaFormatId: '137' }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ formatId: '137' })
  })

  it('ignores a quality this probe never offered', async () => {
    // A menu can be clicked seconds after it was built, and the page may have
    // changed under it; the fallback is the default, not a failed download.
    const { router, addMedia } = makeRouter()

    await router.add(input({ engine: 'ytdlp', mediaFormatId: 'no-such-format' }))

    expect(addMedia.mock.calls[0]![0]).toMatchObject({ formatId: 'bestvideo+bestaudio/best' })
  })

  it('sends an unknown-host video page to yt-dlp when the sniff finds a player', async () => {
    // The whole feature: `acgmho.com` is not on the curated list, but its page
    // carries a player, so the link belongs to yt-dlp.
    const { router, add, addMedia, scan } = makeRouter({ scan: { verdict: 'media' } })

    const result = await router.add(input({ uris: ['https://www.acgmho.com/gif/883534.html'] }))

    expect(scan).toHaveBeenCalledWith('https://www.acgmho.com/gif/883534.html', expect.any(Object))
    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['ytdlp:1'])
  })

  it('handles the manifest a player page hid, instead of the page yt-dlp cannot read', async () => {
    // The reported failure, end to end: `gimytv.io/eps/…html` holds nothing but
    // an iframe, and yt-dlp answers "Unsupported URL" for both the page and the
    // frame. The manifest inside the frame downloads perfectly once it is the
    // URL on the command line — and it must carry the page's referer, because
    // that CDN serves a manifest only to the player it belongs to.
    const manifest = 'https://vip.ffzy-play10.com/20260921/71771_e500813b/index.m3u8'
    const page = 'https://gimytv.io/eps/202670754-hdtc-zhong-zi-v2.html'
    const { router, add, addMedia, probe } = makeRouter({
      scan: { verdict: 'media', streamUrls: [manifest], title: '生化危機：爆發夜' }
    })

    const result = await router.add(input({ uris: [page], engine: 'ytdlp' }))

    expect(probe.mock.calls[0]![0]).toBe(manifest)
    expect(probe.mock.calls[0]![1]).toMatchObject({ referer: page })
    expect(addMedia).toHaveBeenCalledOnce()
    expect(addMedia.mock.calls[0]![0]).toMatchObject({ url: manifest, title: '生化危機：爆發夜' })
    expect(add).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['ytdlp:1'])
  })

  it('reads the page for an explicit video request even when auto-detection is off', async () => {
    // 自動辨識 governs an automatic guess. The extension's button is not a guess,
    // and this read is the only way its link can be downloaded at all.
    const { router, addMedia, scan } = makeRouter({
      autoDetect: false,
      scan: { verdict: 'media', streamUrls: ['https://cdn.example/index.m3u8'] }
    })

    await router.add(input({ uris: ['https://gimytv.io/eps/x.html'], engine: 'ytdlp' }))

    expect(scan).toHaveBeenCalledOnce()
    expect(addMedia).toHaveBeenCalledOnce()
  })

  it('downloads a page that links one plain file with aria2, without probing it', async () => {
    // The file needs no extraction, and aria2 fetches one file with a real size
    // and its full fan-out where yt-dlp uses one connection and reports nothing.
    const file = 'https://cdn.example/v/movie.mp4'
    const { router, add, addMedia, probe } = makeRouter({
      scan: { verdict: 'media', mediaUrls: [file] }
    })

    const result = await router.add(input({ uris: ['https://example.test/eps/1.html'] }))

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        uris: [file],
        engine: 'aria2',
        tags: ['aria2-direct'],
        split: 16,
        maxConnectionPerServer: 16,
        minSplitSize: 1024 * 1024
      })
    )
    expect(probe).not.toHaveBeenCalled()
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })

  it('leaves a page that lists several files to the normal probe', async () => {
    // Two files is a listing of episodes, not one video: picking one for the
    // user would be a guess.
    const { router, add, addMedia } = makeRouter({
      scan: {
        verdict: 'media',
        mediaUrls: ['https://cdn.example/v/1.mp4', 'https://cdn.example/v/2.mp4']
      }
    })

    await router.add(input({ uris: ['https://example.test/eps/1.html'] }))

    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
  })

  it('fails rather than saving the play list when a manifest probe fails', async () => {
    // The old fallback handed aria2 the page, and the page is HTML; handing it
    // the manifest instead would save a text file under a .mp4 name. Neither is
    // a download, so this reports the failure.
    const { router, add } = makeRouter({
      failProbe: true,
      scan: { verdict: 'media', streamUrls: ['https://cdn.example/index.m3u8'] }
    })

    await expect(router.add(input({ uris: ['https://gimytv.io/eps/x.html'] }))).rejects.toThrow(
      /無法取得影片/
    )
    expect(add).not.toHaveBeenCalled()
  })

  it('keeps an unknown-host link on aria2 when the sniff finds no player', async () => {
    const { router, add, addMedia } = makeRouter({ scan: { verdict: 'not-media' } })

    const result = await router.add(input({ uris: ['https://example.test/some/page'] }))

    expect(add).toHaveBeenCalledOnce()
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })

  it('treats a failed sniff as not media', async () => {
    // A timeout or a network error must never turn a plain link into a video.
    const { router, add, addMedia } = makeRouter({ scan: { verdict: 'unknown' } })

    await router.add(input({ uris: ['https://example.test/some/page'] }))

    expect(add).toHaveBeenCalledOnce()
    expect(addMedia).not.toHaveBeenCalled()
  })

  it('does not sniff when auto-detection is off', async () => {
    const { router, scan, add } = makeRouter({ autoDetect: false, scan: { verdict: 'media' } })

    await router.add(input({ uris: ['https://www.acgmho.com/gif/883534.html'] }))

    expect(scan).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledOnce()
  })

  it('does not sniff a URL that names a file', async () => {
    const { router, scan, add } = makeRouter({ scan: { verdict: 'media' } })

    await router.add(input({ uris: ['https://example.test/archive.zip'] }))

    expect(scan).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledOnce()
  })

  it('says the page was refused rather than leaving a mystery aria2 error', async () => {
    // The reported shape: a site behind a bot check answers the page fetch with
    // 403, so no player is ever seen and the link falls to aria2. Without this the
    // only trace the user gets is aria2's own "unknown error", which says nothing
    // about the site blocking non-browser clients.
    const { router, add } = makeRouter({ scan: { verdict: 'unknown', blocked: true } })

    const result = await router.add(
      input({ uris: ['https://rule34.xxx/index.php?page=post&s=view&id=1'] })
    )

    expect(add).toHaveBeenCalledOnce()
    expect(result.warnings.join()).toMatch(/防護/)
  })

  it('does not sniff when the request explicitly asked for aria2', async () => {
    const { router, scan, add } = makeRouter({ scan: { verdict: 'media' } })

    await router.add(input({ uris: ['https://www.acgmho.com/gif/883534.html'], engine: 'aria2' }))

    expect(scan).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ engine: 'aria2' }))
  })

  it('sends a manifest link to yt-dlp rather than letting aria2 save the text', async () => {
    // `.m3u8` is the right shape to look like a file extension, so it used to be
    // treated as one: aria2 saved the play list. It is a play list on any host.
    const { router, add, addMedia, scan } = makeRouter()

    const result = await router.add(input({ uris: ['https://cdn.example/index.m3u8'] }))

    expect(scan).not.toHaveBeenCalled()
    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['ytdlp:1'])
  })

  it('refuses a manifest when yt-dlp cannot fetch it', async () => {
    // With no yt-dlp there is no engine that can turn a play list into a video,
    // and saving the play list is not a download.
    const { router, add } = makeRouter({ ytdlpAvailable: false })

    await expect(router.add(input({ uris: ['https://cdn.example/index.m3u8'] }))).rejects.toThrow(
      /HLS/
    )
    expect(add).not.toHaveBeenCalled()
  })

  it('hands a bare file to aria2 instead of yt-dlp when the probe resolves one', async () => {
    // `directUrl` is the generic extractor's own answer, so a page that links a
    // single payload is caught even when the sniff said nothing about it.
    const resolved = 'https://blobs.example.com/file/abc123'
    const { router, add, addMedia } = makeRouter({ directUrl: resolved })

    const result = await router.add(input())

    // The resolved URL is what gets downloaded — not the page that redirected to it.
    // The fixed fan-out is what beats a CDN throttling a single connection.
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        uris: [resolved],
        engine: 'aria2',
        tags: ['aria2-direct'],
        split: 16,
        maxConnectionPerServer: 16,
        minSplitSize: 1024 * 1024
      })
    )
    // yt-dlp's single connection and per-run startup are what made this slow.
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })

  it('hands a single progressive file from a recognised site to aria2', async () => {
    const resolved = 'https://cdn.example.com/v/abc.mp4'
    const { router, add, addMedia } = makeRouter({
      probe: {
        formats: [
          {
            formatId: 'hd',
            label: '1080p · mp4',
            ext: 'mp4',
            resolution: '1080p',
            filesize: null,
            vcodec: 'avc1',
            acodec: 'mp4a',
            note: '',
            needsFfmpeg: false
          }
        ],
        formatUrls: { hd: resolved }
      }
    })

    const result = await router.add(input({ mediaFormatId: 'hd' }))

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        uris: [resolved],
        engine: 'aria2',
        out: 'a video.mp4',
        tags: ['aria2-direct'],
        split: 16,
        maxConnectionPerServer: 16,
        minSplitSize: 1024 * 1024
      })
    )
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })

  it('keeps the tags it was given while marking a direct-file media link', async () => {
    const resolved = 'https://blobs.example.com/file/abc123'
    const { router, add } = makeRouter({ directUrl: resolved })

    await router.add(input({ tags: ['keep-me'] }))

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['keep-me', 'aria2-direct'] })
    )
  })

  it('keeps a manifest-backed stream on yt-dlp', async () => {
    const { router, add, addMedia } = makeRouter({
      probe: {
        formats: [
          {
            formatId: 'dash',
            label: '1080p · mp4',
            ext: 'mp4',
            resolution: '1080p',
            filesize: null,
            vcodec: 'avc1',
            acodec: 'mp4a',
            note: '',
            needsFfmpeg: false
          }
        ],
        // No plain-URL mapping: this format is fetched through a manifest.
        formatUrls: {}
      }
    })

    await router.add(input({ mediaFormatId: 'dash' }))

    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
  })

  it('keeps a video-only format on yt-dlp even when it has a plain URL', async () => {
    const { router, add, addMedia } = makeRouter({
      probe: {
        formats: [
          {
            formatId: 'video-only',
            label: '1080p · mp4',
            ext: 'mp4',
            resolution: '1080p',
            filesize: null,
            vcodec: 'avc1',
            acodec: 'none',
            note: '',
            needsFfmpeg: true
          }
        ],
        // A URL is present, but muxing the audio back in needs ffmpeg.
        formatUrls: { 'video-only': 'https://cdn.example.com/v/only.mp4' }
      }
    })

    await router.add(input({ mediaFormatId: 'video-only' }))

    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
  })
})
