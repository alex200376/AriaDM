import { create } from 'zustand'

// `t` reads a module-level locale rather than a hook so plain helpers (label
// mappers, toast builders inside actions) can translate too. The locale is
// synced here, before the state update that re-renders the tree, so every
// component sees the new language on its next render.
import { getLocale, intlLocale, localeFromSetting, setLocale, t } from '@shared/i18n'

import type {
  ClipboardDetected,
  DownloadItem,
  EngineStatus,
  GlobalStat,
  HistoryRow,
  SpeedSample,
  TickPayload,
  ToastPayload,
  ToolkitStatus
} from '@shared/download'
import type { HandoffInfo, NavigationPayload } from '@shared/ipc'
import type {
  AppPaths,
  AddDownloadInput,
  AddDownloadResult,
  DeepPartial,
  ItemOptionPatch,
  Settings
} from '@shared/settings'

export type ViewKey =
  | 'all'
  | 'active'
  | 'waiting'
  | 'paused'
  | 'complete'
  | 'error'
  | 'history'
  | 'settings'

export type DialogKind = 'none' | 'add' | 'settings' | 'schedules' | 'about' | 'extension'

/**
 * The settings panels. Kept here rather than inside the view because other
 * screens link straight to a panel (the sidebar's speed-profile shortcut lands
 * on 下載), and because the active panel survives leaving and re-entering
 * settings.
 */
export type SettingsTab = 'general' | 'downloads' | 'schedules' | 'integrations' | 'about'

export type SortField = 'name' | 'size' | 'progress' | 'speed' | 'eta' | 'addedAt' | 'status'

export interface AppState {
  ready: boolean
  bootstrapError: string

  items: DownloadItem[]
  global: GlobalStat
  engine: EngineStatus
  speedSeries: SpeedSample[]
  settings: Settings | null
  /**
   * The wallpaper as a data URL, or '' when none is set.
   *
   * It is state rather than a render-time fetch because the renderer's CSP only
   * permits `data:` images, so the picture has to come from the main process —
   * and that is a file read worth doing once per change instead of per paint.
   */
  wallpaper: string
  paths: AppPaths | null
  toolkits: ToolkitStatus | null
  handoff: HandoffInfo | null
  historyRows: HistoryRow[]
  historyTotal: number

  view: ViewKey
  category: string
  search: string
  sortField: SortField
  sortDirection: 'asc' | 'desc'
  selection: string[]
  detailGid: string | null
  dialog: DialogKind
  dialogSeed: string
  settingsTab: SettingsTab
  toasts: ToastPayload[]
  clipboardOffer: ClipboardDetected | null
  lastActionError: string

  bootstrap(): Promise<void>
  refreshSettings(): Promise<void>
  refreshToolkits(): Promise<void>
  refreshHandoff(): Promise<void>

  patchSettings(patch: DeepPartial<Settings>): Promise<void>
  applyProfile(id: string): Promise<void>

  setView(view: ViewKey): void
  setSettingsTab(tab: SettingsTab): void
  openSettings(tab?: SettingsTab): void
  setCategory(category: string): void
  setSearch(search: string): void
  toggleSort(field: SortField): void
  setSelection(gids: string[]): void
  toggleSelected(gid: string): void
  selectAll(gids: string[]): void
  openDetail(gid: string | null): void
  openDialog(dialog: DialogKind, seed?: string): void
  closeDialog(): void

  pushToast(toast: Omit<ToastPayload, 'id'>): void
  dismissToast(id: string): void
  setClipboardOffer(offer: ClipboardDetected | null): void
  setEngine(engine: EngineStatus): void
  applyTick(payload: TickPayload): void
  handleNavigation(payload: NavigationPayload): void

  // download commands
  addDownload(input: AddDownloadInput): Promise<AddDownloadResult | null>
  pauseGids(gids: string[]): Promise<void>
  resumeGids(gids: string[]): Promise<void>
  removeGids(gids: string[], deleteFiles: boolean): Promise<void>
  retryGids(gids: string[]): Promise<void>
  openFile(gid: string): Promise<void>
  showInFolder(gid: string): Promise<void>
  copyLink(gid: string): Promise<void>
  clearCompleted(): Promise<void>
  pauseAll(): Promise<void>
  resumeAll(): Promise<void>
  changeOptions(gid: string, patch: ItemOptionPatch): Promise<void>
  move(gid: string, position: number): Promise<void>

  queryHistory(): Promise<void>
  deleteHistory(gids: string[]): Promise<void>
  clearHistory(): Promise<void>

  runAction(label: string, action: () => Promise<unknown>): Promise<boolean>
}

