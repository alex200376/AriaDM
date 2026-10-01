import type { AddDownloadInput, Settings } from '@shared/settings'

export interface DaemonPaths {
  sessionFile: string
  logFile: string
  downloadDir: string
}

export interface DaemonArgOptions {
  settings: Settings
  paths: DaemonPaths
  port: number
  secret: string
  /**
   * Tell aria2 to ignore IPv6 entirely. Resolved by the caller from the machine's
   * interfaces plus the user's setting; see `aria2/ipv6.ts`.
   */
  disableIpv6: boolean
}

function limit(value: number): string {
  // aria2 accepts bare byte counts and also K/M suffixes; bare bytes is unambiguous.
  return String(Math.max(0, Math.floor(value)))
}

/**
 * Ranges aria2 enforces on the options we pass.
 *
 * This matters more than it looks: aria2 validates its arguments at startup and
 * refuses to run at all when one is out of range (`errorCode=28`, then exit). A
 * user typing an odd number into the settings for `--min-split-size` used to
 * stop the whole engine from booting, so every bounded option is clamped here
 * rather than trusted. Values at or below zero mean "unset" and take the default
 * aria2 would have used.
 */
const RANGES = {
  split: { min: 1, max: 16, fallback: 5 },
  maxConnectionPerServer: { min: 1, max: 16, fallback: 5 },
  minSplitSize: { min: 1024 * 1024, max: 1024 * 1024 * 1024, fallback: 20 * 1024 * 1024 },
  maxConcurrentDownloads: { min: 1, max: 100, fallback: 5 }
} as const

function clamp(value: number, range: { min: number; max: number; fallback: number }): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0)
  if (rounded <= 0) return range.fallback
  return Math.min(Math.max(rounded, range.min), range.max)
}

export function clampSplit(value: number): number {
  return clamp(value, RANGES.split)
}

export function clampMaxConnectionPerServer(value: number): number {
  return clamp(value, RANGES.maxConnectionPerServer)
}

export function clampMinSplitSize(value: number): number {
  return clamp(value, RANGES.minSplitSize)
}

export function clampMaxConcurrentDownloads(value: number): number {
  return clamp(value, RANGES.maxConcurrentDownloads)
}

/**
 * Worker tolerance defaults. These are deliberate product choices:
 *  - `--no-conf=true` isolates us completely from any aria2.conf on the machine,
 *    so a user's unrelated aria2 setup can never silently change our behaviour.
 *  - loopback-only RPC plus a per-run secret keeps the control plane private.
 *  - `--summary-interval=0` silences the console readout, which nobody sees.
 */
export function buildDaemonArgs(options: DaemonArgOptions): string[] {
  const { settings, paths, port, secret, disableIpv6 } = options

  const args: string[] = [
    // Isolation and RPC control plane.
    '--no-conf=true',
    '--enable-rpc=true',
    '--rpc-listen-all=false',
    '--rpc-listen-port=' + String(port),
    `--rpc-secret=${secret}`,
    '--rpc-allow-origin-all=false',

    // Destination and file handling.
    `--dir=${paths.downloadDir}`,
    '--continue=true',
    '--auto-file-renaming=true',
    '--allow-overwrite=false',
    '--remote-time=true',
    // Torrents frequently carry non-ASCII names resolved from Content-Disposition.
    '--content-disposition-default-utf8=true',

    // Connection fan-out.
    `--max-concurrent-downloads=${clampMaxConcurrentDownloads(settings.maxConcurrentDownloads)}`,
    `--max-connection-per-server=${clampMaxConnectionPerServer(settings.maxConnectionPerServer)}`,
    `--split=${clampSplit(settings.split)}`,
    `--min-split-size=${clampMinSplitSize(settings.minSplitSize)}`,

    // Throughput caps. Zero means unlimited to aria2 as well.
    `--max-overall-download-limit=${limit(settings.globalDownloadLimit)}`,
    `--max-overall-upload-limit=${limit(settings.globalUploadLimit)}`,

    // Retry behaviour.
    `--max-tries=${settings.maxTries}`,
    `--retry-wait=${settings.retryWait}`,
    '--timeout=60',
    '--connect-timeout=30',

    // Control-file persistence: this is what lets an individual paused download
    // carry on from where it stopped. It is distinct from aria2's session file.
    `--auto-save-interval=${settings.autoSaveInterval}`,
    '--max-download-result=2000',

    // Logging.
    '--summary-interval=0',
    '--console-log-level=warn',
    '--log-level=warn',
    `--log=${paths.logFile}`,

    // BitTorrent.
    '--follow-torrent=mem',
    '--bt-save-metadata=true',
    '--bt-metadata-only=false',
    '--enable-dht=true',
    '--enable-peer-exchange=true',
    '--bt-enable-lpd=true',
    '--disk-cache=64M',
    '--bt-max-open-files=100',

    '--check-certificate=true',
    '--ftp-pasv=true',
    '--uri-selector=feedback'
  ]

  args.push(`--user-agent=${settings.userAgent}`)

  // Seeding semantics need care: aria2 treats --seed-time=0 as "do not seed at
  // all", and ends seeding when either the ratio or the time condition is met.
  // So we only pass --seed-time once the user has actually asked for a limit.
  if (settings.seedRatio > 0) {
    args.push(`--seed-ratio=${settings.seedRatio}`)
    if (settings.seedTime > 0) args.push(`--seed-time=${settings.seedTime}`)
  } else if (settings.seedTime <= 0) {
    args.push('--seed-time=0')
  }

  // Only ever emitted when true: aria2's own default is false, and passing
  // `--disable-ipv6=false` explicitly would fight a user's aria2.conf... except
  // we pass `--no-conf=true`, so this is simply the smaller argument list.
  //
  // Without this, aria2 picks an AAAA record on a machine with no IPv6 route and
  // fails with "a socket operation was attempted to an unreachable network" even
  // though the same host downloads fine over IPv4.
  if (disableIpv6) args.push('--disable-ipv6=true')

  if (settings.proxy) args.push(`--all-proxy=${settings.proxy}`)

  // Deliberately *no* `--save-session` / `--input-file`: AriaDM starts every
  // launch with an empty queue. aria2's session file resurrects every paused or
  // errored download it ever saw, which over time became hundreds of stale rows
  // the user had no way to get rid of. Completed downloads stay in History, and
  // `--auto-save-interval` above still resumes individual paused downloads.

  return args
}

