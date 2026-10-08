import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  btGlobalOptions,
  buildDaemonArgs,
  buildItemOptions,
  globalLimitOptions,
  type DaemonPaths
} from '../../src/main/aria2/options'
import { resolvePaths } from '../../src/main/paths'
import { createDefaultSettings } from '../../src/main/settings/defaults'

import { makeInput } from '../helpers/records'

function fixture(): { settings: ReturnType<typeof createDefaultSettings>; paths: DaemonPaths } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadm-opts-'))
  const appPaths = resolvePaths(path.join(root, 'userData'), path.join(root, 'downloads'))
  return {
    settings: createDefaultSettings(appPaths),
    paths: {
      sessionFile: appPaths.session,
      logFile: appPaths.aria2Log,
      downloadDir: appPaths.downloads
    }
  }
}

describe('buildDaemonArgs', () => {
  it('keeps the RPC control plane private to loopback and secret-protected', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 6800, secret: 's3cret', disableIpv6: false })

    expect(args).toContain('--rpc-listen-all=false')
    expect(args).toContain('--rpc-allow-origin-all=false')
    expect(args).toContain('--enable-rpc=true')
    expect(args).toContain('--rpc-listen-port=6800')
    expect(args).toContain('--rpc-secret=s3cret')
  })

  it('ignores any aria2.conf the machine happens to have', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x', disableIpv6: false })
    expect(args).toContain('--no-conf=true')
  })

  it('always points at the configured log file and download folder', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x', disableIpv6: false })
    expect(args).toContain(`--log=${paths.logFile}`)
    expect(args).toContain(`--dir=${paths.downloadDir}`)
    expect(args).toContain('--continue=true')
  })

  it('never persists or replays a session, so the queue starts empty every launch', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x', disableIpv6: false })

    expect(args.some((arg) => arg.startsWith('--input-file='))).toBe(false)
    expect(args.some((arg) => arg.startsWith('--save-session'))).toBe(false)
  })

  it('passes throughput limits through as bare byte counts', () => {
    const base = fixture()
    const settings = { ...base.settings, globalDownloadLimit: 1024 * 1024, globalUploadLimit: 512 * 1024 }
    const args = buildDaemonArgs({
      settings,
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })

    expect(args).toContain('--max-overall-download-limit=1048576')
    expect(args).toContain('--max-overall-upload-limit=524288')
    expect(args).toContain('--max-concurrent-downloads=5')
  })

  it('encodes the seeding rules so that "no seeding" means no seeding', () => {
    const base = fixture()
    const none = buildDaemonArgs({
      settings: { ...base.settings, seedRatio: 0, seedTime: 0 },
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })
    expect(none).toContain('--seed-time=0')
    expect(none.some((arg) => arg.startsWith('--seed-ratio='))).toBe(false)

    const seeded = buildDaemonArgs({
      settings: { ...base.settings, seedRatio: 2, seedTime: 0 },
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })
    expect(seeded).toContain('--seed-ratio=2')
    expect(seeded).not.toContain('--seed-time=0')
  })

  it('only adds a proxy when one is configured', () => {
    const base = fixture()
    const plain = buildDaemonArgs({
      settings: base.settings,
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })
    expect(plain.some((arg) => arg.startsWith('--all-proxy='))).toBe(false)

    const proxied = buildDaemonArgs({
      settings: { ...base.settings, proxy: 'http://127.0.0.1:8080' },
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })
    expect(proxied).toContain('--all-proxy=http://127.0.0.1:8080')
  })
})

describe('buildItemOptions', () => {
  it('uses the download directory when no directory was chosen', () => {
    const { settings } = fixture()
    const options = buildItemOptions({ input: makeInput({ out: 'file.bin' }), settings, kind: 'http' })
    expect(options.dir).toBe(settings.downloadDir)
  })

  it('sends an output name for plain HTTP but never for a torrent', () => {
    const { settings } = fixture()
    const http = buildItemOptions({ input: makeInput({ out: 'file.bin' }), settings, kind: 'http' })
    const torrent = buildItemOptions({ input: makeInput({ out: 'file.bin' }), settings, kind: 'bittorrent' })

    expect(http.out).toBe('file.bin')
    expect(torrent.out).toBeUndefined()
    expect(torrent['file-allocation']).toBe('prealloc')
    expect(http['file-allocation']).toBe('none')
  })

  it('merges an explicit cookie header with any raw headers', () => {
    const { settings } = fixture()
    const options = buildItemOptions({
      input: makeInput({ headers: ['Accept-Language: zh-TW'], cookieHeader: 'session=abc' }),
      settings,
      kind: 'http'
    })
    expect(options.header).toEqual(['Accept-Language: zh-TW', 'Cookie: session=abc'])
  })

  it('omits header entirely when there is nothing to send', () => {
    const { settings } = fixture()
    const options = buildItemOptions({ input: makeInput(), settings, kind: 'http' })
    expect(options.header).toBeUndefined()
  })

  it('maps credentials, proxy and pause onto aria2 option names', () => {
    const { settings } = fixture()
    const options = buildItemOptions({
      input: makeInput({
        username: 'user',
        password: 'pass',
        proxy: 'http://127.0.0.1:3128',
        paused: true,
        maxDownloadLimit: 4096,
        split: 4,
        maxConnectionPerServer: 3,
        minSplitSize: 1024 * 1024
      }),
      settings,
      kind: 'http'
    })

    expect(options['http-user']).toBe('user')
    expect(options['http-passwd']).toBe('pass')
    expect(options['all-proxy']).toBe('http://127.0.0.1:3128')
    expect(options.pause).toBe('true')
    expect(options['max-download-limit']).toBe('4096')
    expect(options.split).toBe('4')
    expect(options['max-connection-per-server']).toBe('3')
    expect(options['min-split-size']).toBe('1048576')
  })

  it('only selects files for torrents when indices were given', () => {
    const { settings } = fixture()
    const selected = buildItemOptions({
      input: makeInput({ selectFileIndices: [1, 3] }),
      settings,
      kind: 'bittorrent'
    })
    const all = buildItemOptions({ input: makeInput(), settings, kind: 'bittorrent' })

    expect(selected['select-file']).toBe('1,3')
    expect(all['select-file']).toBeUndefined()
  })
})

