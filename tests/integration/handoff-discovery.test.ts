import { readFileSync } from 'node:fs'
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HANDOFF_DISCOVERY_PORTS } from '@shared/ipc'

import { HandoffServer, type HandoffAddResult, type HandoffPayload } from '../../src/main/integrations/handoff-api'

/**
 * Pairing is the one part of the handoff API that is deliberately reachable
 * without a token, so it is also the part most worth pinning down: these tests
 * exist to prove the discovery endpoint cannot be driven by a web page and that
 * the rendezvous listener really is discovery-only.
 *
 * No aria2 binary is needed, so this suite always runs.
 */

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  json: Record<string, unknown>
}

function get(port: number, pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            json = { raw: text }
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, json })
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

function options(port: number, pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'OPTIONS', headers },
      (response) => {
        response.resume()
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, json: {} }))
      }
    )
    request.on('error', reject)
    request.end()
  })
}

function post(port: number, pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {}
          })
        })
      }
    )
    request.on('error', reject)
    request.end(payload)
  })
}

describe('handoff pairing and discovery', () => {
  const logs: string[] = []
  const added: HandoffPayload[] = []
  let real: HandoffServer
  let rendezvous: HandoffServer
  let realPort = 0
  let rendezvousPort = 0

  beforeAll(async () => {
    real = new HandoffServer({
      // 0 lets the OS pick, so the suite never collides with a running app.
      port: 0,
      token: 'token-under-test',
      version: '9.9.9-test',
      onAdd: async (payload): Promise<HandoffAddResult> => {
        added.push(payload)
        return { gids: ['gid-1'], duplicates: [], warnings: [] }
      },
      onPing: () => ({ version: '9.9.9-test', active: 1, waiting: 2 }),
      log: (line) => logs.push(line)
    })
    await real.start()
    realPort = real.listeningPort

    // The rendezvous listener is what an extension finds on the fixed port. It
    // exists only to answer /discover, and advertises the real server's port.
    rendezvous = new HandoffServer({
      port: 0,
      token: 'rendezvous-token',
      announce: { port: realPort, token: real.token },
      discoveryOnly: true,
      version: '9.9.9-test',
      onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
      onPing: () => ({ version: '', active: 0, waiting: 0 }),
      log: (line) => logs.push(line)
    })
    await rendezvous.start()
    rendezvousPort = rendezvous.listeningPort
  })

  afterAll(async () => {
    await real?.stop()
    await rendezvous?.stop()
  })

  it('advertises the real port and token without any credentials', async () => {
    const reply = await get(rendezvousPort, '/discover')
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({
      ok: true,
      app: 'AriaDM',
      version: '9.9.9-test',
      port: realPort,
      token: 'token-under-test'
    })
  })

  it('answers discovery from an extension origin and echoes CORS headers', async () => {
    const reply = await get(rendezvousPort, '/discover', { origin: 'chrome-extension://abcdefghijklmnop' })
    expect(reply.status).toBe(200)
    expect(reply.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnop')
  })

  it('opts into Private Network Access so Chrome does not block the loopback fetch', async () => {
    // Without this header Chrome's PNA preflight fails first, and the extension
    // reports "never detected" no matter what the app is doing.
    const discovery = await get(rendezvousPort, '/discover', { origin: 'chrome-extension://abcdefghijklmnop' })
    expect(discovery.headers['access-control-allow-private-network']).toBe('true')

    const preflight = await options(realPort, '/add', {
      origin: 'chrome-extension://abcdefghijklmnop',
      'access-control-request-method': 'POST',
      'access-control-request-private-network': 'true'
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-private-network']).toBe('true')
  })

  it('refuses discovery to a web-page origin', async () => {
    const reply = await get(rendezvousPort, '/discover', { origin: 'https://evil.example' })
    expect(reply.status).toBe(403)
    expect(reply.json.error).toBe('origin not allowed')
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('serves nothing but discovery on the rendezvous listener', async () => {
    const ping = await get(rendezvousPort, '/ping', { 'x-ariadm-token': real.token })
    expect(ping.status).toBe(404)

    // Even with the genuine token, the fixed port will not accept a download:
    // only the announce port can, which keeps the sensitive surface on one port.
    const add = await post(rendezvousPort, '/add', { urls: ['https://example.com/a.bin'] }, {
      'x-ariadm-token': real.token
    })
    expect(add.status).toBe(404)
    expect(added).toHaveLength(0)
  })

  it('still reports its own port on a server that is not a rendezvous', async () => {
    const reply = await get(realPort, '/discover')
    expect(reply.status).toBe(200)
    expect(reply.json.port).toBe(realPort)
    expect(reply.json.token).toBe('token-under-test')
  })

  it('rejects a mismatched token before reading the payload', async () => {
    const reply = await post(realPort, '/add', { urls: ['https://example.com/a.bin'] }, {
      'x-ariadm-token': 'wrong'
    })
    expect(reply.status).toBe(401)
    expect(added).toHaveLength(0)
  })

  it('rejects an unknown engine rather than guessing', async () => {
    const reply = await post(realPort, '/add', { urls: ['https://example.com/a.bin'], engine: 'wget' }, {
      'x-ariadm-token': 'token-under-test'
    })
    expect(reply.status).toBe(400)
    expect(reply.json.error).toBe('invalid engine')
    expect(added).toHaveLength(0)
  })

  it('passes the extension media flag and engine through to the add handler', async () => {
    const first = await post(
      realPort,
      '/add',
      { urls: ['https://x.com/user/status/1'], referer: 'https://x.com/', media: true },
      { 'x-ariadm-token': 'token-under-test' }
    )
    expect(first.status).toBe(200)
    expect(added[0]).toMatchObject({ media: true, referer: 'https://x.com/' })
    expect(added[0]!.engine).toBeUndefined()

    const second = await post(
      realPort,
      '/add',
      { urls: ['https://example.com/a.bin'], engine: 'aria2' },
      { 'x-ariadm-token': 'token-under-test' }
    )
    expect(second.status).toBe(200)
    expect(added[1]!.engine).toBe('aria2')
  })

  it('walks past a discovery port owned by another program', async () => {
    // The regression this pins: the rendezvous listener used one hard-coded port
    // (7070, which AnyDesk claims by default). When it was taken the listener
    // silently failed to start and the extension retried a stranger's socket
    // forever, which looked exactly like "auto setup never detects the app".
    const squatter = http.createServer((_request, response) => response.end())
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    const address = squatter.address()
    const takenPort = typeof address === 'object' && address ? address.port : 0

    const make = (port: number): HandoffServer =>
      new HandoffServer({
        port,
        token: 'token-under-test',
        discoveryOnly: true,
        announce: { port: realPort, token: 'token-under-test' },
        version: '9.9.9-test',
        onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
        onPing: () => ({ version: '', active: 0, waiting: 0 }),
        log: (line) => logs.push(line)
      })

    try {
      // Port 0 as the last resort stands in for "whatever is free": the point is
      // that the taken port is skipped rather than reported as fatal.
      const bound = await HandoffServer.startFirstAvailable([takenPort, 0], make)
      expect(bound).not.toBeNull()
      expect(bound!.port).not.toBe(takenPort)
      await bound!.server.stop()
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })

  it('reports that every discovery port is unavailable instead of throwing', async () => {
    const squatter = http.createServer((_request, response) => response.end())
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    const address = squatter.address()
    const takenPort = typeof address === 'object' && address ? address.port : 0

    try {
      const bound = await HandoffServer.startFirstAvailable([takenPort], (port) =>
        new HandoffServer({
          port,
          token: 'token-under-test',
          discoveryOnly: true,
          onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
          onPing: () => ({ version: '', active: 0, waiting: 0 }),
          log: (line) => logs.push(line)
        })
      )
      expect(bound).toBeNull()
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })

  it('exposes a bind failure, which is what the handoff retry reacts to', async () => {
    // The port being taken is the exact condition after an update, while the
    // previous process is still shutting down. The endpoint must surface it
    // (so a retry can be scheduled and the UI can explain it) rather than
    // failing silently, and it must leave no listener behind.
    const squatter = http.createServer((_request, response) => response.end())
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    const address = squatter.address()
    const takenPort = typeof address === 'object' && address ? address.port : 0

    try {
      const server = new HandoffServer({
        port: takenPort,
        token: 'token-under-test',
        version: '9.9.9-test',
        onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
        onPing: () => ({ version: '', active: 0, waiting: 0 }),
        log: (line) => logs.push(line)
      })

      await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(server.error).not.toBe('')
      expect(server.listeningPort).toBe(0)
      // A half-failed bind must be cleanly stoppable, which is what the retry
      // path does before scheduling the next attempt.
      await server.stop()
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })

  it('advertises a portable candidate list the extension can probe', () => {
    expect(HANDOFF_DISCOVERY_PORTS.length).toBeGreaterThan(1)
    expect(new Set(HANDOFF_DISCOVERY_PORTS).size).toBe(HANDOFF_DISCOVERY_PORTS.length)
    expect(HANDOFF_DISCOVERY_PORTS[0]).toBe(7070)

    // The extension hard-codes its own copy of this list, so drift between the
    // two would silently break pairing again.
    const pairingSource = readFileSync(
      new URL('../../resources/extension/src/pairing.js', import.meta.url),
      'utf8'
    )
    const declared = /const DISCOVERY_PORTS = \[([^\]]+)\]/.exec(pairingSource)?.[1]
    const ports = (declared ?? '').split(',').map((entry) => Number(entry.trim()))
    expect(ports).toEqual([...HANDOFF_DISCOVERY_PORTS])
  })

  it('binds the real candidate list, skipping whatever this machine already uses', async () => {
    const bound = await HandoffServer.startFirstAvailable(HANDOFF_DISCOVERY_PORTS, (port) =>
      new HandoffServer({
        port,
        token: 'token-under-test',
        discoveryOnly: true,
        announce: { port: realPort, token: 'token-under-test' },
        version: '9.9.9-test',
        onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
        onPing: () => ({ version: '', active: 0, waiting: 0 }),
        log: (line) => logs.push(line)
      })
    )

    // Every candidate being taken is a legitimate machine state, not a failure.
    if (bound) {
      expect(HANDOFF_DISCOVERY_PORTS).toContain(bound.port as (typeof HANDOFF_DISCOVERY_PORTS)[number])
      // And it really answers discovery, which is the only thing that matters.
      const reply = await get(bound.port, '/discover')
      expect(reply.status).toBe(200)
      expect(reply.json).toMatchObject({ app: 'AriaDM', port: realPort })
      await bound.server.stop()
    }
  })

  it('answers a CORS preflight from an extension without a token', async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: realPort,
          path: '/add',
          method: 'OPTIONS',
          headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'POST' }
        },
        (response) => {
          response.resume()
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, headers: response.headers, json: {} })
          )
        }
      )
      request.on('error', reject)
      request.end()
    })

    expect(reply.status).toBe(204)
    expect(reply.headers['access-control-allow-headers']).toContain('x-ariadm-token')
  })
})
