import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type MenuItemConstructorOptions
} from 'electron'

import type { DownloadItem, ToastPayload } from '@shared/download'
import { HANDOFF_DISCOVERY_PORTS, IPC, type NavigationPayload, type SystemPowerAction } from '@shared/ipc'
import type { DeepPartial, Settings } from '@shared/settings'
import { formatSpeed } from '@shared/format'
import { localeFromSetting } from '@shared/i18n'

import { locateAria2 } from './aria2/locate'
import { DownloadCatcher } from './catcher'
import { Aria2Supervisor } from './aria2/supervisor'
import { findCategory } from './downloads/categorizer'
import { EngineRouter } from './downloads/engine-router'
import { HistoryStore } from './downloads/history-store'
import { DownloadManager } from './downloads/manager'
import { registerIpcHandlers } from './ipc/handlers'
import { ClipboardWatcher, looksLikeDirectFile } from './integrations/clipboard-watch'
import { HandoffServer } from './integrations/handoff-api'
import { runPostAction, type PostActionDeps } from './integrations/post-actions'
import { Scheduler } from './integrations/scheduler'
import { isMediaGid, MediaJobs, mergeMediaItems } from './media/jobs'
import { defaultDownloadDir, resolvePaths } from './paths'
import { SettingsStore } from './settings/store'
import { ToolkitManager } from './toolkit'
import { UpdateManager } from './update/update-manager'
import { resolveCookieArgs } from './media/browser-cookies'
import { BACKGROUND, createMainWindow, resolvePreloadPath, resolveRendererPage } from './window'

const PROTOCOL = 'ariadm'

/** Seconds of grace before the scheduled power action actually runs. */
const POWER_COUNTDOWN_SECONDS = 60

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let powerTimer: NodeJS.Timeout | null = null
let pendingPowerAction: SystemPowerAction | null = null

let supervisor: Aria2Supervisor
let manager: DownloadManager
let settingsStore: SettingsStore
let history: HistoryStore
let toolkit: ToolkitManager
let mediaJobs: MediaJobs
let engineRouter: EngineRouter
let catcher: DownloadCatcher | null = null
let updateManager: UpdateManager | null = null
let clipboardWatcher: ClipboardWatcher | null = null
let handoff: HandoffServer | null = null
/** Fixed-port listener whose only job is to answer extension pairing. */
let rendezvous: HandoffServer | null = null
/** Retry timer for the rendezvous listener, which is retried with a backoff. */
let rendezvousRetry: NodeJS.Timeout | null = null
let rendezvousAttempts = 0

/** How long to wait before trying the discovery ports again. */
const RENDEZVOUS_RETRY_BASE_MS = 5_000
const RENDEZVOUS_RETRY_MAX_MS = 60_000
let scheduler: Scheduler

let paths: ReturnType<typeof resolvePaths>
let resourcesRoot = ''

const pendingIncoming: string[] = []

/**
 * Downloads that just finished, collected so a queue that drains all at once
 * produces one notification instead of one per file.
 *
 * Notifying on every completion was the main source of notification spam: a
 * batch of five files finishing together raised five toasts, and the "all
 * finished" toast on top of them re-announced the whole queue on every dip to
 * zero active downloads.
 */
let completionBatch: string[] = []
let completionTimer: NodeJS.Timeout | null = null

/** How long to gather completions before announcing them. */
const COMPLETION_BATCH_MS = 1_200

function log(line: string): void {
  // Main-process logging goes to the terminal in development and is otherwise
  // surfaced through the aria2 log and the UI's engine banner.
  if (!app.isPackaged) console.log(`[ariadm] ${line}`)
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function toast(payload: Omit<ToastPayload, 'id'>): void {
  send(IPC.eventToast, { ...payload, id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
}

/**
 * The app icon for a toast.
 *
 * A Windows 11 notification shows the sender's logo; without one it falls back
 * to the generic Electron mark, which makes the toast look like a stray build
 * rather than part of the app.
 */
function notificationIcon(): Electron.NativeImage | undefined {
  const image = nativeImage.createFromPath(path.join(resourcesRoot, 'icons', 'app.png'))
  return image.isEmpty() ? undefined : image
}

/**
 * Show a system notification.
 *
 * Clicking it opens the main window, which is what a download manager's toast
 * is implicitly promising. The icon and the AppUserModelID set at startup are
 * what make the toast read as "AriaDM" instead of "electron.app.AriaDM".
 */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  try {
    const notification = new Notification({ title, body, icon: notificationIcon() })
    notification.on('click', () => showWindow())
    notification.show()
  } catch (error) {
    log(`notification failed: ${(error as Error).message}`)
  }
}

// ---- single instance & protocol -------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // A second launch (from the protocol handler or a file association) must hand
  // its payload to the running instance rather than starting a rival engine.
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    collectIncoming(argv)
    showWindow()
    void processIncoming()
  })
}

