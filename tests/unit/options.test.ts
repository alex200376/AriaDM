import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildDaemonArgs, buildItemOptions, globalLimitOptions, type DaemonPaths } from '../../src/main/aria2/options'
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
    const args = buildDaemonArgs({ settings, paths, port: 6800, secret: 's3cret' })

    expect(args).toContain('--rpc-listen-all=false')
    expect(args).toContain('--rpc-allow-origin-all=false')
    expect(args).toContain('--enable-rpc=true')
    expect(args).toContain('--rpc-listen-port=6800')
    expect(args).toContain('--rpc-secret=s3cret')
  })

  it('ignores any aria2.conf the machine happens to have', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x' })
    expect(args).toContain('--no-conf=true')
  })

  it('always points at the configured log file and download folder', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x' })
    expect(args).toContain(`--log=${paths.logFile}`)
    expect(args).toContain(`--dir=${paths.downloadDir}`)
    expect(args).toContain('--continue=true')
  })

  it('never persists or replays a session, so the queue starts empty every launch', () => {
    const { settings, paths } = fixture()
    const args = buildDaemonArgs({ settings, paths, port: 1, secret: 'x' })

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
      secret: 'x'
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
      secret: 'x'
    })
    expect(none).toContain('--seed-time=0')
    expect(none.some((arg) => arg.startsWith('--seed-ratio='))).toBe(false)

    const seeded = buildDaemonArgs({
      settings: { ...base.settings, seedRatio: 2, seedTime: 0 },
      paths: base.paths,
      port: 1,
      secret: 'x'
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
      secret: 'x'
    })
    expect(plain.some((arg) => arg.startsWith('--all-proxy='))).toBe(false)

    const proxied = buildDaemonArgs({
      settings: { ...base.settings, proxy: 'http://127.0.0.1:8080' },
      paths: base.paths,
      port: 1,
      secret: 'x'
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
