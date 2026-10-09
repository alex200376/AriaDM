/**
 * Core download model shared by the main process and the renderer.
 *
 * Everything here is plain data so it can cross the IPC boundary untouched.
 */

export type DownloadStatus =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'error'
  | 'removed'

/** Which downloader actually owns this item. */
export type DownloadEngine = 'aria2' | 'ytdlp'

/**
 * Provenance tag for a media link that resolved to one plain file and was handed
 * to aria2's multi-connection engine.
 *
 * Without it such a row is indistinguishable from an ordinary aria2 download,
 * which is confusing for something the user asked for as a video: it explains why
 * one video came down through aria2 and the next through yt-dlp (a segmented
 * stream, which only yt-dlp can assemble).
 */
export const DIRECT_MEDIA_TAG = 'aria2-direct'

export type DownloadKind = 'http' | 'ftp' | 'bittorrent' | 'metalink' | 'media'

export type AddSource =
  | 'manual'
  | 'clipboard'
  | 'browser'
  | 'file'
  | 'protocol'
  | 'session'
  | 'retry'

export type PostActionState = 'idle' | 'running' | 'done' | 'failed'

export interface DownloadUri {
  uri: string
  status: 'used' | 'waiting'
}

export interface DownloadFileEntry {
  index: number
  /** Absolute path as reported by aria2. */
  path: string
  name: string
  length: number
  completedLength: number
  selected: boolean
  uris: DownloadUri[]
}

export interface ServerInfo {
  index: number
  currentUri: string
  downloadSpeed: number
  uri: string
}

export interface PeerInfo {
  peerId: string
  ip: string
  port: number
  bitfield: string
  amChoking: boolean
  peerChoking: boolean
  downloadSpeed: number
  uploadSpeed: number
  seeder: boolean
}

export interface BittorrentMeta {
  announceList: string[][]
  comment: string
  creationDate: number
  mode: string
}

/** A single download, normalised across the aria2 and yt-dlp engines. */
export interface DownloadItem {
  gid: string
  engine: DownloadEngine
  kind: DownloadKind
  status: DownloadStatus

  name: string
  dir: string
  files: DownloadFileEntry[]
  numFiles: number

  totalLength: number
  completedLength: number
  /** Bytes per second. 0 when stalled. */
  downloadSpeed: number
  uploadSpeed: number

  /** Number of live connections aria2 currently holds for this item. */
  connections: number
  numSeeders: number
  seeder: boolean
  pieceLength: number
  numPieces: number

  errorCode: number
  errorMessage: string

  verifiedLength: number
  verifyIntegrityPending: boolean
  infoHash: string | null
  bittorrent: BittorrentMeta | null

  category: string
  tags: string[]
  addedAt: number
  completedAt: number | null
  source: AddSource
  /** Position within the waiting queue, or -1 when not queued. */
  queuePosition: number

  /** Per-item cap in bytes/sec; 0 means unlimited. */
  maxDownloadLimit: number
  /** Connection fan-out actually in effect for this item. */
  split: number
  maxConnectionPerServer: number
  referer: string
  userAgent: string

  postActionState: PostActionState
  postActionError: string
  /** True once the completion notification has been shown. */
  notified: boolean
  /** yt-dlp only: the resolved human readable format label. */
  mediaFormat: string | null
  /** Magnet links have no metadata until the swarm provides it. */
  metadataPending: boolean
}

/** Fraction downloaded in the range 0..1. An unknown total yields 0. */
export function progressOf(item: Pick<DownloadItem, 'completedLength' | 'totalLength' | 'status'>): number {
  if (item.status === 'complete') return 1
  if (item.totalLength <= 0) return 0
  const ratio = item.completedLength / item.totalLength
  if (!Number.isFinite(ratio) || ratio < 0) return 0
  return ratio > 1 ? 1 : ratio
}

/**
 * Seconds remaining, or null when it cannot be known yet.
 * Deliberately returns null rather than Infinity so callers must render a
 * placeholder instead of accidentally printing "Infinity".
 */
export function etaOf(
  item: Pick<DownloadItem, 'completedLength' | 'totalLength' | 'downloadSpeed' | 'status'>
): number | null {
  if (item.status === 'complete') return 0
  if (item.downloadSpeed <= 0) return null
  if (item.totalLength <= 0) return null
  const remaining = item.totalLength - item.completedLength
  if (remaining <= 0) return 0
  return remaining / item.downloadSpeed
}

export interface GlobalStat {
  downloadSpeed: number
  uploadSpeed: number
  numActive: number
  numWaiting: number
  numStopped: number
  /** Total stopped results aria2 is retaining, out of its configured cap. */
  numStoppedTotal: number
}

export type EngineState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed'

export interface EngineStatus {
  state: EngineState
  pid: number | null
  port: number | null
  version: string
  /** Human readable detail for the failure banner. */
  message: string
  restarts: number
  lastError: string
  /** Tail of the aria2 log, populated when state is 'failed'. */
  logTail: string
  startedAt: number | null
}

