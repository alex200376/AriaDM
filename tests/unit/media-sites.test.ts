import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  MEDIA_SITE_HOSTS,
  chooseEngine,
  isMediaSiteUrl,
  matchMediaSite,
  needsPageSniff,
  shouldWarnAboutMissingYtDlp,
  splitByMediaSite
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

  it('treats a video page with a .html suffix as media', () => {
    // A page extension is not a file: this used to be rejected by
    // hasFileExtension and sent to aria2, which saved the HTML.
    expect(isMediaSiteUrl('https://www.youtube.com/watch/abc.html')).toBe(true)
  })
})

describe('needsPageSniff', () => {
  it('asks about a single unknown-host page link', () => {
    expect(needsPageSniff('https://www.acgmho.com/gif/883534.html')).toBe(true)
    expect(needsPageSniff('https://example.test/watch/123')).toBe(true)
  })

  it('skips a host the curated list already knows', () => {
    expect(needsPageSniff('https://www.youtube.com/watch?v=abc')).toBe(false)
  })

  it('skips a URL that names a file', () => {
    expect(needsPageSniff('https://example.com/archive.zip')).toBe(false)
  })

  it('skips anything that is not an http(s) URL', () => {
    expect(needsPageSniff('magnet:?xt=urn:btih:abc')).toBe(false)
    expect(needsPageSniff('ftp://example.com/a')).toBe(false)
    expect(needsPageSniff('not a url')).toBe(false)
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

  it('still honours an explicit video request with auto-detection switched off', () => {
    // The regression this pins: 自動辨識 off used to downgrade this to aria2, so
    // the extension's "download this video" saved the YouTube page instead.
    const off = { ...AVAILABLE, autoDetect: false }
    expect(chooseEngine({ uris: ['https://www.youtube.com/watch?v=1'], engine: 'ytdlp' }, off)).toBe('ytdlp')
    // Automatic detection really is off — that is all the switch means.
    expect(chooseEngine({ uris: ['https://www.youtube.com/watch?v=1'], engine: 'auto' }, off)).toBe('aria2')
  })

  it('lets yt-dlp being switched off win over an explicit request', () => {
    expect(
      chooseEngine(
        { uris: ['https://www.youtube.com/watch?v=1'], engine: 'ytdlp' },
        { ...AVAILABLE, ytdlpEnabled: false }
      )
    ).toBe('aria2')
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

  it('routes a sniffed unknown-host video to yt-dlp', () => {
    const sniffed = { uris: ['https://www.acgmho.com/gif/883534.html'], engine: 'auto' as const, detectedMedia: true }
    expect(chooseEngine(sniffed, AVAILABLE)).toBe('ytdlp')
  })

  it('leaves an unsniffed unknown-host link on aria2', () => {
    const unknown = { uris: ['https://www.acgmho.com/gif/883534.html'], engine: 'auto' as const }
    expect(chooseEngine(unknown, AVAILABLE)).toBe('aria2')
    // A negative sniff is the same answer as no sniff at all.
    expect(chooseEngine({ ...unknown, detectedMedia: false }, AVAILABLE)).toBe('aria2')
  })

  it('does not use a sniff result for a batch or an explicit engine', () => {
    const batch = { uris: ['https://a.example/x', 'https://b.example/y'], engine: 'auto' as const, detectedMedia: true }
    expect(chooseEngine(batch, AVAILABLE)).toBe('aria2')
    const explicit = { uris: ['https://www.acgmho.com/gif/883534.html'], engine: 'aria2' as const, detectedMedia: true }
    expect(chooseEngine(explicit, AVAILABLE)).toBe('aria2')
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

    // A sniffed unknown-host video deserves the same explanation as a curated one.
    expect(
      shouldWarnAboutMissingYtDlp(
        { uris: ['https://www.acgmho.com/gif/883534.html'], engine: 'auto', detectedMedia: true },
        missing
      )
    ).toBe(true)

    // An explicit request that cannot be honoured is explained even with
    // auto-detection off, because nothing about it was automatic.
    expect(
      shouldWarnAboutMissingYtDlp(
        { uris: ['https://www.youtube.com/watch?v=1'], engine: 'ytdlp' },
        { ...missing, autoDetect: false }
      )
    ).toBe(true)
  })
})

describe('splitByMediaSite', () => {
  it('separates video pages from ordinary links, preserving order', () => {
    // A pasted batch is just as likely to be a list of videos as a list of
    // files, and the two need different engines.
    const split = splitByMediaSite([
      'https://www.youtube.com/watch?v=one',
      'https://example.test/file.zip',
      'https://www.instagram.com/reel/two/',
      'magnet:?xt=urn:btih:abc'
    ])

    expect(split.media).toEqual([
      'https://www.youtube.com/watch?v=one',
      'https://www.instagram.com/reel/two/'
    ])
    expect(split.plain).toEqual(['https://example.test/file.zip', 'magnet:?xt=urn:btih:abc'])
  })

  it('treats a file served from a media host as an ordinary link', () => {
    // Same rule as isMediaSiteUrl: a named file goes to aria2 either way.
    const split = splitByMediaSite(['https://www.youtube.com/media/clip.mp4'])
    expect(split.media).toEqual([])
    expect(split.plain).toEqual(['https://www.youtube.com/media/clip.mp4'])
  })

  it('returns an empty split for an empty paste', () => {
    expect(splitByMediaSite([])).toEqual({ media: [], plain: [] })
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