const emptyGlobal: GlobalStat = {
  downloadSpeed: 0,
  uploadSpeed: 0,
  numActive: 0,
  numWaiting: 0,
  numStopped: 0,
  numStoppedTotal: 0
}

const emptyEngine: EngineStatus = {
  state: 'stopped',
  pid: null,
  port: null,
  version: '',
  message: '',
  restarts: 0,
  lastError: '',
  logTail: '',
  startedAt: null
}

let toastCounter = 0

/**
 * The last wallpaper read, keyed by the path it came from.
 *
 * Settings are re-read on every window focus, and a wallpaper is a file read plus
 * a base64 round trip through IPC. Remembering the last answer means those
 * refreshes cost nothing while the path is unchanged — including the common case
 * of no wallpaper at all, which is keyed as ''.
 */
let loadedWallpaper: { path: string; dataUrl: string } = { path: '', dataUrl: '' }

async function loadWallpaper(settings: Settings): Promise<string> {
  const path = settings.backgroundImage
  if (path === loadedWallpaper.path) return loadedWallpaper.dataUrl
  // A read that fails (deleted file, unexpected format) is remembered as "none"
  // rather than retried on every refresh; Settings reports it where it is chosen.
  const dataUrl = path.length > 0 ? await window.api.settings.readImage(path).catch(() => null) : null
  loadedWallpaper = { path, dataUrl: dataUrl ?? '' }
  return loadedWallpaper.dataUrl
}

