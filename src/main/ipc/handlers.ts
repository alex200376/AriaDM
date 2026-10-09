import fs from 'node:fs'

import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from 'electron'

import type { AppPaths, CategoryRule, DeepPartial, ScheduleRule, Settings, SpeedProfile } from '@shared/settings'
import type { DownloadItem, GlobalStat } from '@shared/download'
import {
  HANDOFF_DISCOVERY_PORTS,
  IPC,
  type CatcherAction,
  type HandoffInfo,
  type MediaDetectResult,
  type SystemPowerAction,
  type UriListClassification
} from '@shared/ipc'
import { t } from '@shared/i18n'
import { classifyMediaError, type MediaErrorKind } from '@shared/media-errors'
import { matchMediaSite, needsPageSniff } from '@shared/media-sites'
import { classifyUriList, isSupportedUri } from '@shared/uri'

import type { Aria2Supervisor } from '../aria2/supervisor'
import type { DownloadCatcher } from '../catcher'
import type { EngineRouter } from '../downloads/engine-router'
import type { DownloadManager } from '../downloads/manager'
import type { HistoryStore } from '../downloads/history-store'
import type { HandoffServer } from '../integrations/handoff-api'
import type { ClipboardWatcher } from '../integrations/clipboard-watch'
import { isMediaGid, type MediaJobs } from '../media/jobs'
import type { MediaSniffer } from '../media/page-sniff'
import { extensionFolderFor } from '../integrations/extension-folder'
import { IMAGE_EXTENSIONS, readImageDataUrl } from '../settings/background-image'
import type { SettingsStore } from '../settings/store'
import type { ToolkitManager } from '../toolkit'
import type { UpdateManager } from '../update/update-manager'

export interface HandlerContext {
  getWindow(): BrowserWindow | null
  settingsStore: SettingsStore
  history: HistoryStore
  manager: DownloadManager
  supervisor: Aria2Supervisor
  toolkit: ToolkitManager
  mediaJobs: MediaJobs
  engineRouter: EngineRouter
  /** Reads a page's content to decide whether an unknown host holds a video. */
  sniffer: MediaSniffer
  getHandoff(): HandoffServer | null
  /** The auto-pairing listener an extension discovers AriaDM through. */
  getRendezvous(): HandoffServer | null
  /**
   * State of the main endpoint's bind-retry.
   *
   * `lastError` outlives the failed server object, so Settings can still explain
   * a stopped listener instead of showing a bare "not running".
   */
  getHandoffRetry(): { retrying: boolean; lastError: string }
  getClipboard(): ClipboardWatcher | null
  /**
   * A live session the browser extension offered for this URL's host, or ''.
   *
   * The paste path has no capture to carry a session along, so it borrows one the
   * extension saw recently (see media/cookie-vault).
   */
  getExtensionCookies(url: string): string
  /** Tell the extension that this host needs a session, so it can be asked. */
  noteCookieNeed(url: string): void
  /** The IDM-style popup an intercepted browser download lands in. */
  catcher: DownloadCatcher
  /** In-app update: release check, download, and silent install. */
  update: UpdateManager
  paths: AppPaths
  extensionDir: string
  applyProfile(id: string): Promise<Settings>
  restartEngine(): Promise<void>
  /** Persist and apply a settings patch, running any side effects. */
  updateSettings(patch: DeepPartial<Settings>): Promise<Settings>
  requestSystemPower(action: SystemPowerAction): Promise<void>
  runPostActionFor(item: DownloadItem): Promise<void>
  log(line: string): void
}

/** Failures a browser session would plausibly fix. */
const COOKIE_ERROR_KINDS = new Set<MediaErrorKind>([
  'cookies-missing',
  'cookies-locked',
  'cookies-undecryptable',
  'bot-check',
  'auth'
])

