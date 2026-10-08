import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { Aria2Supervisor } from '../../src/main/aria2/supervisor'
import { clampBtMaxPeers, clampBtPort, clampBtStopTimeout } from '../../src/main/aria2/options'
import { resolvePaths } from '../../src/main/paths'
import { SettingsStore } from '../../src/main/settings/store'

/**
 * The BitTorrent options, checked against the real engine.
 *
 * `options.ts` clamps every one of these because aria2 validates its arguments at
 * startup and refuses to run at all when one is out of range (`errorCode=28`,
 * then a clean exit). A unit test can only prove we *passed* a string; only the
 * daemon can prove the string was acceptable, and only its own answer proves the
 * value it is actually running with. So each case here starts a real aria2c and
 * reads the options back with `getGlobalOption`.
 *
 * The aria2 build is fetched by `npm run fetch:aria2`, so this suite is skipped
 * where it has not been fetched — the same guard the other engine tests use.
 */
const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const aria2Binary = path.join(
  projectRoot,
  'resources',
  'bin',
  process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
)

const suite = existsSync(aria2Binary) ? describe : describe.skip

interface Engine {
  supervisor: Aria2Supervisor
  store: SettingsStore
  root: string
}

/** Start a daemon on a throwaway profile with `patch` merged over the defaults. */
async function startEngine(patch: Record<string, unknown>): Promise<Engine> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ariadm-bt-'))
  const appPaths = resolvePaths(path.join(root, 'userData'), path.join(root, 'downloads'))
  const store = new SettingsStore(appPaths)
  await store.load()
  // The RPC port is left to the OS so this never fights a developer's own copy.
  await store.patch({ ...patch, aria2RpcPort: 0 })

  const supervisor = new Aria2Supervisor({
    binaryPath: aria2Binary,
    settings: store.get(),
    paths: {
      sessionFile: appPaths.session,
      logFile: appPaths.aria2Log,
      downloadDir: appPaths.downloads
    },
    onLog: () => {}
  })
  await supervisor.start()

  const status = supervisor.getStatus()
  if (status.state !== 'ready') {
    throw new Error(`aria2 did not start (${status.state}): ${status.lastError}\n${status.logTail}`)
  }
  return { supervisor, store, root }
}

async function stopEngine(engine: Engine | null): Promise<void> {
  if (!engine) return
  await engine.supervisor.stop()
  await fsp.rm(engine.root, { recursive: true, force: true })
}

suite('BitTorrent options against the real engine', () => {
  it('starts with the whole option set and reads every value back', async () => {
    let engine: Engine | null = null
    try {
      engine = await startEngine({
        // One real announce URL and one line that is not one: the tracker list is
        // filtered, so the junk must be dropped rather than passed to aria2.
        btTrackers: ['udp://tracker.example.org:6969/announce', 'not a tracker url'],
        btRequireEncryption: true,
        btMinCryptoLevel: 'arc4',
        btListenPort: 51413,
        btDht: true,
        btDht6: true,
        btPex: false,
        btLpd: false,
        btMaxPeers: 40,
        btDetachSeedOnly: true,
        btStopTimeout: 120,
        btPeerIdPrefix: 'ZZ-test-',
        btPeerAgent: 'AriaDM-test/1'
      })

      const options = await engine.supervisor.rpc.getGlobalOption()

      expect(options['listen-port']).toBe('51413')
      expect(options['dht-listen-port']).toBe('51413')
      expect(options['bt-max-peers']).toBe('40')
      expect(options['bt-require-crypto']).toBe('true')
      expect(options['bt-min-crypto-level']).toBe('arc4')
      expect(options['enable-dht']).toBe('true')
      expect(options['enable-dht6']).toBe('true')
      expect(options['enable-peer-exchange']).toBe('false')
      expect(options['bt-enable-lpd']).toBe('false')
      expect(options['bt-detach-seed-only']).toBe('true')
      expect(options['bt-stop-timeout']).toBe('120')
      expect(options['peer-agent']).toBe('AriaDM-test/1')

      // A peer id is a fixed-width field aria2 pads, so only the prefix is ours.
      expect(options['peer-id-prefix']).toContain('ZZ-test-')

      expect(options['bt-tracker']).toContain('udp://tracker.example.org:6969/announce')
      expect(options['bt-tracker']).not.toContain('not a tracker url')
    } finally {
      await stopEngine(engine)
    }
  })

  it('clamps out-of-range values instead of letting the engine refuse to start', async () => {
    let engine: Engine | null = null
    try {
      engine = await startEngine({
        btListenPort: 99_999,
        btMaxPeers: 99_999,
        btStopTimeout: 99_999_999
      })

      // The point of the test: the daemon is running at all. An unclamped
      // argument is what makes aria2 exit with errorCode=28 instead.
      const options = await engine.supervisor.rpc.getGlobalOption()

      expect(clampBtPort(99_999)).toBe(65_535)
      expect(options['listen-port']).toBe('65535')

      expect(clampBtMaxPeers(99_999)).toBe(2_000)
      expect(options['bt-max-peers']).toBe('2000')

      expect(clampBtStopTimeout(99_999_999)).toBe(86_400)
      expect(options['bt-stop-timeout']).toBe('86400')
    } finally {
      await stopEngine(engine)
    }
  })

  it('applies the live options to a running daemon and leaves the restart-only ones alone', async () => {
    let engine: Engine | null = null
    try {
      // A port of its own rather than the first case's: these engines are torn
      // down and rebuilt a few seconds apart, and rebinding the same fixed port
      // that quickly is exactly the kind of flake that has nothing to do with the
      // behaviour under test.
      engine = await startEngine({
        btListenPort: 51415,
        btMaxPeers: 40,
        btDht: true,
        btPex: true,
        btDetachSeedOnly: false
      })

      const next = {
        ...engine.store.get(),
        // Applies to a running daemon.
        btMaxPeers: 77,
        btPex: false,
        btTrackers: ['udp://tracker.changed.example:1337/announce'],
        // Restart-only. Each of these is accepted by changeGlobalOption without
        // an error and then silently ignored, which is exactly why they must not
        // be in the live set: the assertions below would pass either way, and
        // only the ones that really moved prove the split is right.
        btListenPort: 60000,
        btDht: false,
        btDetachSeedOnly: true
      }
      await engine.supervisor.applyLiveSettings(next)

      const after = await engine.supervisor.rpc.getGlobalOption()

      expect(after['bt-max-peers']).toBe('77')
      expect(after['enable-peer-exchange']).toBe('false')
      expect(after['bt-tracker']).toBe('udp://tracker.changed.example:1337/announce')

      // Unchanged, because aria2 binds the port at startup.
      expect(after['listen-port']).toBe('51415')
      // Unchanged, because aria2 ignores these at runtime.
      expect(after['enable-dht']).toBe('true')
      expect(after['bt-detach-seed-only']).toBe('false')
    } finally {
      await stopEngine(engine)
    }
  })
})