describe('globalLimitOptions', () => {
  it('exposes the live-changeable options with string values', () => {
    const { settings } = fixture()
    const live = globalLimitOptions({ ...settings, globalDownloadLimit: 2048 })
    expect(live).toEqual({
      'max-overall-download-limit': '2048',
      'max-overall-upload-limit': '0',
      'max-concurrent-downloads': '5',
      'max-connection-per-server': String(settings.maxConnectionPerServer),
      split: String(settings.split),
      'min-split-size': String(Math.max(0, Math.floor(settings.minSplitSize)))
    })
  })
})

/**
 * The BitTorrent options are the one place where a bad value is worse than a
 * missing one: aria2 validates its arguments at startup and refuses to run at
 * all (`errorCode=28`) when one is out of range, so every value a user can type
 * has to arrive either clamped or absent.
 */
describe('BitTorrent daemon arguments', () => {
  const daemon = (overrides: Partial<ReturnType<typeof createDefaultSettings>> = {}): string[] => {
    const base = fixture()
    return buildDaemonArgs({
      settings: { ...base.settings, ...overrides },
      paths: base.paths,
      port: 1,
      secret: 'x',
      disableIpv6: false
    })
  }

  const startsWith = (args: string[], prefix: string): boolean =>
    args.some((arg) => arg.startsWith(prefix))

  it('leaves every aria2 default alone when nothing was switched on', () => {
    const args = daemon()

    expect(args).toContain('--enable-dht=true')
    expect(args).toContain('--enable-peer-exchange=true')
    expect(args).toContain('--bt-enable-lpd=true')
    expect(args).not.toContain('--enable-dht6=true')

    // 0 means "let aria2 choose", and the way to say that is to say nothing.
    expect(startsWith(args, '--listen-port=')).toBe(false)
    expect(startsWith(args, '--dht-listen-port=')).toBe(false)
    expect(startsWith(args, '--bt-max-peers=')).toBe(false)
    expect(startsWith(args, '--bt-require-crypto=')).toBe(false)
    expect(startsWith(args, '--bt-min-crypto-level=')).toBe(false)
    expect(startsWith(args, '--bt-stop-timeout=')).toBe(false)
    expect(startsWith(args, '--bt-detach-seed-only=')).toBe(false)
    expect(startsWith(args, '--bt-tracker=')).toBe(false)
    expect(startsWith(args, '--peer-id-prefix=')).toBe(false)
    expect(startsWith(args, '--peer-agent=')).toBe(false)
  })

  it('can switch each peer-discovery mechanism off, and IPv6 DHT on', () => {
    const args = daemon({ btDht: false, btPex: false, btLpd: false, btDht6: true })

    expect(args).toContain('--enable-dht=false')
    expect(args).toContain('--enable-peer-exchange=false')
    expect(args).toContain('--bt-enable-lpd=false')
    expect(args).toContain('--enable-dht6=true')
  })

  it('moves both listeners together when a port is fixed', () => {
    const args = daemon({ btListenPort: 51413 })

    // A fixed port on one listener and a random one on the other would leave a
    // router's port forward pointing at half the traffic.
    expect(args).toContain('--listen-port=51413')
    expect(args).toContain('--dht-listen-port=51413')
  })

  it('clamps a port aria2 would refuse instead of failing to start the engine', () => {
    expect(daemon({ btListenPort: 80 })).toContain('--listen-port=1024')
    expect(daemon({ btListenPort: 999_999 })).toContain('--listen-port=65535')
  })

  it('demands encryption only when asked, and then honours the level', () => {
    const required = daemon({ btRequireEncryption: true })
    expect(required).toContain('--bt-require-crypto=true')
    expect(startsWith(required, '--bt-min-crypto-level=')).toBe(false)

    expect(daemon({ btRequireEncryption: true, btMinCryptoLevel: 'arc4' })).toContain(
      '--bt-min-crypto-level=arc4'
    )

    // A level with nothing demanding it means nothing: aria2 accepts plain peers
    // whatever it says, so neither flag is sent.
    const off = daemon({ btRequireEncryption: false, btMinCryptoLevel: 'arc4' })
    expect(startsWith(off, '--bt-require-crypto=')).toBe(false)
    expect(startsWith(off, '--bt-min-crypto-level=')).toBe(false)
  })

  it('joins the tracker list and drops entries aria2 cannot announce to', () => {
    const args = daemon({
      btTrackers: [
        'udp://tracker.example.org:6969/announce',
        'https://tracker.example.net/announce',
        '   ',
        'not a url',
        'wss://tracker.example.com',
        // A duplicate is dropped, so a list pasted twice does not grow the flag.
        'udp://tracker.example.org:6969/announce'
      ]
    })

    expect(args.find((arg) => arg.startsWith('--bt-tracker='))).toBe(
      '--bt-tracker=udp://tracker.example.org:6969/announce,https://tracker.example.net/announce'
    )
  })

  it('omits the tracker flag entirely when nothing usable was given', () => {
    expect(startsWith(daemon({ btTrackers: ['nonsense'] }), '--bt-tracker=')).toBe(false)
  })

  it('clamps the peer count to what aria2 accepts', () => {
    expect(daemon({ btMaxPeers: 1 })).toContain('--bt-max-peers=1')
    expect(daemon({ btMaxPeers: 999_999 })).toContain('--bt-max-peers=2000')
  })

  it('sanitises the peer identity, because aria2 refuses the whole launch over it', () => {
    const clean = daemon({ btPeerIdPrefix: '-AZ2060-', btPeerAgent: 'AriaDM/1.0' })
    expect(clean).toContain('--peer-id-prefix=-AZ2060-')
    expect(clean).toContain('--peer-agent=AriaDM/1.0')

    // Control characters and an over-long value are trimmed rather than passed
    // through: this text goes on the wire verbatim.
    const messy = daemon({ btPeerIdPrefix: 'ab\ncd\tef', btPeerAgent: 'x'.repeat(200) })
    expect(messy).toContain('--peer-id-prefix=abcdef')
    expect(messy).toContain(`--peer-agent=${'x'.repeat(64)}`)
  })

  it('turns the seeding and stop-timeout knobs into flags only when set', () => {
    expect(daemon({ btDetachSeedOnly: true })).toContain('--bt-detach-seed-only=true')
    expect(daemon({ btStopTimeout: 300 })).toContain('--bt-stop-timeout=300')
    expect(startsWith(daemon({ btStopTimeout: 999_999_999 }), '--bt-stop-timeout=')).toBe(true)
    expect(daemon({ btStopTimeout: 999_999_999 })).toContain('--bt-stop-timeout=86400')
  })
})

