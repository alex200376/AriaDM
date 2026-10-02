import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type AriaDmApi } from '@shared/ipc'

/** Replaced at build time by `define` in electron.vite.config.ts. */
declare const __APP_VERSION__: string

/**
 * The only bridge between the renderer and the rest of the app.
 *
 * Everything is an explicit, named operation. The renderer never receives an
 * ipcRenderer handle, a filesystem path resolver, or the aria2 RPC secret, so a
 * bug in UI code cannot escalate into arbitrary access.
 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener as never)
  return () => {
    ipcRenderer.removeListener(channel, listener as never)
  }
}

const api: AriaDmApi = {
  platform: process.platform as AriaDmApi['platform'],
  version: __APP_VERSION__ ?? process.env.npm_package_version ?? '0.0.0',
  // Runtime versions, shown on the About tab: a bug report that names the
  // Electron build it happened on is a bug report that can be reproduced.
  runtime: {
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? ''
  },

  engine: {
    getStatus: () => invoke(IPC.engineGetStatus),
    restart: () => invoke(IPC.engineRestart),
    getVersion: () => invoke(IPC.engineGetVersion),
    getGlobalStat: () => invoke(IPC.engineGetGlobalStat),
    getLogTail: (lines) => invoke(IPC.engineGetLogTail, lines ?? 120),
    openLog: () => invoke(IPC.engineOpenLog),
    setGlobalLimits: (limits) => invoke(IPC.engineSetGlobalLimits, limits)
  },

  downloads: {
    list: () => invoke(IPC.downloadsList),
    add: (input) => invoke(IPC.downloadsAdd, input),
    pause: (gids) => invoke(IPC.downloadsPause, gids),
    resume: (gids) => invoke(IPC.downloadsResume, gids),
    remove: (gids, deleteFiles) => invoke(IPC.downloadsRemove, gids, deleteFiles),
    move: (gid, position) => invoke(IPC.downloadsMove, gid, position),
    changeOptions: (gid, patch) => invoke(IPC.downloadsChangeOptions, gid, patch),
    retry: (gids) => invoke(IPC.downloadsRetry, gids),
    openFile: (gid) => invoke(IPC.downloadsOpenFile, gid),
    showInFolder: (gid) => invoke(IPC.downloadsShowInFolder, gid),
    copyLink: (gid) => invoke(IPC.downloadsCopyLink, gid),
    getFiles: (gid) => invoke(IPC.downloadsGetFiles, gid),
    getServers: (gid) => invoke(IPC.downloadsGetServers, gid),
    getPeers: (gid) => invoke(IPC.downloadsGetPeers, gid),
    getPieces: (gid) => invoke(IPC.downloadsGetPieces, gid),
    getOptions: (gid) => invoke(IPC.downloadsGetOptions, gid),
    clearCompleted: () => invoke(IPC.downloadsClearCompleted),
    pauseAll: () => invoke(IPC.downloadsPauseAll),
    resumeAll: () => invoke(IPC.downloadsResumeAll),
    parseUriList: (text) => invoke(IPC.downloadsParseUriList, text),
    runPostAction: (gid) => invoke(IPC.downloadsRunPostAction, gid)
  },

  history: {
    query: (query) => invoke(IPC.historyQuery, query),
    delete: (ids) => invoke(IPC.historyDelete, ids),
    clear: () => invoke(IPC.historyClear)
  },

  settings: {
    get: () => invoke(IPC.settingsGet),
    patch: (patch) => invoke(IPC.settingsPatch, patch),
    saveProfile: (profile) => invoke(IPC.settingsSaveProfile, profile),
    deleteProfile: (id) => invoke(IPC.settingsDeleteProfile, id),
    saveSchedule: (rule) => invoke(IPC.settingsSaveSchedule, rule),
    deleteSchedule: (id) => invoke(IPC.settingsDeleteSchedule, id),
    saveCategory: (rule) => invoke(IPC.settingsSaveCategory, rule),
    deleteCategory: (id) => invoke(IPC.settingsDeleteCategory, id),
    applyProfile: (id) => invoke(IPC.settingsApplyProfile, id),
    getPaths: () => invoke(IPC.settingsGetPaths),
    chooseDirectory: (defaultPath) => invoke(IPC.settingsChooseDirectory, defaultPath)
  },

  integrations: {
    setClipboardWatch: (enabled) => invoke(IPC.integrationsSetClipboardWatch, enabled),
    getHandoffInfo: () => invoke(IPC.integrationsGetHandoffInfo),
    rotateHandoffToken: () => invoke(IPC.integrationsRotateHandoffToken),
    getMediaFormats: (url) => invoke(IPC.integrationsGetMediaFormats, url),
    getMediaPlaylist: (url) => invoke(IPC.integrationsGetMediaPlaylist, url),
    addMedia: (input) => invoke(IPC.integrationsAddMedia, input),
    checkToolkits: () => invoke(IPC.integrationsCheckToolkits),
    downloadToolkit: (kind) => invoke(IPC.integrationsDownloadToolkit, kind),
    openExtensionFolder: () => invoke(IPC.integrationsOpenExtensionFolder),
    systemPower: (action) => invoke(IPC.integrationsSystemPower, action),
    dismissDetected: () => invoke(IPC.integrationsDismissDetected)
  },

  app: {
    openExternal: (url) => invoke(IPC.appOpenExternal, url),
    reveal: (target) => invoke(IPC.appReveal, target)
  },

  update: {
    check: () => invoke(IPC.updateCheck),
    download: () => invoke(IPC.updateDownload),
    install: () => invoke(IPC.updateInstall),
    cancel: () => invoke(IPC.updateCancel),
    openInstaller: (file) => invoke(IPC.updateOpenInstaller, file),
    diagnostics: () => invoke(IPC.updateDiagnostics),
    repair: () => invoke(IPC.updateRepair)
  },

  catcher: {
    get: () => invoke(IPC.catcherGet),
    resolve: (action) => invoke(IPC.catcherResolve, action)
  },

  on: {
    tick: (handler) => subscribe(IPC.eventTick, handler),
    engineStatus: (handler) => subscribe(IPC.eventEngineStatus, handler),
    clipboardDetected: (handler) => subscribe(IPC.eventClipboardDetected, handler),
    toast: (handler) => subscribe(IPC.eventToast, handler),
    navigate: (handler) => subscribe(IPC.eventNavigate, handler),
    catcherUpdate: (handler) => subscribe(IPC.eventCatcher, handler),
    updateProgress: (handler) => subscribe(IPC.eventUpdateProgress, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
