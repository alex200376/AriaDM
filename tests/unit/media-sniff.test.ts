import { describe, expect, it } from 'vitest'

import {
  findDirectMediaUrls,
  findPageTitle,
  findPlayerFrames,
  findStreamUrls,
  isDirectMediaUrl,
  isHtmlContentType,
  isMediaContentType,
  isScannableDocument,
  isStreamManifestUrl,
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

describe('isStreamManifestUrl', () => {
  it('recognises a play list, and nothing else', () => {
    expect(isStreamManifestUrl('https://cdn.example/index.m3u8?m=abc')).toBe(true)
    expect(isStreamManifestUrl('https://cdn.example/stream.mpd')).toBe(true)
    expect(isStreamManifestUrl('https://cdn.example/CLIP.M3U8')).toBe(true)
    expect(isStreamManifestUrl('https://cdn.example/clip.mp4')).toBe(false)
    expect(isStreamManifestUrl('blob:https://x/1')).toBe(false)
    expect(isStreamManifestUrl('not a url')).toBe(false)
  })
})

describe('findStreamUrls', () => {
  const BASE = 'https://gimytv.io/eps/202670754-hdtc-zhong-zi-v2.html'

  it('finds the manifest a player hides in its own script', () => {
    // The page this was built for: no `<video>` and no `<source>`, just a setup
    // call whose address never appears in the markup.
    const html =
      "<script>var url = 'https://vip.ffzy-play10.com/2026/index.m3u8'; var type = 'hls';</script>"

    expect(findStreamUrls(html, BASE)).toEqual(['https://vip.ffzy-play10.com/2026/index.m3u8'])
  })

  it('undoes the JSON-escaped slashes a scripted player writes', () => {
    const html = '<script>player.setup({src:"https:\\/\\/cdn.example\\/hls\\/index.m3u8"})</script>'

    expect(findStreamUrls(html, BASE)).toEqual(['https://cdn.example/hls/index.m3u8'])
  })

  it('resolves a relative manifest against the page it was found on', () => {
    const html = '<video><source src="/hls/index.m3u8" type="application/x-mpegurl"></video>'

    expect(findStreamUrls(html, BASE)).toEqual(['https://gimytv.io/hls/index.m3u8'])
  })

  it('keeps media files and pages out of it', () => {
    expect(findStreamUrls('<video src="https://cdn.example/a.mp4"></video>', BASE)).toEqual([])
    expect(findStreamUrls('<a href="/about.html">about</a>', BASE)).toEqual([])
  })
})

describe('findPlayerFrames', () => {
  const BASE = 'https://gimytv.io/eps/202670754-hdtc-zhong-zi-v2.html'

  it('ranks the frame that looks like a player above the rest', () => {
    // Advert and tracker frames come and go, and the video is rarely first.
    const html = [
      '<iframe src="https://ads.example/banner"></iframe>',
      '<iframe src="https://other.example/x"></iframe>',
      '<iframe name="p-frame" src="/_watch/2134000" allowfullscreen scrolling="no"></iframe>'
    ].join('')

    expect(findPlayerFrames(html, BASE)[0]).toBe('https://gimytv.io/_watch/2134000')
  })

  it('prefers a frame that stays on the site, and lists each one once', () => {
    const html = [
      '<iframe src="https://third.example/x"></iframe>',
      '<iframe src="/local/y"></iframe>',
      '<iframe src="/local/y"></iframe>'
    ].join('')

    expect(findPlayerFrames(html, BASE)).toEqual(['https://gimytv.io/local/y', 'https://third.example/x'])
  })

  it('drops a frame that names a file, and reads embed and object too', () => {
    // A payload wearing a document's clothes is not worth a request.
    expect(findPlayerFrames('<iframe src="/assets/ad.png"></iframe>', BASE)).toEqual([])
    expect(findPlayerFrames('<iframe src="/media/clip.mp4"></iframe>', BASE)).toEqual([])
    expect(findPlayerFrames('<embed src="/player/1">', BASE)).toEqual(['https://gimytv.io/player/1'])
    expect(findPlayerFrames('<object data="/player/2"></object>', BASE)).toEqual([
      'https://gimytv.io/player/2'
    ])
  })
})

describe('findPageTitle', () => {
  it('prefers the open-graph title over the document title', () => {
    const html =
      '<head><meta property="og:title" content="生化危機：爆發夜"><title>Gimy TV 劇迷</title></head>'

    expect(findPageTitle(html)).toBe('生化危機：爆發夜')
  })

  it('falls back to the title element and undoes entities', () => {
    expect(findPageTitle('<title>A &amp; B &#039;C&#039;</title>')).toBe("A & B 'C'")
    expect(findPageTitle('<title>one\ntwo</title>')).toBe('one two')
  })

  it('returns nothing when the page has no title', () => {
    expect(findPageTitle('<body><p>x</p></body>')).toBe('')
  })
})
