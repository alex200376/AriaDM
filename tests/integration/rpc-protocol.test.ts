import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Aria2RpcClient } from '../../src/main/aria2/rpc-client'
import { POLL_KEYS } from '../../src/main/aria2/types'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const aria2Binary = path.join(projectRoot, 'resources', 'bin', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c')

const suite = existsSync(aria2Binary) ? describe : describe.skip

const SECRET = 'protocol-test-secret'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

/**
 * These are the parameter shapes aria2 1.37.0 actually accepts, and each one
 * asserted here was a real defect found by the engine test suite:
 *
 *  - an omitted optional argument must leave the parameter list entirely, because
 *    `JSON.stringify` turns `undefined` into `null` and aria2 answers
 *    "The parameter at 0 has wrong type";
 *  - `system.multicall` takes the sub-call array as its only parameter and
 *    carries the secret inside each sub-call, so a top-level token is rejected.
 *
 * Both failed the same way on the wire — HTTP 400 — which is why they are pinned
 * here at the protocol level rather than only through the download manager.
 */
suite('aria2 RPC protocol contract', () => {
  let child: ChildProcess | null = null
  let root = ''
  let client: Aria2RpcClient

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-protocol-'))
    const port = await freePort()

    child = spawn(
      aria2Binary,
      [
        '--no-conf=true',
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        `--rpc-listen-port=${port}`,
        `--rpc-secret=${SECRET}`,
        `--dir=${root}`,
        '--summary-interval=0',
        '--console-log-level=error'
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )

    client = new Aria2RpcClient({ port, secret: SECRET, timeoutMs: 5000 })

    const deadline = Date.now() + 20_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      try {
        await client.getVersion()
        ready = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    expect(ready).toBe(true)
  })

  afterAll(async () => {
    client?.close()
    child?.kill()
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('authenticates and reports the engine version', async () => {
    const version = await client.getVersion()
    expect(version.version).toContain('1.37')
  })

  it('accepts a tell* call with its optional key list omitted', async () => {
    await expect(client.tellActive()).resolves.toEqual([])
    await expect(client.tellWaiting(0, 10)).resolves.toEqual([])
    await expect(client.tellStopped(0, 10)).resolves.toEqual([])
  })

  it('accepts a tell* call with an explicit key list', async () => {
    const rows = await client.tellActive(POLL_KEYS)
    expect(Array.isArray(rows)).toBe(true)
  })

  it('batches several tell* calls plus a global stat in one multicall', async () => {
    const results = await client.multicall<unknown>([
      { method: 'aria2.tellActive', params: [POLL_KEYS] },
      { method: 'aria2.tellWaiting', params: [0, 1000, POLL_KEYS] },
      { method: 'aria2.tellStopped', params: [0, 1000, POLL_KEYS] },
      { method: 'aria2.getGlobalStat' }
    ])

    expect(results).toHaveLength(4)
    expect(results[0]).toEqual([])
    expect(results[1]).toEqual([])
    expect(results[2]).toEqual([])
    expect(results[3]).toMatchObject({ numActive: '0', numWaiting: '0' })
  })

  it('maps a faulted sub-call to null rather than discarding the whole batch', async () => {
    const results = await client.multicall<unknown>([
      { method: 'aria2.doesNotExist' },
      { method: 'aria2.getGlobalStat' }
    ])

    expect(results).toHaveLength(2)
    expect(results[0]).toBeNull()
    expect(results[1]).toMatchObject({ numActive: '0' })
  })
})