export interface ItemOptionInput {
  input: AddDownloadInput
  settings: Settings
  /** BitTorrent and Metalink downloads decide their own filenames. */
  kind: 'http' | 'ftp' | 'bittorrent' | 'metalink' | 'media'
}

/**
 * Per-item RPC options. aria2 expects kebab-case keys, string values, and arrays
 * only for repeatable options such as `header`.
 */
export function buildItemOptions({ input, settings, kind }: ItemOptionInput): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {}

  if (input.dir) options.dir = input.dir
  else options.dir = settings.downloadDir

  // --out is ignored by aria2 for torrent and metalink payloads, and also when
  // --force-sequential is in play, so we only send it where it has meaning.
  if (input.out && (kind === 'http' || kind === 'ftp')) options.out = input.out

  if (input.split > 0) options.split = String(clampSplit(input.split))
  if (input.maxConnectionPerServer > 0) {
    options['max-connection-per-server'] = String(clampMaxConnectionPerServer(input.maxConnectionPerServer))
  }
  if (input.minSplitSize > 0) options['min-split-size'] = String(clampMinSplitSize(input.minSplitSize))

  if (input.maxDownloadLimit > 0) options['max-download-limit'] = String(Math.floor(input.maxDownloadLimit))
  if (input.referer) options.referer = input.referer
  if (input.userAgent) options['user-agent'] = input.userAgent
  if (input.username) options['http-user'] = input.username
  if (input.password) options['http-passwd'] = input.password
  if (input.proxy) options['all-proxy'] = input.proxy

  const headers = [...input.headers]
  if (input.cookieHeader) headers.push(`Cookie: ${input.cookieHeader}`)
  if (headers.length > 0) options.header = headers

  if (input.paused) options.pause = 'true'

  if (kind === 'bittorrent') {
    // Preallocation matters here: BitTorrent writes pieces out of order, and on
    // NTFS the default allocation leaves the file heavily fragmented.
    options['file-allocation'] = 'prealloc'
    options['bt-save-metadata'] = 'true'
    if (input.seedRatio > 0) {
      options['seed-ratio'] = String(input.seedRatio)
      if (input.seedTime > 0) options['seed-time'] = String(input.seedTime)
    } else if (input.seedTime <= 0) {
      options['seed-time'] = '0'
    }
    if (input.selectFileIndices.length > 0) {
      options['select-file'] = input.selectFileIndices.join(',')
    }
  } else {
    options['file-allocation'] = 'none'
  }

  return options
}

/** The connection preset the settings currently resolve to. */
export function resolveConnections(settings: Settings): {
  split: number
  maxConnectionPerServer: number
  minSplitSize: number
} {
  return {
    split: settings.split,
    maxConnectionPerServer: settings.maxConnectionPerServer,
    minSplitSize: settings.minSplitSize
  }
}

export function globalLimitOptions(settings: Settings): Record<string, string> {
  return {
    'max-overall-download-limit': limit(settings.globalDownloadLimit),
    'max-overall-upload-limit': limit(settings.globalUploadLimit),
    'max-concurrent-downloads': String(clampMaxConcurrentDownloads(settings.maxConcurrentDownloads)),
    'max-connection-per-server': String(clampMaxConnectionPerServer(settings.maxConnectionPerServer)),
    split: String(clampSplit(settings.split)),
    'min-split-size': String(clampMinSplitSize(settings.minSplitSize))
  }
}
