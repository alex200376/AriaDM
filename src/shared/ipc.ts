import type {
  AppPaths,
  AddDownloadInput,
  AddDownloadResult,
  AddMediaInput,
  DeepPartial,
  ItemOptionPatch,
  MediaInfo,
  MediaPlaylistInfo,
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
  integrationsDetectMedia: 'integrations:detectMedia',
  integrationsGetMediaPlaylist: 'integrations:getMediaPlaylist',
  integrationsAddMedia: 'integrations:addMedia',
  integrationsCheckToolkits: 'integrations:checkToolkits',
  integrationsDownloadToolkit: 'integrations:downloadToolkit',
  integrationsOpenExtensionFolder: 'integrations:openExtensionFolder',
  integrationsSystemPower: 'integrations:systemPower',
  integrationsDismissDetected: 'integrations:dismissDetected',

  appOpenExternal: 'app:openExternal',
  /** Show a file or folder in the OS file manager. */
  appReveal: 'app:reveal',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateCancel: 'update:cancel',
  /** Run an installer that was already downloaded and verified. */
  updateOpenInstaller: 'update:openInstaller',
  /** Everything needed to file a useful bug report about an update. */
  updateDiagnostics: 'update:diagnostics',
  /** Re-verify the update folder and delete anything that no longer matches. */
  updateRepair: 'update:repair',

  catcherGet: 'catcher:get',
  catcherResolve: 'catcher:resolve',

  // main -> renderer
  eventTick: 'event:tick',
  eventEngineStatus: 'event:engineStatus',
  eventClipboardDetected: 'event:clipboardDetected',
  eventToast: 'event:toast',
  eventNavigate: 'event:navigate',
  eventCatcher: 'event:catcherUpdate',
  eventUpdateProgress: 'event:updateProgress'
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

/**
 * How this copy of AriaDM got onto the machine.
 *
 * It decides whether an update can be installed quietly: a per-machine install
 * lives in Program Files, which needs administrator rights to replace, so the
 * silent installer has to raise a UAC prompt — and if that prompt is declined
 * the installer exits without a word. Knowing the kind up front is what turns
 * that silence into a warning before the user presses anything.
 */
export type UpdateInstallKind = 'machine' | 'user' | 'portable' | 'dev'

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
  /** Size of the installer asset in bytes, or 0 when the release did not say. */
  downloadSize: number
  /**
   * SHA-256 of the installer asset in lowercase hex, or '' when the release did
   * not publish one.
   *
   * GitHub computes this for every uploaded asset and returns it with the
   * release, so it costs nothing to obtain and cannot be spoofed by the transfer
   * itself. It is the only check that catches a download which arrives the right
   * length and the wrong bytes — which is what a storage or antivirus glitch
   * produces, and what has to be caught here: the installer's own integrity check
   * is the last link in the chain, and by then there is no way back.
   */
  downloadSha256: string
  /**
   * True when this build can download and install an update itself.
   *
   * False for the portable build — running the NSIS installer would leave a
   * second, installed copy behind — and for an unpackaged development run, where
   * there is nothing to replace. Those builds keep the manual link.
   */
  canInstall: boolean
  /** How this copy is installed, which decides whether quiet install is possible. */
  installKind: UpdateInstallKind
  /** True when installing the update needs administrator rights (so, a UAC prompt). */
  needsElevation: boolean
  /**
   * A previously downloaded installer that passed verification and is still on
   * disk, so an update that failed can be retried without downloading 197 MB
   * again. Null when there is nothing usable.
   */
  pendingInstaller: string | null
  /** Non-empty only when the check itself could not run. */
  error: string
}

/**
 * What a release check can know by itself.
 *
 * The install-mode fields are filled in by the updater, which is the only place
 * that knows how this copy of the app is installed, so the checker returns the
 * narrower shape.
 */
export type UpdateCheckResult = Omit<UpdateInfo, 'installKind' | 'needsElevation' | 'pendingInstaller'>

/** Facts about this installation, for the About tab and for bug reports. */
export interface UpdateDiagnostics {
  /** Multi-line, already formatted, safe to copy into a report. */
  text: string
  /** Path of the update log, so the UI can offer to open it. */
  logPath: string
}

/** What re-verifying the update folder found and did. */
export interface UpdateRepairResult {
  /** Update files looked at. */
  checked: number
  /** Files deleted because they could not be matched to the release. */
  removed: number
  /** Files left alone because they still matched. */
  kept: number
  /** Bytes reclaimed by the deletions, for the confirmation message. */
  bytesFreed: number
}

