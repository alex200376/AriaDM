import { describe, expect, it } from 'vitest'

import {
  findDirectMediaUrls,
  isDirectMediaUrl,
  isHtmlContentType,
  isMediaContentType,
  isScannableDocument,
  looksLikeMediaPage,
  normalizeContentType,
  PAGE_MEDIA_LIMIT,
  SNIFF_BYTE_LIMIT
} from '@shared/media-sniff'

/**
 * The sniff decides whether an unknown host reaches yt-dlp. Its value is that it
 * recognises a real player — the fragment below is shaped like the page this was
 * built for, where the video URL lives in a script rather than in a `<source>`.
 */

const MEDIA_PAGE = [
  '<!doctype html><html><head><title>883534</title></head><body>',
  '<div class="player"><video poster="https://cdn.example/thumb.webp" controls></video></div>',
  '<script>window.config = { src: "https://cdn.example/cv/x/index.m3u8?m=abc" }</script>',
  '</body></html>'
].join('')

const PLAIN_PAGE = '<!doctype html><html><head><title>Hello</title></head><body><p>Just text.</p></body></html>'

describe('normalizeContentType', () => {
  it('drops the parameters and lowercases', () => {
    expect(normalizeContentType('Text/HTML; charset=utf-8')).toBe('text/html')
    expect(normalizeContentType('')).toBe('')
  })
})

describe('isMediaContentType / isHtmlContentType', () => {
  it('classifies media types', () => {
    expect(isMediaContentType('video/mp4')).toBe(true)
    expect(isMediaContentType('application/vnd.apple.mpegurl')).toBe(true)
    expect(isMediaContentType('application/dash+xml')).toBe(true)
    expect(isMediaContentType('text/html; charset=utf-8')).toBe(false)
    expect(isMediaContentType('application/zip')).toBe(false)
  })

  it('classifies documents', () => {
    expect(isHtmlContentType('text/html')).toBe(true)
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true)
    expect(isHtmlContentType('application/json')).toBe(false)
  })
})

describe('looksLikeMediaPage', () => {
  it('recognises a player embedded in a script', () => {
    expect(looksLikeMediaPage('text/html; charset=utf-8', MEDIA_PAGE)).toBe(true)
  })

  it('recognises the other markers', () => {
    expect(looksLikeMediaPage('text/html', '<html><body><audio src="a.mp3"></audio></body></html>')).toBe(true)
    expect(looksLikeMediaPage('text/html', '<meta property="og:video" content="https://x/v.mp4">')).toBe(true)
    expect(looksLikeMediaPage('text/html', '<video><source type="video/mp4" src="x"></video>')).toBe(true)
    expect(looksLikeMediaPage('text/html', '<script>dash: "stream.mpd"</script>')).toBe(true)
  })

  it('leaves an ordinary page alone', () => {
    expect(looksLikeMediaPage('text/html', PLAIN_PAGE)).toBe(false)
  })

  it('never treats a non-document as a page', () => {
    // A binary payload that happens to contain the bytes "video" is not a player.
    expect(looksLikeMediaPage('application/octet-stream', 'video m3u8 .mpd <video>')).toBe(false)
    expect(looksLikeMediaPage('application/json', '{"video":".m3u8"}')).toBe(false)
  })

  it('accepts a document only when the server omitted the type and the body is HTML', () => {
    expect(looksLikeMediaPage('', MEDIA_PAGE)).toBe(true)
    expect(looksLikeMediaPage('', '{".m3u8":true}')).toBe(false)
  })

  it('accepts a media content type without reading the body', () => {
    expect(looksLikeMediaPage('video/mp4', '')).toBe(true)
    expect(looksLikeMediaPage('application/vnd.apple.mpegurl', '')).toBe(true)
  })

  it('shares one document test with the metadata parser', () => {
    // The parser in the main process scans exactly what this accepts, so the
    // two can never disagree about what counts as a page.
    expect(isScannableDocument('text/html', PLAIN_PAGE)).toBe(true)
    expect(isScannableDocument('', MEDIA_PAGE)).toBe(true)
    expect(isScannableDocument('', '{".m3u8":true}')).toBe(false)
    expect(isScannableDocument('application/json', MEDIA_PAGE)).toBe(false)
  })

  it('only scans a bounded prefix of a large page', () => {
    const filler = 'x'.repeat(SNIFF_BYTE_LIMIT + 5000)
    // The marker sits past the limit, so it must not be seen.
    expect(looksLikeMediaPage('text/html', `${filler}<video src="x"></video>`)).toBe(false)
    // ...but a marker within the limit still counts.
    expect(looksLikeMediaPage('text/html', `<video src="x"></video>${filler}`)).toBe(true)
  })
})

