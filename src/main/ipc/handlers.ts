import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'

import type { AppPaths, CategoryRule, DeepPartial, ScheduleRule, Settings, SpeedProfile } from '@shared/settings'
import type { DownloadItem, GlobalStat } from '@shared/download'
import {
  HANDOFF_DISCOVERY_PORTS,
  IPC,
  type CatcherAction,
  type HandoffInfo,
  type SystemPowerAction,
  type UriListClassification
} from '@shared/ipc'
import { classifyUriList, isSupportedUri } from '@shared/uri'

import type { Aria2Supervisor } from '../aria2/supervisor'
import type { DownloadCatcher } from '../catcher'
import type { EngineRouter } from '../downloads/engine-router'
import type { DownloadManager } from '../downloads/manager'
import type { HistoryStore } from '../downloads/history-store'
import type { HandoffServer } from '../integrations/handoff-api'
import type { ClipboardWatcher } from '../integrations/clipboard-watch'
import { isMediaGid, type MediaJobs } from '../media/jobs'
import type { SettingsStore } from '../settings/store'
import type { ToolkitManager } from '../toolkit'
import { checkForUpdate } from '../update/update-checker'

export interface HandlerContext {
  getWindow(): BrowserWindow | null
  settingsStore: SettingsStore
  history: HistoryStore
  manager: DownloadManager
  supervisor: Aria2Supervisor
  toolkit: ToolkitManager
  mediaJobs: MediaJobs
  engineRouter: EngineRouter
  getHandoff(): HandoffServer | null
  /** The auto-pairing listener an extension discovers AriaDM through. */
  getRendezvous(): HandoffServer | null
  getClipboard(): ClipboardWatcher | null
  /** The IDM-style popup an intercepted browser download lands in. */
  catcher: DownloadCatcher
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
    if (isMediaGid(gid)) throw new Error('yt-dlp 下載不支援修改這些選項。')
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
    if (!target) throw new Error('找不到檔案路徑。')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC.downloadsShowInFolder, async (_event, gid: string) => {
    const item = findItem(gid)
    const target = item ? targetFor(item) : null
    if (!target) throw new Error('找不到檔案路徑。')
    shell.showItemInFolder(target)
  })

  ipcMain.handle(IPC.downloadsCopyLink, async (_event, gid: string) => {
    const item = findItem(gid)
    const uri = item?.files[0]?.uris?.[0]?.uri ?? history.get(gid)?.uris[0]
    if (!uri) throw new Error('找不到來源連結。')
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
    if (!item) throw new Error('找不到下載項目。')
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

  // ---- integrations --------------------------------------------------------

  ipcMain.handle(IPC.integrationsSetClipboardWatch, async (_event, enabled: boolean) => {
    await context.updateSettings({ clipboardWatch: enabled })
  })

  ipcMain.handle(IPC.integrationsGetHandoffInfo, (): HandoffInfo => {
    const handoff = context.getHandoff()
    const settings = settingsStore.get()
    return {
      enabled: settings.handoffEnabled,
      port: handoff?.listeningPort || settings.handoffPort,
      token: handoff?.token ?? settings.handoffToken,
      url: `http://127.0.0.1:${handoff?.listeningPort || settings.handoffPort}/add`,
      running: handoff !== null && handoff.listeningPort > 0,
      lastError: handoff?.error ?? '',
      discoveryPort: context.getRendezvous()?.listeningPort ?? 0,
      discoveryPorts: [...HANDOFF_DISCOVERY_PORTS]
    }
  })

  ipcMain.handle(IPC.integrationsRotateHandoffToken, async (): Promise<HandoffInfo> => {
    const handoff = context.getHandoff()
    const token = handoff ? handoff.rotateToken() : settingsStore.get().handoffToken
    await context.updateSettings({ handoffToken: token })
    const settings = settingsStore.get()
    return {
      enabled: settings.handoffEnabled,
      port: handoff?.listeningPort || settings.handoffPort,
      token,
      url: `http://127.0.0.1:${handoff?.listeningPort || settings.handoffPort}/add`,
      running: handoff !== null && handoff.listeningPort > 0,
      lastError: handoff?.error ?? '',
      discoveryPort: context.getRendezvous()?.listeningPort ?? 0,
      discoveryPorts: [...HANDOFF_DISCOVERY_PORTS]
    }
  })

  ipcMain.handle(IPC.integrationsGetMediaFormats, async (_event, url: string) => {
    if (!settingsStore.get().ytdlpEnabled) throw new Error('影音下載功能已停用。')
    const probe = await mediaJobs.probe(url)
    return probe.formats
  })

  ipcMain.handle(IPC.integrationsAddMedia, async (_event, input) => {
    const probe = await mediaJobs.probe(input.url)
    const { gid } = await mediaJobs.add(input, probe)
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

  ipcMain.handle(IPC.integrationsOpenExtensionFolder, async () => {
    const error = await shell.openPath(context.extensionDir)
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
    if (!/^https?:\/\//i.test(url)) throw new Error('僅允許開啟 http(s) 連結。')
    await shell.openExternal(url)
  })

  // ---- updates ---------------------------------------------------------------

  ipcMain.handle(IPC.updateCheck, () => checkForUpdate(app.getVersion()))

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
