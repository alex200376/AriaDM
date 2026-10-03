import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MediaSniffer } from '../../src/main/media/page-sniff'

/**
 * The sniffer is the network half of detection, and the metadata parser now runs
 * behind it. The regression this pins: a page whose player exists only in
 * `og:video` has no marker for the cheap scan to find, so it used to come back
 * `not-media` and the link fell to aria2, which saved the HTML page.
 */

function fakeResponse(contentType: string, body: string) {
  const bytes = new TextEncoder().encode(body)
  let sent = false
  return {
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
})