app.setAsDefaultProtocolClient(PROTOCOL)

// Windows attributes a toast to an AppUserModelID. Without this the app's own
// notifications are labelled "electron.app.AriaDM" instead of "AriaDM", because
// the default id does not match the shortcut the installer created.
if (process.platform === 'win32') app.setAppUserModelId('app.ariadm')

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  pendingIncoming.push(filePath)
})

function collectIncoming(argv: string[]): void {
  for (const argument of argv) {
    const value = argument.trim()
    if (!value) continue
    if (value.startsWith(`${PROTOCOL}://`)) pendingIncoming.push(value)
    else if (/\.(torrent|metalink)$/i.test(value)) pendingIncoming.push(value)
  }
}

/** Decode ariadm:// and file arguments into actual downloads. */
async function processIncoming(): Promise<void> {
  if (pendingIncoming.length === 0) return
  const queueBatched = pendingIncoming.splice(0, pendingIncoming.length)

  for (const entry of queueBatched) {
    try {
      if (entry.startsWith(`${PROTOCOL}://`)) {
        const parsed = new URL(entry)
        const target = parsed.searchParams.get('url') ?? decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        if (target) {
          await engineRouter.add(baseInput([target], 'protocol'))
        }
        continue
      }

      if (/\.torrent$/i.test(entry)) {
        const body = await fsp.readFile(entry)
        await manager.add({
          ...baseInput([], 'file'),
          torrentBase64: body.toString('base64'),
          out: path.basename(entry).replace(/\.torrent$/i, '')
        })
        continue
      }

      if (/\.metalink$/i.test(entry)) {
        const body = await fsp.readFile(entry)
        await manager.add({ ...baseInput([], 'file'), metalinkBase64: body.toString('base64') })
      }
    } catch (error) {
      toast({ title: '無法加入下載', body: (error as Error).message, tone: 'error' })
    }
  }
}

function baseInput(uris: string[], source: 'manual' | 'protocol' | 'file' | 'clipboard' | 'browser') {
  const settings = settingsStore.get()
  return {
    uris,
    out: '',
    dir: '',
    split: settings.split,
    maxConnectionPerServer: settings.maxConnectionPerServer,
    minSplitSize: settings.minSplitSize,
    maxDownloadLimit: 0,
    referer: '',
    userAgent: '',
    cookieHeader: '',
    headers: [],
    username: '',
    password: '',
    proxy: '',
    paused: false,
    seedRatio: settings.seedRatio,
    seedTime: settings.seedTime,
    selectFileIndices: [],
    category: '',
    tags: [],
    source,
    torrentBase64: null,
    metalinkBase64: null,
    allowDuplicate: false,
    engine: 'auto' as const
  }
}

// ---- window & tray ---------------------------------------------------------

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): BrowserWindow {
  const settings = settingsStore.get()
  const window = createMainWindow({
    bounds: settings.window,
    iconPath: path.join(resourcesRoot, 'icons', 'app.png'),
    onBoundsChange: (bounds) => {
      void settingsStore.patch({ window: { ...settingsStore.get().window, ...bounds } })
      settingsStore.scheduleSave()
    },
    onCloseRequested: () => {
      const current = settingsStore.get()
      // Hide to tray instead of quitting, which is what a download manager that
      // is meant to keep working in the background should do.
      if (!quitting && current.closeToTray && current.useSystemTray) {
        window.hide()
        if (!current.startMinimised) toast({ title: 'AriaDM 仍在背景執行', body: '下載會繼續進行。', tone: 'info' })
        return false
      }
      return true
    },
    onReadyToShow: () => {
      if (settingsStore.get().startMinimised) window.hide()
    }
  })

  window.on('closed', () => {
    mainWindow = null
  })

  return window
}

