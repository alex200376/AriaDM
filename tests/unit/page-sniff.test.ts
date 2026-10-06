import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MediaSniffer } from '../../src/main/media/page-sniff'

/**
 * The sniffer is the network half of detection, and the metadata parser now runs
 * behind it. The regression this pins: a page whose player exists only in
 * `og:video` has no marker for the cheap scan to find, so it used to come back
 * `not-media` and the link fell to aria2, which saved the HTML page.
 */

function fakeResponse(contentType: string, body: string, status = 200) {
  const bytes = new TextEncoder().encode(body)
  let sent = false
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: bytes }
        },
        cancel: async () => undefined
      })
    }
  }
}

function stubFetch(contentType: string, body: string) {
  const fetchMock = vi.fn(async () => fakeResponse(contentType, body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A fetch stub that answers per URL, so a page and the player it embeds can be
 * different documents. Returns the URLs that were requested, in order.
 */
function stubRoutes(routes: Record<string, { type: string; body: string; status?: number }>): string[] {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url)
      calls.push(target)
      const route = routes[target]
      if (!route) throw new Error(`no route for ${target}`)
      return fakeResponse(route.type, route.body, route.status ?? 200)
    })
  )
  return calls
}

/** Start a server on a loopback port and resolve its URL. */
function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve(`http://127.0.0.1:${address.port}/watch`)
    })
  })
}

