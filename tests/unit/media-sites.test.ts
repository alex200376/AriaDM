import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  MEDIA_SITE_HOSTS,
  chooseEngine,
  isMediaSiteUrl,
  matchMediaSite,
  shouldWarnAboutMissingYtDlp
} from '@shared/media-sites'

const AVAILABLE = { ytdlpEnabled: true, autoDetect: true, ytdlpAvailable: true }

describe('matchMediaSite', () => {
  it('matches a host and any of its subdomains', () => {
    expect(matchMediaSite('https://x.com/someone/status/123')).toBe('x.com')
    expect(matchMediaSite('https://mobile.twitter.com/someone/status/123')).toBe('twitter.com')
    expect(matchMediaSite('https://www.youtube.com/watch?v=abc')).toBe('youtube.com')
  })

  it('does not match lookalike hosts', () => {
    // The whole point of matching on label boundaries: these are not our sites.
    expect(matchMediaSite('https://notx.com/a')).toBeNull()
    expect(matchMediaSite('https://x.com.example.net/a')).toBeNull()
    expect(matchMediaSite('https://example.com/a')).toBeNull()
  })

  it('ignores non-http schemes and junk', () => {
    expect(matchMediaSite('magnet:?xt=urn:btih:abc')).toBeNull()
    expect(matchMediaSite('ftp://x.com/a')).toBeNull()
    expect(matchMediaSite('not a url')).toBeNull()
  })
})

describe('isMediaSiteUrl', () => {
  it('accepts pages on media sites', () => {
    expect(isMediaSiteUrl('https://x.com/someone/status/123')).toBe(true)
    expect(isMediaSiteUrl('https://www.youtube.com/watch?v=abc')).toBe(true)
    expect(isMediaSiteUrl('https://vimeo.com/123456')).toBe(true)
  })

  it('keeps direct files on aria2 even on a media host', () => {
    // These are CDN payloads; aria2 fetches them better than yt-dlp does.
    expect(isMediaSiteUrl('https://x.com/media/clip.mp4')).toBe(false)
    expect(isMediaSiteUrl('https://video.twimg.com/ext/file.mp4')).toBe(false)
    expect(isMediaSiteUrl('https://example.com/archive.zip')).toBe(false)
  })
})

describe('chooseEngine', () => {
  const request = { uris: ['https://x.com/someone/status/123'], engine: 'auto' as const }

  it('sends a media page to yt-dlp', () => {
    expect(chooseEngine(request, AVAILABLE)).toBe('ytdlp')
  })

  it('sends an ordinary link to aria2', () => {
    expect(chooseEngine({ uris: ['https://example.com/file.zip'], engine: 'auto' }, AVAILABLE)).toBe('aria2')
  })

  it('honours an explicit engine over detection', () => {
    expect(chooseEngine({ ...request, engine: 'aria2' }, AVAILABLE)).toBe('aria2')
    expect(chooseEngine({ uris: ['https://example.com/a.bin'], engine: 'ytdlp' }, AVAILABLE)).toBe('ytdlp')
  })

  it('never sends a torrent or metalink body to yt-dlp', () => {
    expect(chooseEngine({ ...request, hasTorrent: true }, AVAILABLE)).toBe('aria2')
    expect(chooseEngine({ ...request, hasMetalink: true }, AVAILABLE)).toBe('aria2')
  })

  it('treats a pasted list as a batch of files, not a media page', () => {
    expect(
      chooseEngine({ uris: ['https://x.com/a/status/1', 'https://example.com/b.zip'], engine: 'auto' }, AVAILABLE)
    ).toBe('aria2')
  })

  it('falls back to aria2 when yt-dlp is disabled, undetected or missing', () => {
    expect(chooseEngine(request, { ...AVAILABLE, ytdlpEnabled: false })).toBe('aria2')
    expect(chooseEngine(request, { ...AVAILABLE, autoDetect: false })).toBe('aria2')
    expect(chooseEngine(request, { ...AVAILABLE, ytdlpAvailable: false })).toBe('aria2')
  })

  it('explains the fallback only when detection actually wanted yt-dlp', () => {
    const missing = { ...AVAILABLE, ytdlpAvailable: false }
    expect(shouldWarnAboutMissingYtDlp(request, missing)).toBe(true)
    expect(shouldWarnAboutMissingYtDlp({ uris: ['https://example.com/a.zip'], engine: 'auto' }, missing)).toBe(false)
    expect(shouldWarnAboutMissingYtDlp(request, AVAILABLE)).toBe(false)
  })
})

describe('extension host list', () => {
  it('stays in sync with the extension, which cannot import TypeScript', () => {
    // The extension is plain JS copied into place by the build script, so the
    // list has to be duplicated. This is what stops the two drifting.
    const file = fileURLToPath(new URL('../../resources/extension/src/media-sites.json', import.meta.url))
    const extensionSites: string[] = JSON.parse(readFileSync(file, 'utf8'))

    expect([...extensionSites].sort()).toEqual([...MEDIA_SITE_HOSTS].sort())
  })
})