describe('isDirectMediaUrl', () => {
  it('accepts the containers a plain downloader can fetch', () => {
    expect(isDirectMediaUrl('https://cdn.example/clip.mp4')).toBe(true)
    expect(isDirectMediaUrl('https://cdn.example/clip.webm?t=1')).toBe(true)
    expect(isDirectMediaUrl('https://cdn.example/song.mp3')).toBe(true)
    expect(isDirectMediaUrl('https://cdn.example/CLIP.MP4')).toBe(true)
  })

  it('refuses a manifest, which is not the media itself', () => {
    // Handing an m3u8 to a plain downloader downloads a playlist, not a video.
    expect(isDirectMediaUrl('https://cdn.example/index.m3u8?m=abc')).toBe(false)
    expect(isDirectMediaUrl('https://cdn.example/stream.mpd')).toBe(false)
  })

  it('refuses what is not a fetchable media file at all', () => {
    expect(isDirectMediaUrl('https://cdn.example/page')).toBe(false)
    expect(isDirectMediaUrl('https://cdn.example/page.html')).toBe(false)
    expect(isDirectMediaUrl('blob:https://x/1')).toBe(false)
    expect(isDirectMediaUrl('data:video/mp4;base64,AAAA')).toBe(false)
    expect(isDirectMediaUrl('not a url')).toBe(false)
  })
})

describe('findDirectMediaUrls', () => {
  const BASE = 'https://page.example/watch/123'

  it('finds the file a video element points at', () => {
    const html =
      '<video controls src="https://cdn.example/clip.mp4"></video>'
    expect(findDirectMediaUrls(html, BASE)).toEqual(['https://cdn.example/clip.mp4'])
  })

  it('finds a source element and resolves a relative path', () => {
    const html = '<video><source src="/media/clip-a.mp4" type="video/mp4"></video>'
    expect(findDirectMediaUrls(html, BASE)).toEqual(['https://page.example/media/clip-a.mp4'])
  })

  it('finds a file the page only links to', () => {
    // The whole point: a page with no player in it still names a video file.
    const html = '<a href="downloads/movie.mkv">Download the movie</a>'
    expect(findDirectMediaUrls(html, BASE)).toEqual(['https://page.example/watch/downloads/movie.mkv'])
  })

  it('finds a URL buried in a script, JSON-escaped or not', () => {
    const html =
      '<script>var p={file:"https:\/\/cdn.example\/v\/a.webm",other:"https://cdn.example/b.mp3"}</script>'
    expect(findDirectMediaUrls(html, BASE)).toEqual([
      'https://cdn.example/v/a.webm',
      'https://cdn.example/b.mp3'
    ])
  })

  it('decodes an escaped ampersand in a query string', () => {
    const html = '<video src="https://cdn.example/clip.mp4?a=1&amp;b=2"></video>'
    expect(findDirectMediaUrls(html, BASE)).toEqual(['https://cdn.example/clip.mp4?a=1&b=2'])
  })

  it('keeps a manifest and an ordinary link out of the result', () => {
    const html = [
      '<script>hls:"https://cdn.example/index.m3u8"</script>',
      '<a href="https://page.example/about.html">about</a>',
      '<img src="https://cdn.example/pic.jpg">'
    ].join('')
    expect(findDirectMediaUrls(html, BASE)).toEqual([])
  })

  it('lists each file once, in the order it appears', () => {
    const html = [
      '<video src="https://cdn.example/a.mp4"></video>',
      '<script>"https://cdn.example/a.mp4"</script>',
      '<a href="https://cdn.example/b.mp4">b</a>'
    ].join('')
    expect(findDirectMediaUrls(html, BASE)).toEqual([
      'https://cdn.example/a.mp4',
      'https://cdn.example/b.mp4'
    ])
  })

  it('stops at the page limit', () => {
    const html = Array.from(
      { length: PAGE_MEDIA_LIMIT + 10 },
      (_, index) => `<a href="https://cdn.example/${index}.mp4">${index}</a>`
    ).join('')
    expect(findDirectMediaUrls(html, BASE)).toHaveLength(PAGE_MEDIA_LIMIT)
  })

  it('only scans a bounded prefix, like the marker check', () => {
    const filler = 'x'.repeat(SNIFF_BYTE_LIMIT + 10)
    expect(findDirectMediaUrls(`${filler}<a href="https://cdn.example/late.mp4">l</a>`, BASE)).toEqual([])
    expect(
      findDirectMediaUrls(`<a href="https://cdn.example/early.mp4">e</a>${filler}`, BASE)
    ).toEqual(['https://cdn.example/early.mp4'])
  })
})