/** Keep the module-level locale in step with the persisted language setting. */
function syncLocale(settings: Settings | null | undefined): void {
  setLocale(localeFromSetting(settings?.language, typeof navigator === 'undefined' ? null : navigator.language))
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootstrapError: '',

  items: [],
  global: emptyGlobal,
  engine: emptyEngine,
  speedSeries: [],
  settings: null,
  wallpaper: '',
  paths: null,
  toolkits: null,
  handoff: null,
  historyRows: [],
  historyTotal: 0,

  view: 'all',
  category: 'all',
  search: '',
  sortField: 'addedAt',
  sortDirection: 'desc',
  selection: [],
  detailGid: null,
  dialog: 'none',
  dialogSeed: '',
  settingsTab: 'general',
  toasts: [],
  clipboardOffer: null,
  lastActionError: '',

  async bootstrap() {
    try {
      const [settings, paths, toolkits, items] = await Promise.all([
        window.api.settings.get(),
        window.api.settings.getPaths(),
        window.api.integrations.checkToolkits(),
        window.api.downloads.list()
      ])
      const handoff = await window.api.integrations.getHandoffInfo()
      const wallpaper = await loadWallpaper(settings)
      syncLocale(settings)
      set({ settings, wallpaper, paths, toolkits, handoff, items, ready: true, bootstrapError: '' })
    } catch (error) {
      set({ bootstrapError: (error as Error).message, ready: true })
    }
  },

  async refreshSettings() {
    try {
      const settings = await window.api.settings.get()
      syncLocale(settings)
      set({ settings, wallpaper: await loadWallpaper(settings) })
    } catch {
      // A settings refresh failing is never worth interrupting the user for.
    }
  },

  async refreshToolkits() {
    try {
      set({ toolkits: await window.api.integrations.checkToolkits() })
    } catch {
      // Keep the previously known status.
    }
  },

  async refreshHandoff() {
    try {
      set({ handoff: await window.api.integrations.getHandoffInfo() })
    } catch {
      // Ignored.
    }
  },

  async patchSettings(patch) {
    try {
      const settings = await window.api.settings.patch(patch)
      syncLocale(settings)
      set({ settings, wallpaper: await loadWallpaper(settings), lastActionError: '' })
    } catch (error) {
      get().pushToast({ title: t('toast.settingsFailed'), body: (error as Error).message, tone: 'error' })
    }
  },

  async applyProfile(id) {
    try {
      set({ settings: await window.api.settings.applyProfile(id) })
    } catch (error) {
      get().pushToast({ title: t('toast.profileFailed'), body: (error as Error).message, tone: 'error' })
    }
  },

  setView(view) {
    set({ view, selection: [], detailGid: null })
    if (view === 'history') void get().queryHistory()
  },

  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },

  openSettings(tab) {
    set({ settingsTab: tab ?? 'general', view: 'settings', selection: [], detailGid: null })
  },

  setCategory(category) {
    set({ category, selection: [] })
  },

  setSearch(search) {
    set({ search })
  },

  toggleSort(field) {
    const { sortField, sortDirection } = get()
    if (sortField === field) {
      set({ sortDirection: sortDirection === 'asc' ? 'desc' : 'asc' })
    } else {
      set({ sortField: field, sortDirection: field === 'name' ? 'asc' : 'desc' })
    }
  },

  setSelection(gids) {
    set({ selection: gids })
  },

  toggleSelected(gid) {
    const { selection } = get()
    set({
      selection: selection.includes(gid) ? selection.filter((entry) => entry !== gid) : [...selection, gid]
    })
  },

  selectAll(gids) {
    set({ selection: gids })
  },

  openDetail(gid) {
    set({ detailGid: gid })
  },

  openDialog(dialog, seed = '') {
    set({ dialog, dialogSeed: seed })
  },

  closeDialog() {
    set({ dialog: 'none', dialogSeed: '' })
  },

  pushToast(toast) {
    toastCounter += 1
    const id = `toast-${Date.now()}-${toastCounter}`
    set({ toasts: [...get().toasts, { ...toast, id }] })
    // Errors stay long enough to be read; everything else is transient.
    const ttl = toast.tone === 'error' ? 9000 : 4200
    window.setTimeout(() => get().dismissToast(id), ttl)
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((entry) => entry.id !== id) })
  },

  setClipboardOffer(offer) {
    set({ clipboardOffer: offer })
  },

  setEngine(engine) {
    set({ engine })
  },

  applyTick(payload) {
    set({
      items: payload.items,
      global: payload.global,
      engine: payload.engine,
      speedSeries: payload.speedSeries
    })
  },

  handleNavigation(payload) {
    set({ view: payload.view, detailGid: payload.gid ?? null })
    if (payload.view === 'history') void get().queryHistory()
  },

  // ---- download commands ---------------------------------------------------

  async addDownload(input) {
    let result: AddDownloadResult | null = null
    await get().runAction(t('toolbar.add'), async () => {
      result = await window.api.downloads.add(input)
      const created = result as AddDownloadResult
      if (created.gids.length > 0) {
        get().pushToast({
          title: t('toast.added'),
          body: t('toast.addedBody', { count: created.gids.length }),
          tone: 'success'
        })
      }
      for (const warning of created.warnings) {
        get().pushToast({ title: t('toast.notice'), body: warning, tone: 'warn' })
      }
      if (created.duplicates.length > 0) {
        get().pushToast({
          title: t('toast.duplicates'),
          body: t('toast.duplicatesBody', { count: created.duplicates.length }),
          tone: 'warn'
        })
      }
      set({ view: 'all' })
    })
    return result
  },

  async pauseGids(gids) {
    if (gids.length === 0) return
    await get().runAction(t('table.pause'), () => window.api.downloads.pause(gids))
  },

  async resumeGids(gids) {
    if (gids.length === 0) return
    await get().runAction(t('table.resume'), () => window.api.downloads.resume(gids))
  },

  async removeGids(gids, deleteFiles) {
    if (gids.length === 0) return
    await get().runAction(t('common.remove'), async () => {
      await window.api.downloads.remove(gids, deleteFiles)
      set({ selection: [], detailGid: null })
    })
  },

  async retryGids(gids) {
    if (gids.length === 0) return
    await get().runAction(t('common.retry'), async () => {
      const result = await window.api.downloads.retry(gids)
      for (const warning of result.warnings) {
        get().pushToast({ title: t('toast.retryNotice'), body: warning, tone: 'warn' })
      }
    })
  },

  async openFile(gid) {
    await get().runAction(t('table.openFile'), () => window.api.downloads.openFile(gid))
  },

  async showInFolder(gid) {
    await get().runAction(t('table.openFolder'), () => window.api.downloads.showInFolder(gid))
  },

  async copyLink(gid) {
    await get().runAction(t('detail.copyLink'), async () => {
      await window.api.downloads.copyLink(gid)
      get().pushToast({ title: t('toast.copied'), body: '', tone: 'info' })
    })
  },

  async clearCompleted() {
    await get().runAction(t('toolbar.clearCompleted'), () => window.api.downloads.clearCompleted())
  },

  async pauseAll() {
    await get().runAction(t('toolbar.pauseAll'), () => window.api.downloads.pauseAll())
  },

  async resumeAll() {
    await get().runAction(t('toolbar.resumeAll'), () => window.api.downloads.resumeAll())
  },

  async changeOptions(gid, patch) {
    await get().runAction(t('toast.updateOptions'), () => window.api.downloads.changeOptions(gid, patch))
  },

  async move(gid, position) {
    await get().runAction(t('toast.reorder'), () => window.api.downloads.move(gid, position))
  },

  // ---- history -------------------------------------------------------------

  async queryHistory() {
    try {
      const { search } = get()
      const page = await window.api.history.query({
        search,
        status: 'all',
        category: 'all',
        sort: 'addedAt',
        direction: 'desc',
        offset: 0,
        limit: 500
      })
      set({ historyRows: page.rows, historyTotal: page.total })
    } catch (error) {
      set({ lastActionError: (error as Error).message })
    }
  },

  async deleteHistory(gids) {
    await get().runAction(t('history.delete'), async () => {
      await window.api.history.delete(gids)
      await get().queryHistory()
    })
  },

  async clearHistory() {
    await get().runAction(t('history.clear'), async () => {
      await window.api.history.clear()
      await get().queryHistory()
    })
  },

  /**
   * Wrap an action so failures surface as a toast rather than disappearing, and
   * so `lastActionError` reflects the most recent problem.
   */
  async runAction(label, action) {
    try {
      await action()
      set({ lastActionError: '' })
      return true
    } catch (error) {
      const message = (error as Error).message
      set({ lastActionError: message })
      get().pushToast({ title: t('toast.actionFailed', { action: label }), body: message, tone: 'error' })
      return false
    }
  }
}))