function trayIconImage(): Electron.NativeImage {
  const candidates = ['tray@3x.png', 'tray@2x.png', 'tray.png']
  for (const name of candidates) {
    const image = nativeImage.createFromPath(path.join(resourcesRoot, 'icons', name))
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

function buildTrayMenu(): Menu {
  const settings = settingsStore.get()
  const limitOptions: { label: string; value: number }[] = [
    { label: '無限速', value: 0 },
    { label: '10 MB/s', value: 10 * 1024 * 1024 },
    { label: '5 MB/s', value: 5 * 1024 * 1024 },
    { label: '1 MB/s', value: 1024 * 1024 },
    { label: '200 KB/s', value: 200 * 1024 }
  ]

  const template: MenuItemConstructorOptions[] = [
    { label: '顯示主視窗', click: () => showWindow() },
    { type: 'separator' },
    { label: '全部開始', click: () => void manager.resumeAll() },
    { label: '全部暫停', click: () => void manager.pauseAll() },
    {
      label: '全域限速',
      submenu: limitOptions.map((option) => ({
        label: option.label,
        type: 'radio' as const,
        checked: settings.globalDownloadLimit === option.value,
        click: () => {
          void applyGlobalDownloadLimit(option.value)
        }
      }))
    },
    { type: 'separator' },
    {
      label: '開啟下載資料夾',
      click: () => {
        void shell.openPath(manager.getItems()[0]?.dir ?? settingsStore.get().downloadDir)
      }
    },
    {
      label: '設定',
      click: () => {
        showWindow()
        const payload: NavigationPayload = { view: 'settings' }
        send(IPC.eventNavigate, payload)
      }
    }
  ]

  if (pendingPowerAction) {
    template.push({ type: 'separator' }, { label: '取消關機', click: () => void requestSystemPower('cancel') })
  }

  template.push({ type: 'separator' }, { label: '結束 AriaDM', click: () => void shutdownAndQuit() })

  return Menu.buildFromTemplate(template)
}

async function applyGlobalDownloadLimit(value: number): Promise<void> {
  const next = await updateSettings({ globalDownloadLimit: value })
  await supervisor.applyLiveSettings(next)
  toast({
    title: '已更新全域限速',
    body: value === 0 ? '已取消限速' : `下載限速 ${formatSpeed(value)}`,
    tone: 'info'
  })
}

function refreshTray(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())

  const global = manager.getGlobalStat()
  const items = manager.getItems()
  const active = items.filter((item) => item.status === 'active').length
  const total = items.length
  tray.setToolTip(
    active > 0 || global.numWaiting > 0
      ? `AriaDM — ↓ ${formatSpeed(global.downloadSpeed)} · ${active} 進行中 · ${global.numWaiting} 排隊`
      : `AriaDM — 閒置（${total} 項）`
  )
}

// ---- settings side effects -------------------------------------------------

async function updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
  const previous = settingsStore.get()
  const next = await settingsStore.patch(patch)
  await applySettingsSideEffects(previous, next)
  return next
}

async function applySettingsSideEffects(previous: Settings, next: Settings): Promise<void> {
  if (previous.clipboardWatch !== next.clipboardWatch) {
    if (next.clipboardWatch) {
      ensureClipboardWatcher().start()
    } else {
      clipboardWatcher?.stop()
    }
  }

  if (previous.handoffEnabled !== next.handoffEnabled || previous.handoffPort !== next.handoffPort) {
    await restartHandoff()
  }

  if (previous.aria2Path !== next.aria2Path && next.aria2Path) {
    supervisor.updateBinaryPath(next.aria2Path)
  }

  if (previous.useSystemTray !== next.useSystemTray) {
    if (next.useSystemTray) createTray()
    else {
      tray?.destroy()
      tray = null
    }
  }

  // Connection and throughput limits can be changed on a running daemon.
  const liveKeys: (keyof Settings)[] = [
    'globalDownloadLimit',
    'globalUploadLimit',
    'maxConcurrentDownloads',
    'split',
    'maxConnectionPerServer',
    'minSplitSize'
  ]
  const liveChanged = liveKeys.some((key) => previous[key] !== next[key])
  if (liveChanged) await supervisor.applyLiveSettings(next)
}

