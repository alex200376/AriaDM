import { describe, expect, it, vi } from 'vitest'

import type { AddDownloadInput } from '../../src/shared/settings'
import type { MediaProbe } from '../../src/main/media/ytdlp'
import { EngineRouter } from '../../src/main/downloads/engine-router'

/**
 * The router is what decides whether a handoff becomes a video download or a
 * plain file download, so its failure modes are worth pinning down: an explicit
 * "this is a video" request must not silently become an HTML file, an auto-routed
 * link should still fall back rather than fail outright, and a probe that found
 * nothing but a bare file must not be handed to yt-dlp — that is the slow path.
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
    directUrl?: string
    probe?: Partial<MediaProbe>
    ytdlpAvailable?: boolean
    autoDetect?: boolean
    sniff?: 'media' | 'not-media' | 'unknown'
  } = {}
): {
  router: EngineRouter
  add: ReturnType<typeof vi.fn>
  addMedia: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
  sniff: ReturnType<typeof vi.fn>
} {
  const add = vi.fn(async () => ({ gids: ['aria2-gid'], duplicates: [], warnings: [] }))
  const addMedia = vi.fn(async () => ({ gid: 'ytdlp:1' }))
  const probe = vi.fn(async () => {
    if (options.failProbe) throw new Error('unsupported url')
    return probeResult(options.directUrl, options.probe)
  })
  const sniff = vi.fn(async () => options.sniff ?? 'not-media')

  const router = new EngineRouter({
    manager: { add } as never,
    mediaJobs: {
      binaryAvailable: options.ytdlpAvailable ?? true,
      hasFfmpeg: true,
      probe,
      add: addMedia
    } as never,
    sniffer: { sniff } as never,
    getSettings: () => ({
      ytdlpEnabled: true,
      ytdlpDetectSites: options.autoDetect ?? true,
      downloadDir: 'C:/downloads'
    }) as never,
    log: () => {}
  })

  return { router, add, addMedia, probe, sniff }
}

describe('EngineRouter', () => {
  it('routes an explicit video request to yt-dlp', async () => {
    const { router, addMedia } = makeRouter()
    const result = await router.add(input({ engine: 'ytdlp' }))

    expect(result.gids).toEqual(['ytdlp:1'])
    expect(addMedia).toHaveBeenCalledOnce()
  })

  it('reports a clear failure instead of downloading the page when a video cannot be resolved', async () => {
    const { router, add } = makeRouter({ failProbe: true })

    await expect(router.add(input({ engine: 'ytdlp' }))).rejects.toThrow(/無法取得影片/)
    // The whole point: aria2 must not be handed the URL, or the user ends up
    // with the web page saved as a file.
    expect(add).not.toHaveBeenCalled()
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
    const { router, add, addMedia, sniff } = makeRouter({ sniff: 'media' })

    const result = await router.add(input({ uris: ['https://www.acgmho.com/gif/883534.html'] }))

    expect(sniff).toHaveBeenCalledWith('https://www.acgmho.com/gif/883534.html', expect.any(Object))
    expect(addMedia).toHaveBeenCalledOnce()
    expect(add).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['ytdlp:1'])
  })

  it('keeps an unknown-host link on aria2 when the sniff finds no player', async () => {
    const { router, add, addMedia } = makeRouter({ sniff: 'not-media' })

    const result = await router.add(input({ uris: ['https://example.test/some/page'] }))

    expect(add).toHaveBeenCalledOnce()
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })

  it('treats a failed sniff as not media', async () => {
    // A timeout or a network error must never turn a plain link into a video.
    const { router, add, addMedia } = makeRouter({ sniff: 'unknown' })

    await router.add(input({ uris: ['https://example.test/some/page'] }))

    expect(add).toHaveBeenCalledOnce()
    expect(addMedia).not.toHaveBeenCalled()
  })

  it('does not sniff when auto-detection is off', async () => {
    const { router, sniff, add } = makeRouter({ autoDetect: false, sniff: 'media' })

    await router.add(input({ uris: ['https://www.acgmho.com/gif/883534.html'] }))

    expect(sniff).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledOnce()
  })

  it('does not sniff a URL that names a file', async () => {
    const { router, sniff, add } = makeRouter({ sniff: 'media' })

    await router.add(input({ uris: ['https://example.test/archive.zip'] }))

    expect(sniff).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledOnce()
  })

  it('hands a bare file to aria2 instead of yt-dlp when the probe resolves one', async () => {
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