describe('MediaSniffer', () => {
  it('recognises a page whose video is declared only in metadata', async () => {
    const html = [
      '<!doctype html><html><head>',
      '<meta property="og:type" content="video.other">',
      '<meta property="og:video" content="https://cdn.example/v.mp4">',
      '</head><body><p>Watch.</p></body></html>'
    ].join('')
    stubFetch('text/html; charset=utf-8', html)

    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/watch/1')).toBe('media')
  })

  it('still answers from the cheap markers without parsing', async () => {
    stubFetch('text/html', '<html><body><video src="x"></video></body></html>')
    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/watch/2')).toBe('media')
  })

  it('leaves an ordinary article as not-media', async () => {
    const html = '<!doctype html><html><head><meta property="og:title" content="x"></head><body><p>Text.</p></body></html>'
    stubFetch('text/html', html)
    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/article')).toBe('not-media')
  })

  it('never parses a non-document body', async () => {
    // A payload that merely contains the bytes `video` is not a page.
    stubFetch('application/octet-stream', 'video m3u8 <meta property="og:video" content="x">')
    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/blob')).toBe('not-media')
  })

  it('answers a media content type without reading the body', async () => {
    stubFetch('video/mp4', '')
    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/v.mp4')).toBe('media')
  })

  it('detects a real og:video page over a real HTTP request', async () => {
    // The whole path, unmocked: a socket, the fetch, the body read, and the
    // metadata parser. This is the shape the app actually runs.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><head><title>Clip</title>' +
          '<meta property="og:type" content="video.other">' +
          '<meta property="og:video" content="https://cdn.example/v.mp4">' +
          '</head><body>Watch.</body></html>'
      )
    })
    try {
      const url = await listen(server)
      const sniffer = new MediaSniffer({ log: () => undefined })
      expect(await sniffer.sniff(url)).toBe('media')
    } finally {
      server.close()
    }
  })

  it('reports a failed fetch as unknown, not as a negative', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    const sniffer = new MediaSniffer({ log: () => undefined })
    expect(await sniffer.sniff('https://example.test/x')).toBe('unknown')
  })

  it('follows a player frame and reports the manifest inside it', async () => {
    // The reported failure: the episode page holds nothing but an iframe, and
    // the manifest lives one level down. Stopping at the outer document is why
    // the link used to be reported as "no video here".
    const page = 'https://example.test/eps/1.html'
    const frame = 'https://example.test/_watch/2134000'
    const calls = stubRoutes({
      [page]: {
        type: 'text/html; charset=utf-8',
        body:
          '<!doctype html><html><head><title>生化危機：爆發夜</title></head><body>' +
          '<iframe name="p-frame" src="/_watch/2134000" allowfullscreen scrolling="no"></iframe>' +
          '</body></html>'
      },
      [frame]: {
        type: 'text/html',
        body: "<script>var url = 'https://cdn.example/2026/index.m3u8'; var type = 'hls';</script>"
      }
    })

    const scan = await new MediaSniffer({ log: () => undefined }).scan(page)

    expect(scan.verdict).toBe('media')
    expect(scan.streamUrls).toEqual(['https://cdn.example/2026/index.m3u8'])
    // A manifest has no title of its own, so the page's is the only honest name
    // for the file this becomes.
    expect(scan.title).toBe('生化危機：爆發夜')
    expect(calls).toContain(frame)
  })

  it('does not fetch a player when the page already names its own manifest', async () => {
    const page = 'https://example.test/watch/1'
    const calls = stubRoutes({
      [page]: {
        type: 'text/html',
        body:
          '<video controls></video>' +
          '<script>src = "/hls/index.m3u8"</script>' +
          '<iframe src="/_watch/1"></iframe>'
      }
    })

    const scan = await new MediaSniffer({ log: () => undefined }).scan(page)

    expect(scan.streamUrls).toEqual(['https://example.test/hls/index.m3u8'])
    // One request: an answer in hand is worth more than a second fetch.
    expect(calls).toEqual([page])
  })

  it('stays not-media when the player frame cannot be read', async () => {
    // A frame that fails contributes nothing rather than an answer: it must not
    // promote an ordinary page to media.
    const page = 'https://example.test/article/1'
    const calls = stubRoutes({
      [page]: {
        type: 'text/html',
        body: '<!doctype html><html><body><iframe src="/_watch/9"></iframe></body></html>'
      }
    })

    const scan = await new MediaSniffer({ log: () => undefined }).scan(page)

    expect(scan.verdict).toBe('not-media')
    expect(scan.streamUrls).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('caches a frame under its own URL, so a second page costs one request', async () => {
    // The same player is embedded by every episode of a series.
    const frame = 'https://example.test/_watch/2134000'
    const calls = stubRoutes({
      'https://example.test/eps/1.html': {
        type: 'text/html',
        body: '<iframe src="/_watch/2134000"></iframe>'
      },
      'https://example.test/eps/2.html': {
        type: 'text/html',
        body: '<iframe src="/_watch/2134000"></iframe>'
      },
      [frame]: {
        type: 'text/html',
        body: "<script>src = 'https://cdn.example/index.m3u8'</script>"
      }
    })
    const sniffer = new MediaSniffer({ log: () => undefined })

    await sniffer.scan('https://example.test/eps/1.html')
    const afterFirst = calls.length
    const second = await sniffer.scan('https://example.test/eps/2.html')

    expect(calls).toHaveLength(afterFirst + 1)
    expect(second.streamUrls).toEqual(['https://cdn.example/index.m3u8'])
  })

  it('reports a refused page as unknown and blocked, not as a page with no video', async () => {
    // Cloudflare and friends answer every non-browser request with 403 and a
    // challenge document. Reading that document says "no video here" about a site
    // full of video, and caching it says so for the next five minutes.
    const page = 'https://rule34.xxx/index.php?page=post&s=view&id=18961415'
    const calls = stubRoutes({
      [page]: {
        type: 'text/html; charset=UTF-8',
        body: '<html><head><title>CAPTCHA</title></head><body>Checking your browser.</body></html>',
        status: 403
      }
    })
    const sniffer = new MediaSniffer({ log: () => undefined })

    const first = await sniffer.scan(page)
    expect(first.verdict).toBe('unknown')
    expect(first.blocked).toBe(true)

    // Not cached: the site may answer for real a moment later, and a refusal
    // must not be remembered as "this link is a plain file".
    const second = await sniffer.scan(page)
    expect(second.verdict).toBe('unknown')
    expect(calls).toHaveLength(2)
  })

  it('does not call an ordinary page blocked', async () => {
    stubFetch('text/html', '<html><head><title>x</title></head><body><p>Text.</p></body></html>')

    const scan = await new MediaSniffer({ log: () => undefined }).scan('https://example.test/a')

    expect(scan.verdict).toBe('not-media')
    expect(scan.blocked).toBe(false)
  })

  it('answers a manifest content type without reading a body', async () => {
    // A URL that resolves straight to the play list needs no sniffing at all:
    // the server already said what it is.
    stubRoutes({
      'https://cdn.example/index.m3u8': { type: 'application/vnd.apple.mpegurl', body: '#EXTM3U' }
    })

    const scan = await new MediaSniffer({ log: () => undefined }).scan('https://cdn.example/index.m3u8')

    expect(scan.verdict).toBe('media')
    expect(scan.streamUrls).toEqual(['https://cdn.example/index.m3u8'])
  })
})
