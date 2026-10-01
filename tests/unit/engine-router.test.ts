import { describe, expect, it, vi } from 'vitest'

import type { AddDownloadInput } from '../../src/shared/settings'
import { EngineRouter } from '../../src/main/downloads/engine-router'

/**
 * The router is what decides whether a handoff becomes a video download or a
 * plain file download, so its two failure modes are worth pinning down: an
 * explicit \"this is a video\" request must not silently become an HTML file, and
 * an auto-routed link should still fall back rather than fail outright.
 */

function input(overrides: Partial<AddDownloadInput> = {}): AddDownloadInput {
  return { uris: ['https://www.youtube.com/watch?v=abc'], engine: 'auto', ...overrides } as AddDownloadInput
}

function makeRouter(options: { failMedia?: boolean } = {}): {
  router: EngineRouter
  add: ReturnType<typeof vi.fn>
  addFromUrl: ReturnType<typeof vi.fn>
} {
  const add = vi.fn(async () => ({ gids: ['aria2-gid'], duplicates: [], warnings: [] }))
  const addFromUrl = vi.fn(async () => {
    if (options.failMedia) throw new Error('unsupported url')
    return { gid: 'ytdlp:1' }
  })

  const router = new EngineRouter({
    manager: { add } as never,
    mediaJobs: { binaryAvailable: true, addFromUrl } as never,
    getSettings: () =>
      ({ ytdlpEnabled: true, ytdlpDetectSites: true }) as never,
    log: () => {}
  })

  return { router, add, addFromUrl }
}

describe('EngineRouter', () => {
  it('routes an explicit video request to yt-dlp', async () => {
    const { router, addFromUrl } = makeRouter()
    const result = await router.add(input({ engine: 'ytdlp' }))

    expect(result.gids).toEqual(['ytdlp:1'])
    expect(addFromUrl).toHaveBeenCalledOnce()
  })

  it('reports a clear failure instead of downloading the page when a video cannot be resolved', async () => {
    const { router, add } = makeRouter({ failMedia: true })

    await expect(router.add(input({ engine: 'ytdlp' }))).rejects.toThrow(/無法取得影片/)
    // The whole point: aria2 must not be handed the URL, or the user ends up
    // with the web page saved as a file.
    expect(add).not.toHaveBeenCalled()
  })

  it('still falls back to aria2 for an auto-routed media link', async () => {
    const { router, add } = makeRouter({ failMedia: true })
    const result = await router.add(input({ engine: 'auto' }))

    expect(add).toHaveBeenCalledOnce()
    expect(result.warnings.join()).toMatch(/yt-dlp/)
  })
})
