import type {
  BittorrentMeta,
  DownloadFileEntry,
  DownloadItem,
  DownloadKind,
  PeerInfo,
  ServerInfo
} from '@shared/download'
import type { Settings } from '@shared/settings'
import { fileNameFromPath, fileNameFromUri, kindFromUri } from '@shared/uri'

import type { Aria2RawPeer, Aria2RawServer, Aria2RawStatus } from '../aria2/types'

import type { HistoryRecord } from './history-store'

export function toNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export function toBoolean(value: string | boolean | undefined | null): boolean {
  if (typeof value === 'boolean') return value
  return value === 'true' || value === '1'
}

function mapFiles(raw: Aria2RawStatus): DownloadFileEntry[] {
  return (raw.files ?? []).map((file) => {
    const filePath = file.path ?? ''
    return {
      index: toNumber(file.index),
      path: filePath,
      name: fileNameFromPath(filePath),
      length: toNumber(file.length),
      completedLength: toNumber(file.completedLength),
      selected: toBoolean(file.selected),
      uris: (file.uris ?? []).map((uri) => ({ uri: uri.uri, status: uri.status }))
    }
  })
}

function mapBittorrent(raw: Aria2RawStatus): BittorrentMeta | null {
  if (!raw.bittorrent) return null
  return {
    announceList: raw.bittorrent.announceList ?? [],
    comment: raw.bittorrent.comment ?? '',
    creationDate: raw.bittorrent.creationDate ?? 0,
    mode: raw.bittorrent.mode ?? ''
  }
}

/** Choose a display name, preferring what the engine actually resolved. */
function resolveName(raw: Aria2RawStatus, files: DownloadFileEntry[], meta: HistoryRecord | undefined): string {
  const torrentName = raw.bittorrent?.info?.name
  if (torrentName) return torrentName

  const firstFileName = files.find((file) => file.name.length > 0)?.name
  if (firstFileName) return firstFileName

  if (meta?.name) return meta.name

  const firstUri = files[0]?.uris?.[0]?.uri ?? meta?.uris[0]
  if (firstUri) return fileNameFromUri(firstUri)

  return '等待中繼資料'
}

function inferKind(raw: Aria2RawStatus, files: DownloadFileEntry[], meta: HistoryRecord | undefined): DownloadKind {
  if (meta?.engine === 'ytdlp') return 'media'
  if (raw.bittorrent) return 'bittorrent'
  // aria2 does not label metalink downloads explicitly. Several files with no
  // torrent metadata is the practical signal for one.
  if (files.length > 1) return 'metalink'
  const uri = files[0]?.uris?.[0]?.uri ?? meta?.uris[0] ?? ''
  if (uri) return kindFromUri(uri)
  return meta?.kind ?? 'http'
}

export interface MapContext {
  meta: HistoryRecord | undefined
  queuePosition: number
  settings: Settings
}

export function mapToItem(raw: Aria2RawStatus, context: MapContext): DownloadItem {
  const { meta, settings, queuePosition } = context
  const files = mapFiles(raw)
  const totalLength = toNumber(raw.totalLength)
  const completedLength = toNumber(raw.completedLength)
  const kind = inferKind(raw, files, meta)

  // A magnet link reports no files and no length until the swarm supplies the
  // metadata. Showing that state explicitly beats printing "0 B / 0 B".
  const metadataPending = kind === 'bittorrent' && totalLength === 0 && files.length === 0 && raw.status !== 'error'

  // aria2 keeps reporting the rate it last measured after a download is paused
  // or has finished. Passing that through would make a parked row look like it
  // is still transferring, so a rate is only reported while it is active.
  const transferring = raw.status === 'active'

  return {
    gid: raw.gid,
    engine: meta?.engine ?? 'aria2',
    kind,
    status: raw.status,
    name: resolveName(raw, files, meta),
    dir: raw.dir || meta?.dir || settings.downloadDir,
    files,
    numFiles: files.length,

    totalLength,
    completedLength,
    downloadSpeed: transferring ? toNumber(raw.downloadSpeed) : 0,
    uploadSpeed: transferring ? toNumber(raw.uploadSpeed) : 0,
    connections: toNumber(raw.connections),
    numSeeders: toNumber(raw.numSeeders),
    seeder: toBoolean(raw.seeder),
    pieceLength: toNumber(raw.pieceLength),
    numPieces: toNumber(raw.numPieces),

    errorCode: toNumber(raw.errorCode),
    errorMessage: raw.errorMessage ?? '',

    verifiedLength: toNumber(raw.verifiedLength),
    verifyIntegrityPending: toBoolean(raw.verifyIntegrityPending),
    infoHash: raw.infoHash ?? null,
    bittorrent: mapBittorrent(raw),

    category: meta?.category ?? 'other',
    tags: meta?.tags ?? [],
    addedAt: meta?.addedAt ?? Date.now(),
    completedAt: meta?.completedAt ?? null,
    source: meta?.source ?? 'manual',
    queuePosition,

    maxDownloadLimit: meta?.maxDownloadLimit ?? 0,
    split: meta?.split ?? settings.split,
    maxConnectionPerServer: meta?.maxConnectionPerServer ?? settings.maxConnectionPerServer,
    referer: meta?.referer ?? '',
    userAgent: meta?.userAgent ?? '',

    postActionState: meta?.postActionState ?? 'idle',
    postActionError: '',
    notified: meta?.notified ?? false,
    mediaFormat: meta?.mediaFormat ?? null,
    metadataPending
  }
}

export function mapServer(raw: Aria2RawServer): ServerInfo {
  return {
    index: toNumber(raw.index),
    currentUri: raw.currentUri ?? '',
    downloadSpeed: toNumber(raw.downloadSpeed),
    uri: raw.uri ?? ''
  }
}

export function mapPeer(raw: Aria2RawPeer): PeerInfo {
  return {
    peerId: raw.peerId ?? '',
    ip: raw.ip ?? '',
    port: toNumber(raw.port),
    bitfield: raw.bitfield ?? '',
    amChoking: toBoolean(raw.amChoking),
    peerChoking: toBoolean(raw.peerChoking),
    downloadSpeed: toNumber(raw.downloadSpeed),
    uploadSpeed: toNumber(raw.uploadSpeed),
    seeder: toBoolean(raw.seeder)
  }
}