describe('BitTorrent live options', () => {
  it('never sends the listen port, which aria2 reads only at startup', () => {
    const { settings } = fixture()
    const live = btGlobalOptions({ ...settings, btListenPort: 51413 })

    // Sending it would make the supervisor log a failure on every settings
    // change for an option it cannot act on; the UI says a restart is needed.
    expect(live['listen-port']).toBeUndefined()
    expect(live['dht-listen-port']).toBeUndefined()
  })

  it('clears the tracker list with an empty string, which is how aria2 is told', () => {
    const { settings } = fixture()

    expect(btGlobalOptions({ ...settings, btTrackers: [] })['bt-tracker']).toBe('')
    expect(btGlobalOptions({ ...settings, btTrackers: ['udp://a.example:1/x'] })['bt-tracker']).toBe(
      'udp://a.example:1/x'
    )
  })

  it('never sends the peer identity, which aria2 accepts and then ignores at runtime', () => {
    const { settings } = fixture()
    const live = btGlobalOptions({ ...settings, btPeerIdPrefix: 'ZZ0001', btPeerAgent: 'AriaDM/1.0' })

    // Measured against the pinned 1.37.0 build: changeGlobalOption answers
    // success for both, and getGlobalOption still reports aria2's own values
    // afterwards. They are daemon arguments, so they wait for a restart.
    expect('peer-id-prefix' in live).toBe(false)
    expect('peer-agent' in live).toBe(false)
  })

  it('sends only the options the pinned build actually applies at runtime', () => {
    const { settings } = fixture()
    const live = btGlobalOptions({
      ...settings,
      btDht: false,
      btPex: false,
      btLpd: false,
      btMaxPeers: 40,
      btDetachSeedOnly: true,
      btRequireEncryption: true,
      btMinCryptoLevel: 'arc4'
    })

    expect(live).toMatchObject({
      'enable-peer-exchange': 'false',
      'bt-enable-lpd': 'false',
      'bt-max-peers': '40',
      'bt-require-crypto': 'true',
      'bt-min-crypto-level': 'arc4'
    })

    // Accepted with no error and then silently ignored, which is the one outcome
    // worse than being refused: the user changes a switch, nothing happens, and
    // nothing says why. These are restart-only, and the UI says so.
    expect('enable-dht' in live).toBe(false)
    expect('bt-detach-seed-only' in live).toBe(false)
  })
})