function ensureClipboardWatcher(): ClipboardWatcher {
  if (clipboardWatcher) return clipboardWatcher
  clipboardWatcher = new ClipboardWatcher({
    readText: () => clipboard.readText(),
    log,
    onDetected: (detected) => {
      const settings = settingsStore.get()
      const autoAdd = settings.clipboardAutoAdd && detected.urls.every((url) => looksLikeDirectFile(url))

      if (autoAdd) {
        void engineRouter
          .add(baseInput(detected.urls, 'clipboard'))
          .then(() => toast({ title: '已加入下載', body: detected.urls[0] ?? '', tone: 'success' }))
          .catch((error: Error) => toast({ title: '無法加入下載', body: error.message, tone: 'error' }))
        return
      }

      send(IPC.eventClipboardDetected, detected)
    }
  })
  return clipboardWatcher
}

/** Best-effort display name for the catch popup: the extension's filename first. */
function catcherTitle(payload: { filename?: string; urls?: string[] }): string {
  if (payload.filename) return payload.filename
  const first = payload.urls?.[0]
  if (!first) return ''
  try {
    const parsed = new URL(first)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return last ? decodeURIComponent(last) : parsed.host
  } catch {
    // A magnet link has no parseable path, so the raw URI is the honest answer.
    return first
  }
}

function catcherHost(urls: string[]): string {
  try {
    return new URL(urls[0] ?? '').host
  } catch {
    return ''
  }
}

async function restartHandoff(): Promise<void> {
  const settings = settingsStore.get()
  if (rendezvousRetry) {
    clearTimeout(rendezvousRetry)
    rendezvousRetry = null
  }
  if (handoff) {
    await handoff.stop()
    handoff = null
  }
  if (rendezvous) {
    await rendezvous.stop()
    rendezvous = null
  }
  if (!settings.handoffEnabled) return

  const server = new HandoffServer({
    port: settings.handoffPort,
    token: settings.handoffToken,
    version: app.getVersion(),
    log,
    onPing: () => {
      const global = manager.getGlobalStat()
      return { version: app.getVersion(), active: global.numActive, waiting: global.numWaiting }
    },
    onAdd: async (payload) => {
      const settings = settingsStore.get()
      // Hold the capture for confirmation when the popup is on. It goes in
      // paused, so the extension still gets its HTTP response immediately and the
      // popup can wait for the user for as long as it takes.
      const hold = settings.handoffEnabled && settings.showCatchPopup

      const input = {
        ...baseInput(payload.urls ?? [], 'browser'),
        out: payload.filename ?? '',
        dir: payload.dir ?? '',
        category: payload.category ?? '',
        referer: payload.referer ?? '',
        userAgent: payload.userAgent ?? '',
        cookieHeader: payload.cookies ?? '',
        headers: payload.headers ?? [],
        paused: hold || (payload.paused ?? false),
        torrentBase64: payload.torrentBase64 ?? null,
        // The extension's button is an explicit "this is a video" signal, which
        // is stronger evidence than our own host list.
        engine: payload.engine ?? (payload.media ? 'ytdlp' : 'auto')
      }
      const result = await engineRouter.add(input)

      // Only an *intercepted* file download is worth asking about. A yt-dlp
      // capture came from the user clicking the extension's download button on a
      // video, which is already a deliberate act — and the media engine has no
      // way to queue without starting, so it would be asked about too late.
      const routedToMedia = result.gids.some((gid) => isMediaGid(gid))
      if (hold && !routedToMedia && result.gids.length > 0) {
        catcher?.show({
          gids: result.gids,
          title: catcherTitle(payload),
          host: catcherHost(payload.urls ?? []),
          count: result.gids.length,
          locale: localeFromSetting(settings.language, app.getLocale()),
          theme: settings.theme,
          accent: settings.accent
        })
      }

      return { gids: result.gids, duplicates: result.duplicates, warnings: result.warnings }
    }
  })

  try {
    await server.start()
    handoff = server
  } catch {
    handoff = null
  }

  await startRendezvous(server)
}

/**
 * The fixed-port listener an extension uses to pair itself.
 *
 * Without it the extension would need the user to read a port and a token out of
 * Settings and type both in, which is where this previously went wrong: the
 * extension's default port was aria2's RPC port, so a fresh install simply never
 * connected.
 */
