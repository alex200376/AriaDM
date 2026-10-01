/** Raw shapes returned by aria2, kept narrow and separate from our own model. */

export type Aria2NotificationMethod =
  | 'aria2.onDownloadStart'
  | 'aria2.onDownloadPause'
  | 'aria2.onDownloadStop'
  | 'aria2.onDownloadComplete'
  | 'aria2.onDownloadError'
  | 'aria2.onBtDownloadComplete'

export interface Aria2Notification {
  method: Aria2NotificationMethod
  gid: string
}

export interface Aria2RawUri {
  uri: string
  status: 'used' | 'waiting'
}

export interface Aria2RawFile {
  index: string
  path: string
  length: string
  completedLength: string
  selected: string
  uris: Aria2RawUri[]
}

export interface Aria2RawBittorrent {
  announceList?: string[][]
  comment?: string
  creationDate?: number
  mode?: string
  info?: { name?: string }
}

export interface Aria2RawStatus {
  gid: string
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'
  totalLength: string
  completedLength: string
  uploadLength: string
  downloadSpeed: string
  uploadSpeed: string
  connections: string
  numSeeders?: string
  seeder?: string
  pieceLength: string
  numPieces: string
  errorCode?: string
  errorMessage?: string
  followedBy?: string[]
  following?: string
  belongsTo?: string
  dir: string
  files: Aria2RawFile[]
  bittorrent?: Aria2RawBittorrent
  infoHash?: string
  verifiedLength?: string
  verifyIntegrityPending?: string
}

export interface Aria2RawServer {
  index: string
  currentUri: string
  downloadSpeed: string
  uri: string
}

export interface Aria2RawPeer {
  peerId: string
  ip: string
  port: string
  bitfield: string
  amChoking: string
  peerChoking: string
  downloadSpeed: string
  uploadSpeed: string
  seeder: string
}

export interface Aria2RawGlobalStat {
  downloadSpeed: string
  uploadSpeed: string
  numActive: string
  numWaiting: string
  numStopped: string
  numStoppedTotal: string
}

/**
 * The key subset we ask aria2 for on every poll. Requesting only these keeps the
 * 1 Hz tick payload small; the detail drawer fetches the heavy fields on demand.
 */
export const POLL_KEYS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'uploadLength',
  'downloadSpeed',
  'uploadSpeed',
  'connections',
  'numSeeders',
  'seeder',
  'pieceLength',
  'numPieces',
  'errorCode',
  'errorMessage',
  'dir',
  'files',
  'bittorrent',
  'infoHash',
  'verifiedLength',
  'verifyIntegrityPending'
]
