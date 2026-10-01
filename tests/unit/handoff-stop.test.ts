import { Agent, request } from 'node:http'
import { describe, expect, it } from 'vitest'

import { HandoffServer } from '../../src/main/integrations/handoff-api'

/**
 * The bug this pins down: `server.close()` waits for open connections to end,
 * and a browser extension's fetch keeps its socket alive long after the response
 * is written. Stopping the handoff API during a shutdown therefore blocked the
 * whole quit sequence — and because the update installer used to be launched at
 * the very end of that sequence, pressing install appeared to do nothing at all
 * for minutes on end.
 */
function makeServer(): HandoffServer {
  return new HandoffServer({
    port: 0,
    token: 'test-token',
    version: '0.0.0-test',
    log: () => {},
    onPing: () => ({ version: '0.0.0-test', active: 0, waiting: 0 }),
    onAdd: async () => ({ gids: [], duplicates: [], warnings: [] })
  })
}

describe('HandoffServer.stop', () => {
  it('resolves promptly while a keep-alive connection is still open', async () => {
    const server = makeServer()
    await server.start()
    const port = server.listeningPort
    expect(port).toBeGreaterThan(0)

    // One agent, kept alive: this is the extension's connection, not a one-shot
    // request that closes itself.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/discover', agent }, (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(body).app).toBe('AriaDM')

    // Race the stop against a short timer so a regression fails in seconds with a
    // clear message instead of sitting until the suite times out.
    const outcome = await Promise.race([
      server.stop().then(() => 'stopped' as const),
      new Promise<'slow'>((resolve) => {
        const timer = setTimeout(() => resolve('slow'), 3_000)
        timer.unref?.()
      })
    ])

    expect(outcome).toBe('stopped')
    agent.destroy()
  })

  it('is safe to call when the server never started', async () => {
    const server = makeServer()
    await expect(server.stop()).resolves.toBeUndefined()
  })
})