/** One throughput reading, used to draw the speed graph. */
export interface SpeedSample {
  at: number
  download: number
  upload: number
}

export interface TickPayload {
  /**
   * Items to upsert, matched by `gid`.
   *
   * A queue of a thousand stopped downloads is static: resending all of it every
   * second cost a structured clone of every item plus a full renderer render for
   * no new information. So a tick carries only what moved since the previous one
   * — except when `full` is set, where this is the whole list and the renderer
   * replaces what it holds rather than merging.
   */
  items: DownloadItem[]
  /** Gids of items that no longer exist, and must be dropped from the list. */
  removedGids: string[]
  /** True when `items` is the complete list rather than a delta. */
  full: boolean
  global: GlobalStat
  engine: EngineStatus
  at: number
  /** Rolling window of aggregate throughput, oldest first. */
  speedSeries: SpeedSample[]
}

/**
 * A persisted record of one download.
 *
 * This is a superset of what aria2 retains, and it is what the History view
 * reads. Live items come from aria2; history rows come from here.
 */
export interface HistoryRow {
  gid: string
  name: string
  dir: string
  category: string
  tags: string[]
  kind: DownloadKind
  engine: DownloadEngine
  /** Mirror list for a single download, in priority order. */
  uris: string[]
  totalLength: number
  addedAt: number
  completedAt: number | null
  source: AddSource
  status: DownloadStatus
  mediaFormat: string | null
  errorCode: number
  errorMessage: string
  postActionState: PostActionState
  notified: boolean
}

export type HistorySortField = 'addedAt' | 'name' | 'size' | 'completedAt'

export interface HistoryQuery {
  search: string
  status: DownloadStatus | 'all'
  category: string | 'all'
  sort: HistorySortField
  direction: 'asc' | 'desc'
  offset: number
  limit: number
}

export interface HistoryPage {
  total: number
  rows: HistoryRow[]
}

export interface ClipboardDetected {
  text: string
  urls: string[]
  kind: DownloadKind
  /** True when the same link was seen before in this session. */
  seenBefore: boolean
}

export interface ToastPayload {
  id: string
  title: string
  body: string
  tone: 'info' | 'success' | 'warn' | 'error'
  action?: { label: string; channel: string }
}

export interface ToolkitStatus {
  aria2: ToolInfo
  ytdlp: ToolInfo
  ffmpeg: ToolInfo
}

export interface ToolInfo {
  name: string
  path: string
  version: string
  present: boolean
  source: 'bundled' | 'userData' | 'system' | 'missing'
  expectedVersion: string
  /** Populated when the file is present but failed its integrity check. */
  integrityError: string
}

/**
 * aria2's `bitfield`, decoded.
 *
 * Both BitTorrent and segmented HTTP downloads report one of these, so the same
 * view serves either kind. The raw hex string grows with the piece count — a
 * 40 GB torrent at 1 MB pieces is 5,000 pieces, or 1,250 characters — which is
 * why it is fetched on demand instead of riding along with every poll.
 */
export interface PieceMap {
  numPieces: number
  pieceLength: number
  completedPieces: number
  /** One flag per piece, in order. */
  pieces: boolean[]
  bitfield: string
}

/**
 * Decode a `bitfield` hex string.
 *
 * aria2 packs one bit per piece, most significant bit first, which is the same
 * convention BitTorrent uses on the wire. Padding bits past `numPieces` are
 * discarded rather than rendered as phantom incomplete pieces.
 */
export function decodeBitfield(bitfield: string, numPieces: number): boolean[] {
  const pieces: boolean[] = []
  for (const character of bitfield) {
    const nibble = Number.parseInt(character, 16)
    if (Number.isNaN(nibble)) break
    for (let bit = 3; bit >= 0; bit -= 1) {
      if (pieces.length >= numPieces) return pieces
      pieces.push(((nibble >> bit) & 1) === 1)
    }
  }
  return pieces
}

/**
 * Coalesce per-piece flags into at most `maxGroups` cells.
 *
 * A torrent can carry tens of thousands of pieces, far more cells than anyone
 * can read. Neighbouring pieces are merged to keep the grid legible, and each
 * cell reports how many of its pieces are done so a partly finished cell shows
 * as partial rather than being rounded to done or not started.
 */
export function groupPieces(pieces: boolean[], maxGroups = 512): { complete: number; total: number }[] {
  if (pieces.length === 0) return []
  const groupSize = Math.ceil(pieces.length / Math.max(1, maxGroups))
  const groups: { complete: number; total: number }[] = []
  for (let start = 0; start < pieces.length; start += groupSize) {
    const slice = pieces.slice(start, start + groupSize)
    groups.push({ complete: slice.filter(Boolean).length, total: slice.length })
  }
  return groups
}
