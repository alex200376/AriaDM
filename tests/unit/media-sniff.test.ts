import { describe, expect, it } from 'vitest'

import {
  isHtmlContentType,
  isMediaContentType,
  looksLikeMediaPage,
  normalizeContentType,
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

  it('only scans a bounded prefix of a large page', () => {
    const filler = 'x'.repeat(SNIFF_BYTE_LIMIT + 5000)
    // The marker sits past the limit, so it must not be seen.
    expect(looksLikeMediaPage('text/html', `${filler}<video src="x"></video>`)).toBe(false)
    // ...but a marker within the limit still counts.
    expect(looksLikeMediaPage('text/html', `<video src="x"></video>${filler}`)).toBe(true)
  })
})