// ---- derived selectors ----------------------------------------------------

const VIEW_MATCHERS: Record<Exclude<ViewKey, 'history' | 'settings'>, (item: DownloadItem) => boolean> = {
  all: () => true,
  active: (item) => item.status === 'active',
  waiting: (item) => item.status === 'waiting',
  paused: (item) => item.status === 'paused',
  complete: (item) => item.status === 'complete',
  error: (item) => item.status === 'error'
}

export function filterItems(state: Pick<AppState, 'items' | 'view' | 'category' | 'search'>): DownloadItem[] {
  if (state.view === 'history' || state.view === 'settings') return []

  const matcher = VIEW_MATCHERS[state.view]
  const needle = state.search.trim().toLowerCase()

  return state.items.filter((item) => {
    if (!matcher(item)) return false
    if (state.category !== 'all' && item.category !== state.category) return false
    if (!needle) return true
    if (item.name.toLowerCase().includes(needle)) return true
    if (item.dir.toLowerCase().includes(needle)) return true
    return item.files.some((file) => file.name.toLowerCase().includes(needle))
  })
}

const STATUS_RANK: Record<DownloadItem['status'], number> = {
  active: 0,
  waiting: 1,
  paused: 2,
  error: 3,
  complete: 4,
  removed: 5
}

export function sortItems(items: DownloadItem[], field: SortField, direction: 'asc' | 'desc'): DownloadItem[] {
  const sign = direction === 'asc' ? 1 : -1

  return [...items].sort((a, b) => {
    // Active rows float to the top regardless of the sort column when sorting by
    // anything other than status: they are what the user is watching.
    if (field !== 'status' && a.status !== b.status) {
      const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      // Keep the live/queued groups above the finished ones even when reversed.
      if (rank !== 0 && (a.status === 'active' || b.status === 'active' || a.status === 'waiting' || b.status === 'waiting')) {
        return rank
      }
    }

    switch (field) {
      case 'name':
        // Collation follows the UI language, so "Ångström" sorts sensibly in
        // both a Chinese and an English list.
        return a.name.localeCompare(b.name, intlLocale(getLocale())) * sign
      case 'size':
        return (a.totalLength - b.totalLength) * sign
      case 'progress': {
        const left = a.totalLength > 0 ? a.completedLength / a.totalLength : 0
        const right = b.totalLength > 0 ? b.completedLength / b.totalLength : 0
        return (left - right) * sign
      }
      case 'speed':
        return (a.downloadSpeed - b.downloadSpeed) * sign
      case 'eta': {
        const left =
          a.downloadSpeed > 0 ? (a.totalLength - a.completedLength) / a.downloadSpeed : Number.MAX_SAFE_INTEGER
        const right =
          b.downloadSpeed > 0 ? (b.totalLength - b.completedLength) / b.downloadSpeed : Number.MAX_SAFE_INTEGER
        return (left - right) * sign
      }
      case 'status':
        return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * sign
      default:
        return (a.addedAt - b.addedAt) * sign
    }
  })
}

export function selectedItems(state: Pick<AppState, 'items' | 'selection'>): DownloadItem[] {
  const wanted = new Set(state.selection)
  return state.items.filter((item) => wanted.has(item.gid))
}


export function categoryCounts(items: DownloadItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    counts[item.category] = (counts[item.category] ?? 0) + 1
  }
  return counts
}