/**
 * Probe a media URL with whatever session the extension offered, and record that
 * the host needs one when the failure is a login problem.
 *
 * The recording is what makes the fix discoverable: the extension asks AriaDM
 * whether anything is waiting (see `/cookie-request`), and without a note here
 * nothing ever told it to.
 */
async function withExtensionCookies<T>(
  context: HandlerContext,
  url: string,
  run: (cookieHeader: string) => Promise<T>
): Promise<T> {
  const cookieHeader = context.getExtensionCookies(url)
  try {
    return await run(cookieHeader)
  } catch (error) {
    const kind = classifyMediaError((error as Error).message).kind
    if (COOKIE_ERROR_KINDS.has(kind)) context.noteCookieNeed(url)
    throw error
  }
}

/** Split a gid list into aria2-owned and yt-dlp-owned subsets. */
function partitionGids(gids: string[]): { aria2: string[]; media: string[] } {
  const aria2: string[] = []
  const media: string[] = []
  for (const gid of gids) {
    if (isMediaGid(gid)) media.push(gid)
    else aria2.push(gid)
  }
  return { aria2, media }
}

function targetFor(item: DownloadItem): string | null {
  const first = item.files.find((file) => file.path.length > 0)
  if (first) return item.files.length > 1 ? item.dir : first.path
  return item.dir || null
}