async function startRendezvous(server: HandoffServer): Promise<void> {
  // Nothing to do when the handoff endpoint itself sits on a discovery port:
  // it already answers /discover, and a second listener would just collide.
  if (HANDOFF_DISCOVERY_PORTS.includes(server.listeningPort as (typeof HANDOFF_DISCOVERY_PORTS)[number])) {
    rendezvous = null
    return
  }

  const make = (port: number): HandoffServer =>
    new HandoffServer({
      port,
      token: server.token,
      version: app.getVersion(),
      discoveryOnly: true,
      announce: { port: server.listeningPort, token: server.token },
      log,
      onAdd: async () => ({ gids: [], duplicates: [], warnings: [] }),
      onPing: () => {
        const global = manager.getGlobalStat()
        return { version: app.getVersion(), active: global.numActive, waiting: global.numWaiting }
      }
    })

  const bound = await HandoffServer.startFirstAvailable(HANDOFF_DISCOVERY_PORTS, make)
  if (bound) {
    rendezvous = bound.server
    rendezvousAttempts = 0
    if (bound.port !== HANDOFF_DISCOVERY_PORTS[0]) {
      log(`rendezvous port ${HANDOFF_DISCOVERY_PORTS[0]} was taken; extension discovery is on ${bound.port}`)
    }
    return
  }

  // Every candidate is owned by something else (AnyDesk claims 7070 by
  // default). That is recoverable, so keep trying with a capped backoff instead
  // of leaving auto-pairing dead for the rest of the session.
  rendezvous = null
  rendezvousAttempts += 1
  const delay = Math.min(RENDEZVOUS_RETRY_BASE_MS * 2 ** (rendezvousAttempts - 1), RENDEZVOUS_RETRY_MAX_MS)
  log(`all discovery ports ${HANDOFF_DISCOVERY_PORTS.join(', ')} are in use; retrying in ${Math.round(delay / 1000)}s`)
  rendezvousRetry = setTimeout(() => {
    rendezvousRetry = null
    if (!quitting && settingsStore.get().handoffEnabled && handoff) void startRendezvous(handoff)
  }, delay)
  rendezvousRetry.unref?.()
}

function createTray(): void {
  if (tray) return
  const image = trayIconImage()
  if (image.isEmpty()) {
    log('tray icon unavailable; skipping the tray')
    return
  }
  tray = new Tray(image)
  tray.on('click', () => showWindow())
  tray.on('double-click', () => showWindow())
  refreshTray()
}

// ---- power actions ---------------------------------------------------------

async function requestSystemPower(action: SystemPowerAction): Promise<void> {
  if (action === 'cancel') {
    if (powerTimer) {
      clearTimeout(powerTimer)
      powerTimer = null
    }
    pendingPowerAction = null
    refreshTray()
    toast({ title: '已取消', body: '排定的電源動作已取消。', tone: 'info' })
    return
  }

  if (action === 'exit') {
    await shutdownAndQuit()
    return
  }

  if (powerTimer) clearTimeout(powerTimer)
  pendingPowerAction = action
  refreshTray()

  const label = action === 'shutdown' ? '關機' : action === 'sleep' ? '睡眠' : '休眠'
  toast({
    title: `${POWER_COUNTDOWN_SECONDS} 秒後${label}`,
    body: '可從系統匣選單取消。',
    tone: 'warn'
  })

  powerTimer = setTimeout(() => {
    powerTimer = null
    void executeSystemPower(action)
  }, POWER_COUNTDOWN_SECONDS * 1000)
}

/**
 * The actual OS call. Windows has no SIGTERM equivalent for power, so each
 * action goes through the platform's own utility.
 */
async function executeSystemPower(action: SystemPowerAction): Promise<void> {
  const run = (file: string, args: string[]): void => {
    execFile(file, args, { windowsHide: true }, (error) => {
      if (error) log(`power action ${action} failed: ${error.message}`)
    })
  }

  try {
    if (process.platform === 'win32') {
      if (action === 'shutdown') run('shutdown.exe', ['/s', '/t', '0'])
      else if (action === 'hibernate') run('shutdown.exe', ['/h'])
      // SetSuspendState with the hibernate flag off performs a suspend.
      else run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
    } else if (process.platform === 'darwin') {
      if (action === 'shutdown') run('osascript', ['-e', 'tell app "System Events" to shut down'])
      else run('osascript', ['-e', 'tell app "System Events" to sleep'])
    } else {
      if (action === 'shutdown') run('systemctl', ['poweroff'])
      else run('systemctl', ['suspend'])
    }
  } finally {
    pendingPowerAction = null
    refreshTray()
  }
}

