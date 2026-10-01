import type {
  AppPaths,
  AddDownloadInput,
  AddDownloadResult,
  AddMediaInput,
  DeepPartial,
  ItemOptionPatch,
  MediaFormatInfo,
  Settings,
  ScheduleRule,
  CategoryRule,
  SpeedProfile
} from './settings'
import type { Locale } from './i18n'
import type {
  ClipboardDetected,
  DownloadFileEntry,
  DownloadItem,
  EngineStatus,
  GlobalStat,
  HistoryPage,
  HistoryQuery,
  PeerInfo,
  PieceMap,
  ServerInfo,
  TickPayload,
  ToastPayload,
  ToolkitStatus
} from './download'

/** Every IPC channel name, in one place so main and preload cannot drift. */
export const IPC = {
  engineGetStatus: 'engine:getStatus',
  engineRestart: 'engine:restart',
  engineGetVersion: 'engine:getVersion',
  engineGetGlobalStat: 'engine:getGlobalStat',
  engineGetLogTail: 'engine:getLogTail',
  engineOpenLog: 'engine:openLog',
  engineSetGlobalLimits: 'engine:setGlobalLimits',

  downloadsList: 'downloads:list',
  downloadsAdd: 'downloads:add',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsRemove: 'downloads:remove',
  downloadsMove: 'downloads:move',
  downloadsChangeOptions: 'downloads:changeOptions',
  downloadsRetry: 'downloads:retry',
  downloadsOpenFile: 'downloads:openFile',
  downloadsShowInFolder: 'downloads:showInFolder',
  downloadsCopyLink: 'downloads:copyLink',
  downloadsGetFiles: 'downloads:getFiles',
  downloadsGetServers: 'downloads:getServers',
  downloadsGetPeers: 'downloads:getPeers',
  downloadsGetPieces: 'downloads:getPieces',
  downloadsGetOptions: 'downloads:getOptions',
  downloadsClearCompleted: 'downloads:clearCompleted',
  downloadsPauseAll: 'downloads:pauseAll',
  downloadsResumeAll: 'downloads:resumeAll',
  downloadsRevealTorrent: 'downloads:revealTorrent',
  downloadsParseUriList: 'downloads:parseUriList',
  downloadsRunPostAction: 'downloads:runPostAction',

  historyQuery: 'history:query',
  historyDelete: 'history:delete',
  historyClear: 'history:clear',

  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsSaveProfile: 'settings:saveProfile',
  settingsDeleteProfile: 'settings:deleteProfile',
  settingsSaveSchedule: 'settings:saveSchedule',
  settingsDeleteSchedule: 'settings:deleteSchedule',
  settingsSaveCategory: 'settings:saveCategory',
  settingsDeleteCategory: 'settings:deleteCategory',
  settingsApplyProfile: 'settings:applyProfile',
  settingsGetPaths: 'settings:getPaths',
  settingsChooseDirectory: 'settings:chooseDirectory',

  integrationsSetClipboardWatch: 'integrations:setClipboardWatch',
  integrationsGetHandoffInfo: 'integrations:getHandoffInfo',
  integrationsRotateHandoffToken: 'integrations:rotateToken',
  integrationsGetMediaFormats: 'integrations:getMediaFormats',
  integrationsAddMedia: 'integrations:addMedia',
  integrationsCheckToolkits: 'integrations:checkToolkits',
  integrationsDownloadToolkit: 'integrations:downloadToolkit',
  integrationsOpenExtensionFolder: 'integrations:openExtensionFolder',
  integrationsSystemPower: 'integrations:systemPower',
  integrationsDismissDetected: 'integrations:dismissDetected',

  appOpenExternal: 'app:openExternal',
  updateCheck: 'update:check',

  catcherGet: 'catcher:get',
  catcherResolve: 'catcher:resolve',

  // main -> renderer
  eventTick: 'event:tick',
  eventEngineStatus: 'event:engineStatus',
  eventClipboardDetected: 'event:clipboardDetected',
  eventToast: 'event:toast',
  eventNavigate: 'event:navigate',
  eventCatcher: 'event:catcherUpdate'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * Loopback ports a browser extension asks to learn the real handoff endpoint.
 *
 * The list has to be fixed — that is the whole point, since the handoff port
 * itself is user-configurable and an extension could not otherwise find it. A
 * *list* rather than one port because the obvious single choice, 7070, is also
 * AnyDesk's default direct-connection port, and it is commonly taken by other
 * local tooling. When that happened the rendezvous listener silently failed,
 * the extension retried forever, and auto-pairing looked permanently broken.
 *
 * Order matters: the app binds the first free entry, and the extension probes
 * them in the same order, so the common case still costs one request.
 *
 * The extension is built separately and keeps its own copy of this list in
 * `resources/extension/src/pairing.js`.
 */
export const HANDOFF_DISCOVERY_PORTS = [7070, 7071, 7072, 7073, 7074] as const

/** The preferred rendezvous port. */
export const HANDOFF_DISCOVERY_PORT = HANDOFF_DISCOVERY_PORTS[0]

export type SystemPowerAction = 'shutdown' | 'sleep' | 'hibernate' | 'exit' | 'cancel'

/**
 * What the IDM-style catch popup can do with the downloads it is showing.
 *
 * `later` is also what closing the window means: the capture was already added
 * paused, so the only way to lose it is to say so explicitly with `cancel`.
 */
export type CatcherAction = 'start' | 'later' | 'cancel'

/** Everything the catch popup window needs to render itself. */
export interface CatcherInfo {
  /** Downloads this capture produced. All of them are resolved together. */
  gids: string[]
  /** Best available name: the extension's filename, else the URL's last segment. */
  title: string
  /** Host of the first URL, or empty when it cannot be derived. */
  host: string
  /** How many downloads the capture will create. */
  count: number
  /**
   * Resolved language and appearance, so the popup matches the main window
   * instead of falling back to this module's defaults.
   */
  locale: Locale
  theme: 'dark' | 'light' | 'system'
  accent: string
}

/**
 * The repository the in-app updater asks for new releases.
 *
 * Kept here rather than in the main process so the renderer can name the project
 * in error messages without a second copy drifting out of date.
 */
export const UPDATE_REPO = 'alex200376/AriaDM'

/** Result of a release check. Never throws: a failed check is reported in `error`. */
export interface UpdateInfo {
  /** The running app version, echoed back for the UI. */
  current: string
  /** Newest published version, or null when nothing could be read. */
  latest: string | null
  /** True when `latest` is strictly newer than `current`. */
  available: boolean
  /** Release page, for the manual "open in browser" fallback. */
  releaseUrl: string | null
  /** Direct installer asset, when the release carries one. */
  downloadUrl: string | null
  /** Non-empty only when the check itself could not run. */
  error: string
}

export interface HandoffInfo {
  enabled: boolean
  port: number
  token: string
  url: string
  running: boolean
  lastError: string
  /**
   * Port the extension discovers AriaDM on, or 0 when the auto-pairing
   * listener is not up (every candidate port was taken).
   */
  discoveryPort: number
  /** Every port the extension knows to probe, so the UI can explain a failure. */
  discoveryPorts: number[]
}

export interface NavigationPayload {
  view: 'all' | 'active' | 'waiting' | 'paused' | 'complete' | 'error' | 'history' | 'settings'
  gid?: string
}

export interface UriListClassification {
  /** Groups of URIs sharing a filename, so they are mirrors of one download. */
  mirrors: string[][]
  singles: string[]
}

export interface AddMediaResult {
  gids: string[]
}

/**
 * The complete surface exposed on `window.api`.
 * Deliberately narrow: the renderer can never reach Node, the filesystem, or the
 * aria2 RPC secret directly.
 */
export interface AriaDmApi {
  platform: 'win32' | 'darwin' | 'linux'
  version: string

  engine: {
    getStatus(): Promise<EngineStatus>
    restart(): Promise<EngineStatus>
    getVersion(): Promise<string>
    getGlobalStat(): Promise<GlobalStat>
    getLogTail(lines?: number): Promise<string>
    openLog(): Promise<void>
    setGlobalLimits(limits: { download?: number; upload?: number; concurrency?: number }): Promise<GlobalStat>
  }

  downloads: {
    list(): Promise<DownloadItem[]>
    add(input: AddDownloadInput): Promise<AddDownloadResult>
    pause(gids: string[]): Promise<void>
    resume(gids: string[]): Promise<void>
    remove(gids: string[], deleteFiles: boolean): Promise<void>
    move(gid: string, position: number): Promise<void>
    changeOptions(gid: string, patch: ItemOptionPatch): Promise<void>
    retry(gids: string[]): Promise<AddDownloadResult>
    openFile(gid: string): Promise<void>
    showInFolder(gid: string): Promise<void>
    copyLink(gid: string): Promise<void>
    getFiles(gid: string): Promise<DownloadFileEntry[]>
    getServers(gid: string): Promise<ServerInfo[]>
    getPeers(gid: string): Promise<PeerInfo[]>
    getPieces(gid: string): Promise<PieceMap | null>
    getOptions(gid: string): Promise<Record<string, string>>
    clearCompleted(): Promise<void>
    pauseAll(): Promise<void>
    resumeAll(): Promise<void>
    parseUriList(text: string): Promise<UriListClassification>
    runPostAction(gid: string): Promise<void>
  }

  history: {
    query(query: HistoryQuery): Promise<HistoryPage>
    delete(ids: string[]): Promise<void>
    clear(): Promise<void>
  }

  settings: {
    get(): Promise<Settings>
    patch(patch: DeepPartial<Settings>): Promise<Settings>
    saveProfile(profile: SpeedProfile): Promise<Settings>
    deleteProfile(id: string): Promise<Settings>
    saveSchedule(rule: ScheduleRule): Promise<Settings>
    deleteSchedule(id: string): Promise<Settings>
    saveCategory(rule: CategoryRule): Promise<Settings>
    deleteCategory(id: string): Promise<Settings>
    applyProfile(id: string): Promise<Settings>
    getPaths(): Promise<AppPaths>
    chooseDirectory(defaultPath?: string): Promise<string | null>
  }

  integrations: {
    setClipboardWatch(enabled: boolean): Promise<void>
    getHandoffInfo(): Promise<HandoffInfo>
    rotateHandoffToken(): Promise<HandoffInfo>
    getMediaFormats(url: string): Promise<MediaFormatInfo[]>
    addMedia(input: AddMediaInput): Promise<AddMediaResult>
    checkToolkits(): Promise<ToolkitStatus>
    downloadToolkit(kind: 'aria2' | 'ytdlp' | 'ffmpeg'): Promise<ToolkitStatus>
    openExtensionFolder(): Promise<void>
    systemPower(action: SystemPowerAction): Promise<void>
    dismissDetected(): Promise<void>
  }

  app: {
    openExternal(url: string): Promise<void>
  }

  update: {
    /** Ask GitHub Releases for the newest published version. */
    check(): Promise<UpdateInfo>
  }

  /** Only meaningful inside the catch popup window. */
  catcher: {
    /** The capture this window was opened for, or null once it is resolved. */
    get(): Promise<CatcherInfo | null>
    resolve(action: CatcherAction): Promise<void>
  }

  on: {
    tick(handler: (payload: TickPayload) => void): () => void
    engineStatus(handler: (status: EngineStatus) => void): () => void
    clipboardDetected(handler: (payload: ClipboardDetected) => void): () => void
    toast(handler: (payload: ToastPayload) => void): () => void
    navigate(handler: (payload: NavigationPayload) => void): () => void
    /** Fired when a second capture arrives while the popup is already open. */
    catcherUpdate(handler: (info: CatcherInfo) => void): () => void
  }
}

declare global {
  interface Window {
    api: AriaDmApi
  }
}