/**
 * Live state of an in-app update download.
 *
 * `percent` is -1 when the size is unknown, so the UI can show an indeterminate
 * bar instead of a bar stuck at 0.
 */
export interface UpdateProgress {
  /**
   * `waiting-permission` is the state a per-machine install passes through while
   * Windows shows the UAC prompt; it is distinct from `installing` because the
   * user may have to do something before anything is installed.
   */
  phase: 'idle' | 'downloading' | 'ready' | 'waiting-permission' | 'installing' | 'error'
  /** Bytes written so far. */
  received: number
  /** Total bytes, or 0 when the server did not report a length. */
  total: number
  /** 0-100, or -1 while the total is unknown. */
  percent: number
  /** Non-empty only in the `error` phase. */
  error: string
}

export interface HandoffInfo {
  enabled: boolean
  port: number
  token: string
  url: string
  running: boolean
  /**
   * True when the endpoint failed to bind and a retry is scheduled. The port is
   * most often still held by the previous process mid-update, so this is a
   * transient state rather than a configuration error.
   */
  retrying: boolean
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
 * What the page-sniff says about a pasted link.
 *
 * `site` is the curated host it matched, or null when the answer came from the
 * content itself — the dialog uses it to name a recognised site and to label an
 * unknown one honestly.
 */
export interface MediaDetectResult {
  media: boolean
  site: string | null
  /**
   * Media files found in the page, as absolute URLs.
   *
   * A page that embeds a plain video file is best served by downloading that
   * file directly (the multi-connection engine can split it), rather than by
   * handing the page to yt-dlp and letting it find the same address again.
   */
  mediaUrls: string[]
}

/**
 * The complete surface exposed on `window.api`.
 * Deliberately narrow: the renderer can never reach Node, the filesystem, or the
 * aria2 RPC secret directly.
 */
export interface AriaDmApi {
  platform: 'win32' | 'darwin' | 'linux'
  version: string
  /** Runtime versions, for the About tab and for bug reports. */
  runtime: {
    electron: string
    chromium: string
  }

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
    /**
     * Ask what a link contains, so the quality picker can be filled in.
     *
     * `refreshCredentials` is the dialog's "probe again" after a fix: it makes the
     * probe ignore the credential verdict remembered for that host, so a session
     * the user has since repaired is actually tried again instead of being
     * skipped as a known failure.
     */
    getMediaFormats(url: string, refreshCredentials?: boolean): Promise<MediaInfo>
    /**
     * Decide whether a pasted link is a video page, including on a host the
     * curated list does not know — by reading a little of the page.
     */
    detectMedia(url: string): Promise<MediaDetectResult>
    /** List a playlist's items, so a subset can be chosen before downloading. */
    getMediaPlaylist(url: string): Promise<MediaPlaylistInfo>
    addMedia(input: AddMediaInput): Promise<AddMediaResult>
    checkToolkits(): Promise<ToolkitStatus>
    downloadToolkit(kind: 'aria2' | 'ytdlp' | 'ffmpeg'): Promise<ToolkitStatus>
    openExtensionFolder(): Promise<void>
    systemPower(action: SystemPowerAction): Promise<void>
    dismissDetected(): Promise<void>
  }

  app: {
    openExternal(url: string): Promise<void>
    /** Show a file or folder in Explorer/Finder. */
    reveal(target: string): Promise<void>
  }

  update: {
    /** Ask GitHub Releases for the newest published version. */
    check(): Promise<UpdateInfo>
    /** Download the newest installer into the app's temp folder. */
    download(): Promise<UpdateProgress>
    /**
     * Run the downloaded installer silently and relaunch the app.
     *
     * Rejects when the installer could not be started, in which case the app is
     * deliberately still running and `pendingInstaller` can be offered instead.
     */
    install(): Promise<void>
    /** Abort an in-flight download. */
    cancel(): Promise<void>
    /** Launch a verified installer by hand, with its normal window. */
    openInstaller(file: string): Promise<void>
    /** Version, install kind and the tail of the update log, in one string. */
    diagnostics(): Promise<UpdateDiagnostics>
    /**
     * Re-verify downloaded installers and delete any that no longer match the
     * published release, so a damaged update can be fetched again.
     */
    repair(): Promise<UpdateRepairResult>
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
    /** Progress of an in-app update download. */
    updateProgress(handler: (progress: UpdateProgress) => void): () => void
  }
}

declare global {
  interface Window {
    api: AriaDmApi
  }
}