// ---- post actions ----------------------------------------------------------

const postActionDeps: PostActionDeps = {
  openPath: (target) => shell.openPath(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
  notify: ({ title, body }) => notify(title, body),
  execCommand: (file, args) => {
    execFile(file, args, { windowsHide: true }, (error) => {
      if (error) log(`post-download command failed: ${error.message}`)
    })
  },
  log
}

function resolveActionFor(item: DownloadItem) {
  const settings = settingsStore.get()
  const category = findCategory(settings.categories, item.category)
  return { ...settings.postAction, ...(category?.postAction ?? {}) }
}

async function runPostActionFor(item: DownloadItem): Promise<void> {
  const action = resolveActionFor(item)
  if (isMediaGid(item.gid)) mediaJobs.markPostAction(item.gid, 'running')
  else manager.setPostActionState(item.gid, 'running')

  const outcome = await runPostAction(postActionDeps, action, item)

  const state = outcome.error ? 'failed' : outcome.ran.length > 0 ? 'done' : 'idle'
  if (isMediaGid(item.gid)) mediaJobs.markPostAction(item.gid, state)
  else manager.setPostActionState(item.gid, state)

  if (outcome.error) {
    log(`post action for ${item.name}: ${outcome.error}`)
    toast({ title: '下載完成後動作失敗', body: outcome.error, tone: 'warn' })
  }
}

/**
 * Queue a completion notification, batching bursts into a single toast.
 *
 * The title reflects what the user actually cares about: whether the queue has
 * drained (safe to shut down) or a file finished while others keep running.
 */
function queueCompletionNotice(name: string): void {
  completionBatch.push(name)
  if (completionTimer) return

  completionTimer = setTimeout(() => {
    completionTimer = null
    const batch = completionBatch
    completionBatch = []
    if (batch.length === 0) return

    const global = manager.getGlobalStat()
    const drained = global.numActive === 0 && global.numWaiting === 0

    // Only claim "all finished" when the queue really is empty; a burst that
    // finished while more downloads are still running is just a completion.
    const title = drained ? '全部下載完成' : '下載完成'
    if (batch.length === 1) {
      notify(title, batch[0]!)
      return
    }
    notify(title, `共 ${batch.length} 個項目已完成。`)
  }, COMPLETION_BATCH_MS)
  completionTimer.unref?.()
}

async function handleCompleted(item: DownloadItem): Promise<void> {
  const settings = settingsStore.get()

  if (settings.soundOnComplete) {
    try {
      shell.beep()
    } catch {
      // A missing bell is not worth surfacing.
    }
  }

  await runPostActionFor(item)

  if (settings.notifyOnComplete && !item.notified) {
    queueCompletionNotice(item.name)
    if (isMediaGid(item.gid)) mediaJobs.markNotified(item.gid)
    else manager.markCompletedHandled(item.gid)
  }
}

function handleFailed(item: DownloadItem): void {
  const settings = settingsStore.get()
  if (!settings.notifyOnError) return
  notify('下載失敗', `${item.name}${item.errorMessage ? ` — ${item.errorMessage}` : ''}`)
}

// ---- lifecycle -------------------------------------------------------------

async function shutdownAndQuit(): Promise<void> {
  quitting = true
  manager.stop()
  scheduler.stop()
  // Anything the popup was holding stays paused, which is exactly what leaving
  // it unanswered means. `destroy` instead of a plain close so the window's own
  // close handler does not race this.
  catcher?.destroy()
  clipboardWatcher?.stop()
  mediaJobs.killAll()
  if (rendezvousRetry) {
    clearTimeout(rendezvousRetry)
    rendezvousRetry = null
  }
  await handoff?.stop()
  await rendezvous?.stop()
  await supervisor.stop()
  await history.flush()
  await settingsStore.save()
  // Everything is flushed, so the installer has no running app to report on and
  // nothing left to kill. It relaunches AriaDM itself when it finishes.
  updateManager?.launchInstaller()
  app.quit()
}

async function bootstrap(): Promise<void> {
  const appRoot = app.getAppPath()
  const isPackaged = app.isPackaged
  resourcesRoot = isPackaged ? process.resourcesPath : path.join(appRoot, 'resources')

  paths = resolvePaths(app.getPath('userData'), defaultDownloadDir())

  settingsStore = new SettingsStore(paths)
  await settingsStore.load()

  history = new HistoryStore(paths.history)
  await history.load()

  toolkit = new ToolkitManager({ userDataBinDir: paths.bin, bundledDir: path.join(resourcesRoot, 'bin') }, log)

  // Make sure aria2 exists before anything tries to spawn it.
  let located = locateAria2({
    bundledDir: path.join(resourcesRoot, 'bin'),
    userDataBinDir: paths.bin,
    override: settingsStore.get().aria2Path
  })

  if (located.source === 'missing') {
    try {
      await toolkit.ensureAria2()
      located = locateAria2({
        bundledDir: path.join(resourcesRoot, 'bin'),
        userDataBinDir: paths.bin,
        override: settingsStore.get().aria2Path
      })
    } catch (error) {
      log(`aria2 bootstrap failed: ${(error as Error).message}`)
    }
  }

  supervisor = new Aria2Supervisor({
    binaryPath: located.path,
    settings: settingsStore.get(),
    paths: { sessionFile: paths.session, logFile: paths.aria2Log, downloadDir: settingsStore.get().downloadDir },
    onLog: log
  })

  mediaJobs = new MediaJobs({
    history,
    getBinaryPath: () =>
      locateAria2({
        bundledDir: path.join(resourcesRoot, 'bin'),
        userDataBinDir: paths.bin,
        override: ''
      }).path && '',
    getFfmpegPath: () => '',
    log
  })

  // Replace the placeholder accessors with real lookups now that paths exist.
  const tools = toolkit.locate()
  const realMediaJobs = new MediaJobs({
    history,
    getBinaryPath: () => tools.ytdlp.path,
    getFfmpegPath: () => settingsStore.get().ffmpegPath || tools.ffmpeg.path,
    // Resolved per run so changing the setting applies to the next download.
    getCookieArgs: () =>
      resolveCookieArgs(settingsStore.get().mediaCookiesFromBrowser, {
        platform: process.platform,
        env: process.env
      }).args,
    getYtdlpVersion: () => tools.ytdlp.version,
    log
  })
  mediaJobs = realMediaJobs

  manager = new DownloadManager({
    supervisor,
    settingsStore,
    history,
    log,
    hooks: {
      onCompleted: (item) => void handleCompleted(item),
      onFailed: (item) => handleFailed(item),
      // The completion notification is raised by the batch below, which already
      // knows whether the queue drained; there is nothing to announce here.
      onQueueIdle: () => mainWindow?.setProgressBar(-1)
    }
  })

  // Every entry point adds through here so `engine: 'auto'` finally decides
  // something: a link from any source routes to the engine that can fetch it.
  engineRouter = new EngineRouter({
    manager,
    mediaJobs,
    getSettings: () => settingsStore.get(),
    log
  })

  // The IDM-style catch popup. Built here rather than at launch because acting on
  // a capture needs both engines: what the extension intercepted may have gone
  // to aria2 or to yt-dlp.
  catcher = new DownloadCatcher({
    page: () => resolveRendererPage('catcher'),
    preloadPath: resolvePreloadPath(),
    iconPath: path.join(resourcesRoot, 'icons', 'app.png'),
    backgroundColor: BACKGROUND,
    log,
    onResolve: (info, action) => {
      // The capture was added paused, so "later" is already done.
      if (action === 'later') return

      const media = info.gids.filter((gid) => isMediaGid(gid))
      const aria2 = info.gids.filter((gid) => !isMediaGid(gid))

      if (action === 'start') {
        if (aria2.length > 0) void manager.resume(aria2)
        for (const gid of media) void mediaJobs.resume(gid)
      } else {
        if (aria2.length > 0) void manager.remove(aria2, false)
        for (const gid of media) void mediaJobs.remove(gid, false)
      }
    }
  })

  // In-app update. `canInstall` is false for the portable build, whose only
  // honest option is the manual download, and for an unpackaged dev run.
  updateManager = new UpdateManager({
    currentVersion: () => app.getVersion(),
    installerDir: () => path.join(app.getPath('temp'), 'ariadm-update'),
    canInstall: () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR,
    onProgress: (progress) => send(IPC.eventUpdateProgress, progress),
    requestQuit: () => void shutdownAndQuit(),
    log
  })

  mediaJobs.on('completed', (item: DownloadItem) => void handleCompleted(item))
  mediaJobs.on('failed', (item: DownloadItem) => handleFailed(item))
  mediaJobs.on('change', () => void manager.tick())

  scheduler = new Scheduler({
    getRules: () => settingsStore.get().schedules,
    startAll: () => manager.resumeAll(),
    pauseAll: () => manager.pauseAll(),
    applyProfile: async (id) => {
      await applyProfile(id)
    },
    isQueueIdle: () => {
      const global = manager.getGlobalStat()
      return global.numActive === 0 && global.numWaiting === 0
    },
    requestSystemPower: (action) => requestSystemPower(action),
    log
  })

  // Forward ticks with media jobs merged in, so the UI sees one unified list.
  manager.on('tick', (payload: { items: DownloadItem[]; global: unknown; engine: unknown; at: number; speedSeries: unknown }) => {
    const merged = { ...payload, items: mergeMediaItems(payload.items, mediaJobs.items()) }
    send(IPC.eventTick, merged)

    const global = manager.getGlobalStat()
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (global.numActive > 0 && global.numWaiting > 0) {
        mainWindow.setProgressBar(-1)
      } else if (global.numActive > 0) {
        mainWindow.setProgressBar(0.5)
      } else {
        mainWindow.setProgressBar(-1)
      }
    }

    refreshTray()
  })

  supervisor.on('status', (status: unknown) => send(IPC.eventEngineStatus, status))

  registerIpcHandlers({
    getWindow: () => mainWindow,
    settingsStore,
    history,
    manager,
    supervisor,
    toolkit,
    mediaJobs,
    engineRouter,
    getHandoff: () => handoff,
    getRendezvous: () => rendezvous,
    getClipboard: () => clipboardWatcher,
    get catcher(): DownloadCatcher {
      if (!catcher) throw new Error('catch popup is not available yet')
      return catcher
    },
    get update(): UpdateManager {
      if (!updateManager) throw new Error('the updater is not available yet')
      return updateManager
    },
    paths,
    extensionDir: path.join(resourcesRoot, 'extension'),
    applyProfile,
    restartEngine: async () => {
      await supervisor.restart()
      await manager.tick()
    },
    updateSettings,
    requestSystemPower,
    runPostActionFor,
    log
  })

  if (settingsStore.get().useSystemTray) createTray()

  showWindow()

  await supervisor.start()
  await manager.start()

  if (settingsStore.get().clipboardWatch) ensureClipboardWatcher().start()
  await restartHandoff()
  scheduler.start()

  collectIncoming(process.argv)
  await processIncoming()
}

