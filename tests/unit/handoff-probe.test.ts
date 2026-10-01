import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { HandoffServer } from '../../src/main/integrations/handoff-api'

/**
 * `/probe` is what lets the browser offer a quality menu.
 *
 * The app is the only thing that can answer it — ffmpeg may or may not be
 * installed, and resolving a page costs a yt-dlp run — so the extension asks
 * before it renders anything. That makes this route a second way to make the app
 * spend that run on the extension's say-so, which is why it is gated exactly like
 * `/add`: token, loopback, and an extension Origin.
 */

function makeServer(onProbe?: ReturnType<typeof vi.fn>): HandoffServer {
  return new HandoffServer({
    port: 0,
    token: 'test-token',
    version: '0.0.0-test',
    log: () => {},
    onPing: () => ({ version: '0.0.0-test', active: 0, waiting: 0 }),
    onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
    onProbe: onProbe as never
  })
}

function post(
  port: number,
  path: string,
  body: unknown,
  token = 'test-token'
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-ariadm-token': token,
          origin: 'chrome-extension://abcdefghijklmnop'
        }
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
        })
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('handoff /probe', () => {
  it('answers with the qualities for the page the browser is on', async () => {
    const onProbe = vi.fn(async () => ({
      title: 'a video',
      defaultFormatId: 'bestvideo+bestaudio/best',
      formats: [{ formatId: '137', label: '1080p · mp4' }]
    }))
    const server = makeServer(onProbe)
    await server.start()

    const response = await post(server.listeningPort, '/probe', {
      url: 'https://www.youtube.com/watch?v=abc',
      cookies: 'SID=1'
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, title: 'a video' })
    expect(response.body.formats).toHaveLength(1)
    // The session travels with the question: the qualities a signed-in visitor
    // can get are not always the ones a stranger can.
    expect(onProbe).toHaveBeenCalledWith({
      url: 'https://www.youtube.com/watch?v=abc',
      cookies: 'SID=1'
    })

    await server.stop()
  })

  it('refuses an answer without a URL', async () => {
    const onProbe = vi.fn()
    const server = makeServer(onProbe)
    await server.start()

    const response = await post(server.listeningPort, '/probe', {})

    expect(response.status).toBe(400)
    expect(onProbe).not.toHaveBeenCalled()

    await server.stop()
  })

  it('refuses a request without the token', async () => {
    const onProbe = vi.fn()
    const server = makeServer(onProbe)
    await server.start()

    const response = await post(server.listeningPort, '/probe', { url: 'https://x.com/a/status/1' }, 'wrong')

    expect(response.status).toBe(401)
    expect(onProbe).not.toHaveBeenCalled()

    await server.stop()
  })

  it('is simply absent when the app has no media engine to ask', async () => {
    const server = makeServer(undefined)
    await server.start()

    const response = await post(server.listeningPort, '/probe', { url: 'https://x.com/a/status/1' })

    expect(response.status).toBe(404)
    expect(response.body.ok).toBe(false)

    await server.stop()
  })
})
