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

function probeResult(directUrl = ''): MediaProbe {
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
    directUrl
  }
}

function makeRouter(options: { failProbe?: boolean; directUrl?: string; ytdlpAvailable?: boolean } = {}): {
  router: EngineRouter
  add: ReturnType<typeof vi.fn>
  addMedia: ReturnType<typeof vi.fn>
  probe: ReturnType<typeof vi.fn>
} {
  const add = vi.fn(async () => ({ gids: ['aria2-gid'], duplicates: [], warnings: [] }))
  const addMedia = vi.fn(async () => ({ gid: 'ytdlp:1' }))
  const probe = vi.fn(async () => {
    if (options.failProbe) throw new Error('unsupported url')
    return probeResult(options.directUrl)
  })

  const router = new EngineRouter({
    manager: { add } as never,
    mediaJobs: {
      binaryAvailable: options.ytdlpAvailable ?? true,
      hasFfmpeg: true,
      probe,
      add: addMedia
    } as never,
    getSettings: () => ({ ytdlpEnabled: true, ytdlpDetectSites: true, downloadDir: 'C:/downloads' }) as never,
    log: () => {}
  })

  return { router, add, addMedia, probe }
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

  it('hands a bare file to aria2 instead of yt-dlp when the probe resolves one', async () => {
    const resolved = 'https://blobs.example.com/file/abc123'
    const { router, add, addMedia } = makeRouter({ directUrl: resolved })

    const result = await router.add(input())

    // The resolved URL is what gets downloaded — not the page that redirected to it.
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ uris: [resolved], engine: 'aria2' })
    )
    // yt-dlp's single connection and per-run startup are what made this slow.
    expect(addMedia).not.toHaveBeenCalled()
    expect(result.gids).toEqual(['aria2-gid'])
  })
})
