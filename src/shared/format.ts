/**
 * Pure formatting helpers. Shared so the renderer and the main process agree,
 * and so they can be unit tested without a DOM.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/**
 * Format a byte count. Uses 1024-based units, matching what every other
 * download manager shows.
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  const digits = exponent === 0 ? 0 : decimals
  return `${value.toFixed(digits)} ${UNITS[exponent]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—'
  if (seconds <= 0) return '0s'
  const total = Math.round(seconds)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatPercent(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return '0%'
  const clamped = Math.min(Math.max(fraction, 0), 1)
  return `${(clamped * 100).toFixed(decimals)}%`
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n)
}

export function formatDateTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

/** Compact "3m ago" style relative time. */
export function formatRelative(ms: number | null, now = Date.now()): string {
  if (!ms) return '—'
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return '剛剛'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分鐘前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小時前`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toLocaleDateString()
}

/**
 * Parse a human typed size/limit such as "5M", "500K", "2G", "0" or "unlimited"
 * into bytes. Returns null when the input is not parseable.
 */
export function parseSize(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  if (/^(0|unlimited|無限)$/i.test(trimmed)) return 0
  const match = /^([0-9]*\.?[0-9]+)\s*([kmgt]?)b?$/i.exec(trimmed)
  if (!match) return null
  const value = Number.parseFloat(match[1]!)
  if (!Number.isFinite(value)) return null
  const suffix = (match[2] ?? '').toLowerCase()
  const multiplier = suffix === '' ? 1 : Math.pow(1024, UNITS.findIndex((u) => u[0]!.toLowerCase() === suffix))
  return Math.round(value * multiplier)
}

export function parseSpeed(input: string): number | null {
  const size = parseSize(input)
  if (size === null) return null
  return size
}

export function toPercentValue(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  return Math.min(Math.max(fraction, 0), 1) * 100
}

/**
 * Clamp a scrolling/text value so it is safe to render in a single line.
 */
export function truncateMiddle(text: string, max = 60): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`
}

export function formatBytesPair(completed: number, total: number): string {
  if (total <= 0) return formatBytes(completed)
  return `${formatBytes(completed)} / ${formatBytes(total)}`
}

export function isTorrentLike(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.torrent') || lower.startsWith('magnet:')
}
