import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Aria2Supervisor } from '../../src/main/aria2/supervisor'
import { resolvePaths } from '../../src/main/paths'
import { createDefaultSettings } from '../../src/main/settings/defaults'

import { startFixtureServer } from '../helpers/fixture-server'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const aria2Binary = path.join(projectRoot, 'resources', 'bin', 'aria2c.exe')
const suite = existsSync(aria2Binary) ? describe : describe.skip

suite('bitfield probe', () => {
  it('reports what tellStatus exposes for a split HTTP download', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-probe-'))
    const server = await startFixtureServer({ sizeBytes: 3 * 1024 * 1024 })
    const appPaths = resolvePaths(path.join(root, 'userData'), path.join(root, 'downloads'))
    const settings = { ...createDefaultSettings(appPaths), aria2RpcPort: 0 }

    const supervisor = new Aria2Supervisor({
      binaryPath: aria2Binary,
      settings,
      paths: { sessionFile: appPaths.session, logFile: appPaths.aria2Log, downloadDir: appPaths.downloads },
      onLog: () => {}
    })

    const dir = path.join(root, 'downloads')
    await fsp.mkdir(dir, { recursive: true })
    await supervisor.start()

    const gid = await supervisor.rpc.addUri([`${server.origin}/payload.bin`], {
      dir,
      out: 'payload.bin',
      split: '4',
      'max-connection-per-server': '4',
      'min-split-size': '1048576'
    })

    await new Promise((resolve) => setTimeout(resolve, 400))
    const during = await supervisor.rpc.tellStatus(gid, ['bitfield', 'numPieces', 'pieceLength', 'completedLength', 'connections', 'status'])
    console.log('HTTP DURING ' + JSON.stringify(during))
    const optionBitfield = await supervisor.rpc.getOption(gid).then((options) => options.bitfield ?? null)
    console.log('HTTP OPTION bitfield ' + JSON.stringify(optionBitfield))

    await new Promise((resolve) => setTimeout(resolve, 2500))
    const after = await supervisor.rpc.tellStatus(gid, ['bitfield', 'numPieces', 'pieceLength', 'completedLength', 'status'])
    console.log('HTTP AFTER ' + JSON.stringify(after))

    await supervisor.stop()
    await server.close()
    await fsp.rm(root, { recursive: true, force: true })
    expect(gid.length).toBeGreaterThan(0)
  })
})