export function registerIpcHandlers(context: HandlerContext): void {
  const { manager, supervisor, settingsStore, history, toolkit, mediaJobs } = context

  // One builder for both handoff handlers: they used to repeat this object field
  // for field, which is exactly how a new field ends up on only one of them.
  const handoffInfo = (token?: string): HandoffInfo => {
    const handoff = context.getHandoff()
    const settings = settingsStore.get()
    const retry = context.getHandoffRetry()
    const port = handoff?.listeningPort || settings.handoffPort
    return {
      enabled: settings.handoffEnabled,
      port,
      token: token ?? handoff?.token ?? settings.handoffToken,
      url: `http://127.0.0.1:${port}/add`,
      running: handoff !== null && handoff.listeningPort > 0,
      retrying: retry.retrying,
      // The live server's error is the freshest; the retained one survives the
      // server being discarded after a failed bind.
      lastError: handoff?.error ?? retry.lastError,
      discoveryPort: context.getRendezvous()?.listeningPort ?? 0,
      discoveryPorts: [...HANDOFF_DISCOVERY_PORTS]
    }
  }

  const allItems = (): DownloadItem[] => [...manager.getItems(), ...mediaJobs.items()]

  const findItem = (gid: string): DownloadItem | undefined =>
    mediaJobs.get(gid) ?? manager.getItem(gid)

  // ---- engine --------------------------------------------------------------

  ipcMain.handle(IPC.engineGetStatus, () => supervisor.getStatus())
  ipcMain.handle(IPC.engineGetVersion, async () => {
    try {
      const version = await supervisor.rpc.getVersion()
      return version.version
    } catch {
      return ''
    }
  })
  ipcMain.handle(IPC.engineGetGlobalStat, () => manager.getGlobalStat())
  ipcMain.handle(IPC.engineGetLogTail, (_event, lines?: number) => {
    const tail = supervisor.logTail.split('\n')
    return tail.slice(-(lines ?? 120)).join('\n')
  })
  ipcMain.handle(IPC.engineOpenLog, async () => {
    await shell.openPath(context.paths.aria2Log)
  })
  ipcMain.handle(IPC.engineRestart, async () => {
    await context.restartEngine()
    return supervisor.getStatus()
  })
  ipcMain.handle(
    IPC.engineSetGlobalLimits,
    async (_event, limits: { download?: number; upload?: number; concurrency?: number }): Promise<GlobalStat> => {
      const patch: DeepPartial<Settings> = {}
      if (limits.download !== undefined) patch.globalDownloadLimit = Math.max(0, Math.floor(limits.download))
      if (limits.upload !== undefined) patch.globalUploadLimit = Math.max(0, Math.floor(limits.upload))
      if (limits.concurrency !== undefined) {
        patch.maxConcurrentDownloads = Math.max(1, Math.floor(limits.concurrency))
      }
      const settings = await context.updateSettings(patch)
      // Limits apply live through changeGlobalOption; no restart needed.
      await supervisor.applyLiveSettings(settings)
      return manager.getGlobalStat()
    }
  )

  // ---- downloads -----------------------------------------------------------

  ipcMain.handle(IPC.downloadsList, () => allItems())

  ipcMain.handle(IPC.downloadsAdd, async (_event, input) => {
    // Routed rather than sent straight to aria2: this is the path every link the
    // user pastes into the app takes, and some of those are media pages.
    return context.engineRouter.add(input)
  })

  ipcMain.handle(IPC.downloadsPause, async (_event, gids: string[]) => {
    const { aria2, media } = partitionGids(gids)
    if (aria2.length > 0) await manager.pause(aria2)
    for (const gid of media) await mediaJobs.pause(gid)
  })

  ipcMain.handle(IPC.downloadsResume, async (_event, gids: string[]) => {
    const { aria2, media } = partitionGids(gids)
    if (aria2.length > 0) await manager.resume(aria2)
    for (const gid of media) await mediaJobs.resume(gid)
  })

  ipcMain.handle(IPC.downloadsRemove, async (_event, gids: string[], deleteFiles: boolean) => {
    const { aria2, media } = partitionGids(gids)
    for (const gid of media) await mediaJobs.remove(gid, deleteFiles)
    if (aria2.length > 0) await manager.remove(aria2, deleteFiles)
  })

  ipcMain.handle(IPC.downloadsMove, async (_event, gid: string, position: number) => {
    await manager.move(gid, position)
  })

  ipcMain.handle(IPC.downloadsChangeOptions, async (_event, gid: string, patch) => {
    // The media engine exposes none of these knobs, so refusing loudly beats
    // silently accepting a change that will never take effect.
    if (isMediaGid(gid)) throw new Error(t('main.item.optionsUnsupported'))
    await manager.changeOptions(gid, patch)
  })

  ipcMain.handle(IPC.downloadsRetry, async (_event, gids: string[]) => {
    const { aria2, media } = partitionGids(gids)
    for (const gid of media) await mediaJobs.retry(gid)
    const result = aria2.length > 0
      ? await manager.retry(aria2)
      : { gids: [], duplicates: [], warnings: [] }
    return result
  })

  ipcMain.handle(IPC.downloadsOpenFile, async (_event, gid: string) => {
    const item = findItem(gid)
    const target = item ? targetFor(item) : null
    if (!target) throw new Error(t('main.item.noFile'))
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.downloadsShowInFolder, async (_event, gid: string) => {
    const item = findItem(gid)
    const target = item ? targetFor(item) : null
    if (!target) throw new Error(t('main.item.noFile'))
    shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.downloadsCopyLink, async (_event, gid: string) => {
    const item = findItem(gid)
    const uri = item?.files[0]?.uris?.[0]?.uri ?? history.get(gid)?.uris[0]
    if (!uri) throw new Error(t('main.item.noUri'))
    clipboard.writeText(uri)
    // Tell the clipboard watcher this text is ours, so enabling the feature does
    // not immediately re-offer a link the user just copied from the app.
    context.getClipboard()?.markOwnCopy(uri)
    void item
  })

  ipcMain.handle(IPC.downloadsGetFiles, async (_event, gid: string) => {
    if (isMediaGid(gid)) return mediaJobs.get(gid)?.files ?? []
    return manager.getFiles(gid)
  })

  ipcMain.handle(IPC.downloadsGetServers, async (_event, gid: string) => {
    if (isMediaGid(gid)) return []
    return manager.getServers(gid)
  })

  ipcMain.handle(IPC.downloadsGetPieces, async (_event, gid: string) => {
    if (isMediaGid(gid)) return null
    return manager.getPieces(gid)
  })

  ipcMain.handle(IPC.downloadsGetPeers, async (_event, gid: string) => {
    if (isMediaGid(gid)) return []
    return manager.getPeers(gid)
  })

  ipcMain.handle(IPC.downloadsGetOptions, async (_event, gid: string) => {
    if (isMediaGid(gid)) return {}
    return manager.getOptions(gid)
  })

  ipcMain.handle(IPC.downloadsClearCompleted, async () => {
    await manager.clearCompleted()
  })

  ipcMain.handle(IPC.downloadsPauseAll, async () => {
    await manager.pauseAll()
    for (const item of mediaJobs.items()) {
      if (item.status === 'active') await mediaJobs.pause(item.gid)
    }
  })

  ipcMain.handle(IPC.downloadsResumeAll, async () => {
    await manager.resumeAll()
    for (const item of mediaJobs.items()) {
      if (item.status === 'paused') await mediaJobs.resume(item.gid)
    }
  })

  ipcMain.handle(IPC.downloadsParseUriList, (_event, text: string): UriListClassification => {
    const uris = text
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    return classifyUriList(uris.filter(isSupportedUri))
  })

  ipcMain.handle(IPC.downloadsRunPostAction, async (_event, gid: string) => {
    const item = findItem(gid)
    if (!item) throw new Error(t('main.item.notFound'))
    await context.runPostActionFor(item)
  })

  // ---- history -------------------------------------------------------------

  ipcMain.handle(IPC.historyQuery, (_event, query) => manager.queryHistory(query))
  ipcMain.handle(IPC.historyDelete, (_event, gids: string[]) => manager.deleteHistory(gids))
  ipcMain.handle(IPC.historyClear, () => manager.clearHistory())

  // ---- settings ------------------------------------------------------------

  ipcMain.handle(IPC.settingsGet, () => settingsStore.get())
  ipcMain.handle(IPC.settingsPatch, (_event, patch: DeepPartial<Settings>) => context.updateSettings(patch))

  ipcMain.handle(IPC.settingsSaveProfile, (_event, profile: SpeedProfile) => settingsStore.saveProfile(profile))
  ipcMain.handle(IPC.settingsDeleteProfile, (_event, id: string) => settingsStore.deleteProfile(id))
  ipcMain.handle(IPC.settingsSaveSchedule, (_event, rule: ScheduleRule) => settingsStore.saveSchedule(rule))
  ipcMain.handle(IPC.settingsDeleteSchedule, (_event, id: string) => settingsStore.deleteSchedule(id))
  ipcMain.handle(IPC.settingsSaveCategory, (_event, rule: CategoryRule) => settingsStore.saveCategory(rule))
  ipcMain.handle(IPC.settingsDeleteCategory, (_event, id: string) => settingsStore.deleteCategory(id))

  ipcMain.handle(IPC.settingsApplyProfile, async (_event, id: string) => context.applyProfile(id))
  ipcMain.handle(IPC.settingsGetPaths, () => context.paths)

  ipcMain.handle(IPC.settingsChooseDirectory, async (_event, defaultPath?: string) => {
    const window = context.getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, {
          defaultPath,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ defaultPath, properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })

  ipcMain.handle(IPC.settingsChooseImage, async (_event, defaultPath?: string) => {
    const window = context.getWindow()
    const options: Electron.OpenDialogOptions = {
      defaultPath,
      properties: ['openFile'],
      filters: [{ name: t('main.dialog.images'), extensions: IMAGE_EXTENSIONS }]
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })

  // Reading is on demand rather than pushed with every settings patch: the image
  // is only needed when it changes, and the reader remembers the last one.
  ipcMain.handle(IPC.settingsReadImage, (_event, file: string) => readImageDataUrl(file))

  // ---- integrations --------------------------------------------------------

  ipcMain.handle(IPC.integrationsSetClipboardWatch, async (_event, enabled: boolean) => {
    await context.updateSettings({ clipboardWatch: enabled })
  })

  ipcMain.handle(IPC.integrationsGetHandoffInfo, (): HandoffInfo => handoffInfo())

  ipcMain.handle(IPC.integrationsRotateHandoffToken, async (): Promise<HandoffInfo> => {
    const handoff = context.getHandoff()
    const token = handoff ? handoff.rotateToken() : settingsStore.get().handoffToken
    await context.updateSettings({ handoffToken: token })
    return handoffInfo(token)
  })

  ipcMain.handle(
    IPC.integrationsGetMediaFormats,
    async (_event, url: string, refreshCredentials?: boolean) => {
      if (!settingsStore.get().ytdlpEnabled) throw new Error(t('main.media.disabled'))
      return withExtensionCookies(context, url, async (cookieHeader) => {
        // Building the menu is the caller asking what this link contains *now* —
        // including when it is the dialog's "probe again" button. The answer a
        // previous probe gave is still reused by the download that follows, which
        // is where the second run used to be spent.
        //
        // `refreshCredentials` is only set by an explicit retry after a fix, and
        // is what lets it try the credentials again even though a failure was
        // already recorded against this host.
        const probe = await mediaJobs.probe(
          url,
          { cookieHeader },
          refreshCredentials ? { reuse: false, ignoreHostVerdict: true } : { reuse: false }
        )
        // One probe, three answers: the quality menu, the subtitle languages and
        // whether the link is a playlist. The picker needs all of them together.
        return { formats: probe.formats, subtitles: probe.subtitles, isPlaylist: probe.isPlaylist }
      })
    }
  )

  ipcMain.handle(IPC.integrationsDetectMedia, async (_event, url: string): Promise<MediaDetectResult> => {
    const settings = settingsStore.get()
    // The curated list is authoritative and free; only a host we do not know is
    // worth reading the page for.
    const site = matchMediaSite(url)
    if (site !== null) return { media: true, site, mediaUrls: [] }

    // This is the dialog's "is this a video?" question, not the engine's
    // autonomous decision, so 自動辨識 does not gate it: the dialog shows the
    // media panel for known sites regardless, and must be able to offer to
    // install yt-dlp for an unknown host the same way.
    if (!settings.ytdlpEnabled) return { media: false, site: null, mediaUrls: [] }
    if (!needsPageSniff(url)) return { media: false, site: null, mediaUrls: [] }

    const scan = await context.sniffer.scan(url, {
      cookieHeader: context.getExtensionCookies(url),
      referer: url
    })
    // A page that only links a `.mp4` still counts: the file is downloadable on
    // its own, and that is what the caller does with `mediaUrls`.
    return {
      media: scan.verdict === 'media' || scan.mediaUrls.length > 0,
      site: null,
      mediaUrls: scan.mediaUrls
    }
  })

  ipcMain.handle(IPC.integrationsGetMediaPlaylist, async (_event, url: string) => {
    if (!settingsStore.get().ytdlpEnabled) throw new Error(t('main.media.disabled'))
    return withExtensionCookies(context, url, (cookieHeader) =>
      mediaJobs.probePlaylist(url, { cookieHeader })
    )
  })

  ipcMain.handle(IPC.integrationsAddMedia, async (_event, input) => {
    const probe = await withExtensionCookies(context, input.url, (cookieHeader) =>
      mediaJobs.probe(input.url, { cookieHeader })
    )
    // The session travels with the job, so a resume sends the same credentials as
    // the first attempt did.
    const { gid } = await mediaJobs.add(input, probe, {
      cookieHeader: context.getExtensionCookies(input.url)
    })
    return { gids: [gid] }
  })

  ipcMain.handle(IPC.integrationsCheckToolkits, () => toolkit.status())

  ipcMain.handle(IPC.integrationsDownloadToolkit, async (_event, kind: 'aria2' | 'ytdlp' | 'ffmpeg') => {
    const status = await toolkit.download(kind)
    if (kind === 'aria2') {
      // A freshly installed aria2 needs the engine pointed at it.
      await context.updateSettings({ aria2Path: status.aria2.path })
      await context.restartEngine()
    }
    return toolkit.status()
  })

  ipcMain.handle(IPC.integrationsOpenExtensionFolder, async (_event, browser?: 'chrome' | 'firefox') => {
    const error = await shell.openPath(extensionFolderFor(context.extensionDir, browser))
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.integrationsSystemPower, async (_event, action: SystemPowerAction) => {
    await context.requestSystemPower(action)
  })

  ipcMain.handle(IPC.integrationsDismissDetected, () => {
    context.getClipboard()?.markOwnCopy(clipboard.readText())
  })

  // ---- app ------------------------------------------------------------------

  ipcMain.handle(IPC.appOpenExternal, async (_event, url: string) => {
    // Only ever hand http(s) to the shell; anything else could be a local
    // handler or a file URL the UI did not intend to launch.
    if (!/^https?:\/\//i.test(url)) throw new Error(t('main.open.httpOnly'))
    await shell.openExternal(url)
  })

  /**
   * The caption buttons the app draws itself.
   *
   * Each one acts on the window the request came from rather than on a captured
   * reference, so the same handlers serve every window the app may open.
   */
  const senderWindow = (event: IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender)

  ipcMain.handle(IPC.windowMinimise, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximise, (event) => {
    const window = senderWindow(event)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.handle(IPC.windowClose, (event) => {
    // `close` rather than `destroy`: the close handler decides between hiding to
    // the tray and quitting, which is exactly what the native button did.
    senderWindow(event)?.close()
  })

  ipcMain.handle(IPC.windowIsMaximised, (event) => senderWindow(event)?.isMaximized() ?? false)

  ipcMain.handle(IPC.appReveal, async (_event, target: string) => {
    if (typeof target !== 'string' || !target) throw new Error(t('main.open.pathMissing'))
    if (!fs.existsSync(target)) throw new Error(t('main.open.pathNotExist'))
    // A folder is opened; a file is shown *selected* in its folder, which is what
    // "show me this log file" should do.
    if (fs.statSync(target).isDirectory()) {
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
      return
    }
    shell.showItemInFolder(target)
  })

  // ---- updates ---------------------------------------------------------------

  ipcMain.handle(IPC.updateCheck, () => context.update.check())
  ipcMain.handle(IPC.updateDownload, () => context.update.download())
  ipcMain.handle(IPC.updateCancel, () => context.update.cancel())

  // Rejects when the installer could not be confirmed running, in which case the
  // app is deliberately still open so the user can run it by hand.
  ipcMain.handle(IPC.updateInstall, () => context.update.install())

  // The manual escape hatch: run a verified installer with its normal window.
  ipcMain.handle(IPC.updateOpenInstaller, async (_event, file: string) => {
    if (typeof file !== 'string' || !/\.exe$/i.test(file)) {
      throw new Error(t('main.update.installerOnly'))
    }
    if (!fs.existsSync(file)) throw new Error(t('main.update.installerGone'))
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.updateDiagnostics, () => context.update.diagnostics())
  ipcMain.handle(IPC.updateRepair, () => context.update.repairCache())

  // ---- catch popup -----------------------------------------------------------

  // Reading is harmless: a caller with no popup open simply gets null.
  ipcMain.handle(IPC.catcherGet, () => context.catcher.pending)

  ipcMain.handle(IPC.catcherResolve, (_event, action: CatcherAction) => {
    if (action !== 'start' && action !== 'later' && action !== 'cancel') {
      throw new Error('invalid catcher action')
    }
    context.catcher.resolve(action)
  })
}