async function applyProfile(id: string): Promise<Settings> {
  const settings = settingsStore.get()
  const profile = settings.profiles.find((entry) => entry.id === id)
  if (!profile) throw new Error('找不到指定的速度設定檔。')

  const next = await updateSettings({
    activeProfileId: id,
    globalDownloadLimit: profile.maxOverallDownloadLimit,
    globalUploadLimit: profile.maxOverallUploadLimit,
    maxConcurrentDownloads: profile.maxConcurrentDownloads,
    split: profile.split,
    maxConnectionPerServer: profile.maxConnectionPerServer,
    minSplitSize: profile.minSplitSize,
    connectionsPreset: 'custom'
  })

  await supervisor.applyLiveSettings(next)
  toast({ title: '已套用速度設定檔', body: profile.name, tone: 'info' })
  return next
}

app.whenReady().then(() => {
  void bootstrap()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showWindow()
    else showWindow()
  })
})

app.on('window-all-closed', () => {
  // The queue may legitimately keep running with no window on Windows/Linux, so
  // only quit when the tray is unavailable and nothing is downloading.
  const settings = settingsStore?.get()
  if (process.platform === 'darwin') return
  if (settings?.useSystemTray && tray) return
  void shutdownAndQuit()
})

app.on('before-quit', () => {
  quitting = true
})
