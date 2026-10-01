import type { AddSource, DownloadKind } from './download'
import type { LanguageSetting } from './i18n'

// History types live with the rest of the download model; re-exported here so
// callers have a single import site for anything they hand to the app.
export type { HistoryQuery, HistoryPage, HistoryRow, HistorySortField } from './download'

export interface SpeedProfile {
  id: string
  name: string
  /** Bytes per second; 0 means unlimited. */
  maxOverallDownloadLimit: number
  maxOverallUploadLimit: number
  maxConcurrentDownloads: number
  split: number
  maxConnectionPerServer: number
  /** Minimum split size in bytes. */
  minSplitSize: number
}

export type ScheduleAction = 'startAll' | 'pauseAll' | 'applyProfile'

export interface ScheduleRule {
  id: string
  name: string
  enabled: boolean
  /** 0 = Sunday .. 6 = Saturday. */
  days: number[]
  /** Local time, "HH:MM". */
  start: string
  end: string
  action: ScheduleAction
  profileId: string | null
  /** End the session or power down once the queue drains inside this window. */
  shutdownOnFinish: boolean
}

export interface PostAction {
  openFile: boolean
  showInFolder: boolean
  notify: boolean
  /**
   * Optional command. Supports %f (full path), %d (directory) and %n (filename).
   * Executed with execFile and an argv array, never through a shell.
   */
  command: string
}

export interface CategoryRule {
  id: string
  name: string
  /** Lowercase extensions without the leading dot. */
  extensions: string[]
  /** Empty means "use the default download directory". */
  dir: string
  postAction: Partial<PostAction>
}

/**
 * Where yt-dlp should read cookies from.
 *
 * 'auto' picks whichever browser is installed. Cookies are what allow the
 * login-gated sites (X, Instagram, age-restricted YouTube) to be downloaded at
 * all, so this defaults to on rather than making the user discover the setting
 * through a failure.
 */
export type MediaCookieSource =
  | 'auto'
  | 'none'
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'chromium'
  | 'whale'
  | 'comet'
  | 'firefox'
  | 'vivaldi'
  | 'opera'

export type ConnectionsPreset = 'standard' | 'steady' | 'turbo' | 'single' | 'custom'

export interface ConnectionsPresetValues {
  split: number
  maxConnectionPerServer: number
  minSplitSize: number
}

export const CONNECTION_PRESETS: Record<Exclude<ConnectionsPreset, 'custom'>, ConnectionsPresetValues> = {
  standard: { split: 8, maxConnectionPerServer: 8, minSplitSize: 4 * 1024 * 1024 },
  steady: { split: 4, maxConnectionPerServer: 4, minSplitSize: 8 * 1024 * 1024 },
  turbo: { split: 16, maxConnectionPerServer: 16, minSplitSize: 1024 * 1024 },
  single: { split: 1, maxConnectionPerServer: 1, minSplitSize: 1024 * 1024 }
}

export interface WindowBounds {
  width: number
  height: number
  x: number | null
  y: number | null
  maximised: boolean
}

/**
 * What to do about IPv6 when talking to aria2.
 *
 * `auto` disables IPv6 only when the machine has no globally routable address,
 * which is the case that produces a bare "unreachable network" failure on hosts
 * that publish AAAA records. `on` forces the flag for a machine whose IPv6 looks
 * routable but does not work; `off` never sets it.
 */
export type Ipv6Mode = 'auto' | 'on' | 'off'

export interface Settings {
  downloadDir: string
  connectionsPreset: ConnectionsPreset
  split: number
  maxConnectionPerServer: number
  minSplitSize: number
  maxConcurrentDownloads: number

  globalDownloadLimit: number
  globalUploadLimit: number

  theme: 'dark' | 'light' | 'system'
  /** 'system' follows the OS locale; the other values pin a shipped locale. */
  language: LanguageSetting
  accent: string
  density: 'compact' | 'comfortable'

  closeToTray: boolean
  startMinimised: boolean
  notifyOnComplete: boolean
  notifyOnError: boolean
  soundOnComplete: boolean

  clipboardWatch: boolean
  clipboardAutoAdd: boolean

  handoffEnabled: boolean
  handoffPort: number
  handoffToken: string
  /** Show the IDM-style confirmation window when the extension catches a download. */
  showCatchPopup: boolean

  ytdlpEnabled: boolean
  ytdlpDetectSites: boolean
  mediaCookiesFromBrowser: MediaCookieSource
  /**
   * Let the browser extension hand over the live session for a page it can see.
   *
   * The only way to get cookies out of a browser yt-dlp cannot read (a Chromium
   * fork it has no name for, a database the running browser holds open, or one
   * using app-bound encryption). The value is held in memory only, and never
   * logged or written to disk.
   */
  mediaExtensionCookies: boolean
  ffmpegPath: string

  aria2Path: string
  aria2RpcPort: number
  disableIpv6: Ipv6Mode
  autoSaveInterval: number
  maxTries: number
  retryWait: number
  userAgent: string
  proxy: string

  seedRatio: number
  seedTime: number

  useSystemTray: boolean
  confirmOnExit: boolean

  activeProfileId: string | null
  profiles: SpeedProfile[]
  schedules: ScheduleRule[]
  categories: CategoryRule[]
  postAction: PostAction

  /** Category ids the user has hidden in the sidebar. */
  hiddenCategories: string[]
  window: WindowBounds
}

export const DEFAULT_CATEGORIES: CategoryRule[] = [
  { id: 'video', name: '影片', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts'], dir: '', postAction: {} },
  { id: 'audio', name: '音樂', extensions: ['mp3', 'flac', 'wav', 'aac', 'ogg', 'opus', 'm4a', 'wma', 'aiff', 'alac'], dir: '', postAction: {} },
  { id: 'archive', name: '壓縮檔', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'tgz'], dir: '', postAction: {} },
  { id: 'document', name: '文件', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'mobi', 'csv', 'rtf', 'odt'], dir: '', postAction: {} },
  { id: 'program', name: '程式', extensions: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appx', 'bat', 'sh'], dir: '', postAction: {} },
  { id: 'image', name: '圖片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'avif', 'heic'], dir: '', postAction: {} },
  { id: 'torrent', name: '種子', extensions: ['torrent', 'magnet'], dir: '', postAction: {} },
  { id: 'other', name: '其他', extensions: [], dir: '', postAction: {} }
]

export interface AddDownloadInput {
  /** One entry per logical download. Multiple URIs in a single entry become mirrors. */
  uris: string[]
  /** Optional filename for the resulting file (aria2 --out). */
  out: string
  dir: string
  split: number
  maxConnectionPerServer: number
  minSplitSize: number
  maxDownloadLimit: number
  referer: string
  userAgent: string
  cookieHeader: string
  headers: string[]
  username: string
  password: string
  proxy: string
  /** Queue rather than start immediately. */
  paused: boolean
  /** BitTorrent only. */
  seedRatio: number
  seedTime: number
  /** Only download these file indices out of a torrent or metalink. */
  selectFileIndices: number[]
  category: string
  tags: string[]
  source: AddSource
  /** True when the payload is a .torrent body rather than a URI list. */
  torrentBase64: string | null
  /** True when the payload is a .metalink body rather than a URI list. */
  metalinkBase64: string | null
  /** Skip the "already in the list" check. */
  allowDuplicate: boolean
  /** Force this item through a specific engine. */
  engine: 'auto' | 'aria2' | 'ytdlp'
}

export interface AddDownloadResult {
  gids: string[]
  duplicates: { uri: string; existingGid: string; name: string }[]
  warnings: string[]
}

export interface ItemOptionPatch {
  maxDownloadLimit?: number
  split?: number
  maxConnectionPerServer?: number
  referer?: string
  userAgent?: string
  out?: string
  dir?: string
}

export interface MediaFormatInfo {
  formatId: string
  label: string
  ext: string
  resolution: string
  filesize: number | null
  vcodec: string
  acodec: string
  note: string
  /** True for the merged audio+video entry, which needs ffmpeg. */
  needsFfmpeg: boolean
}

export interface AddMediaInput {
  url: string
  formatId: string
  dir: string
  audioOnly: boolean
  /** True when the user asked for a playlist and we should expand it. */
  playlist: boolean
  maxConcurrent: number
}

export interface AppPaths {
  userData: string
  downloads: string
  logs: string
  bin: string
  session: string
  aria2Log: string
  history: string
  settings: string
  extensions: string
  /** Where the updater records what it did, next to the settings file. */
  updateLog: string
  /**
   * The main process's own log.
   *
   * A packaged build prints nothing, so without this there is no record of why
   * the engine, the browser handoff or a shutdown step misbehaved.
   */
  appLog: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends undefined
    ? T[K]
    : T[K] extends (infer U)[]
      ? U[]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K]
}
