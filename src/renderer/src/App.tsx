import { AlertTriangle, ArrowDownToLine, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { t } from '@shared/i18n'

import { filterItems, sortItems, useApp } from './store/app-store'
import { useFocusResync, useLiveData } from './lib/useLiveData'
// Subscribed to at the root on purpose: a language change must re-render the
// whole tree, because most components translate through the module-level `t`.
import { useLocale } from './lib/i18n'
import { CommandPalette } from './components/CommandPalette'
import { DetailDrawer } from './components/detail/DetailDrawer'
import { AddUrlDialog } from './components/dialogs/AddUrlDialog'
import { ExtensionDialog } from './components/dialogs/ExtensionDialog'
import { DownloadTable } from './components/downloads/DownloadTable'
import { HistoryView } from './components/history/HistoryView'
import { SettingsView } from './components/settings/SettingsView'
import { Sidebar } from './components/layout/Sidebar'
import { StatusBar } from './components/layout/StatusBar'
import { TitleBar } from './components/layout/TitleBar'
import { Toolbar } from './components/layout/Toolbar'
import { Toasts } from './components/Toasts'
import { Button, Spinner } from './components/ui/primitives'

/** Read a dropped file as base64 so a torrent can go straight to the engine. */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function EngineBanner(): JSX.Element | null {
  const engine = useApp((state) => state.engine)
  if (engine.state !== 'failed') return null

  return (
    <div className="flex items-start gap-3 border-b border-danger/30 bg-danger/10 px-3 py-2.5">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium text-danger">{t('app.aria2Failed')}</p>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-danger/90">{engine.lastError || engine.message}</p>
      </div>
      <Button
        variant="danger"
        size="sm"
        icon={<RefreshCw size={13} />}
        onClick={() =>
          void useApp.getState().runAction(t('command.restartEngine'), () => window.api.engine.restart())
        }
      >
        {t('common.retry')}
      </Button>
    </div>
  )
}

export default function App(): JSX.Element {
  useLiveData()
  useFocusResync()
  useLocale()

  const ready = useApp((state) => state.ready)
  const bootstrapError = useApp((state) => state.bootstrapError)
  const view = useApp((state) => state.view)
  const items = useApp((state) => state.items)
  const category = useApp((state) => state.category)
  const search = useApp((state) => state.search)
  const sortField = useApp((state) => state.sortField)
  const sortDirection = useApp((state) => state.sortDirection)
  const detailGid = useApp((state) => state.detailGid)
  const settings = useApp((state) => state.settings)

  const [dropping, setDropping] = useState(false)

  const visible = useMemo(() => {
    const filtered = filterItems({ items, view, category, search })
    return sortItems(filtered, sortField, sortDirection)
  }, [items, view, category, search, sortField, sortDirection])

  const addDownload = useApp((state) => state.addDownload)
  const pushToast = useApp((state) => state.pushToast)

  // Window-level drop handling: a dropped .torrent becomes a download directly,
  // because the renderer can read the file without any extra IPC surface.
  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      setDropping(true)
    }
    const onDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget) return
      setDropping(false)
    }
    const onDrop = async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      setDropping(false)
      const files = Array.from(event.dataTransfer?.files ?? [])
      const torrent = files.find((file) => file.name.toLowerCase().endsWith('.torrent'))
      if (!torrent || !settings) return

      try {
        const base64 = await fileToBase64(torrent)
        await addDownload({
          uris: [],
          out: torrent.name.replace(/\.torrent$/i, ''),
          dir: settings.downloadDir,
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
          source: 'file',
          torrentBase64: base64,
          metalinkBase64: null,
          allowDuplicate: false,
          engine: 'auto'
        })
      } catch (error) {
        pushToast({ title: t('toast.torrentReadFailed'), body: (error as Error).message, tone: 'error' })
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addDownload, pushToast, settings])

  // Keyboard shortcuts for the most common operations.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const inField =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable === true

      const store = useApp.getState()
      const selection = store.selection

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        store.openDialog('add')
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !inField) {
        event.preventDefault()
        store.selectAll(visible.map((item) => item.gid))
        return
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>(`input[placeholder="${t('toolbar.search')}"]`)?.focus()
        return
      }

      if (inField) return

      if (event.key === ' ' && selection.length > 0) {
        event.preventDefault()
        const chosen = items.filter((item) => selection.includes(item.gid))
        const anyRunning = chosen.some((item) => item.status === 'active')
        void (anyRunning ? store.pauseGids(selection) : store.resumeGids(selection))
        return
      }

      if (event.key === 'Delete' && selection.length > 0) {
        event.preventDefault()
        void store.removeGids(selection, false)
        return
      }

      if (event.key === 'Enter' && selection.length === 1) {
        event.preventDefault()
        store.openDetail(selection[0]!)
        return
      }

      if (event.key === 'Escape') {
        store.openDetail(null)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [items, visible])

  // One update check per launch. Running it here rather than in the main process
  // keeps the toast in the user's language, since only the renderer knows the
  // resolved locale. A failure is silent on purpose: the About tab still offers
  // a manual check that surfaces the error.
  useEffect(() => {
    let cancelled = false
    void window.api.update
      .check()
      .then((info) => {
        if (cancelled || !info.available || !info.latest) return
        pushToast({
          title: t('toast.update.title'),
          body: t('toast.update.body', { version: info.latest }),
          tone: 'info'
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pushToast])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner />
        <span className="text-[13px]">{t('app.starting')}</span>
      </div>
    )
  }

  if (bootstrapError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
        <AlertTriangle size={24} className="text-danger" />
        <p className="text-[14px] font-medium text-fg">{t('app.bootstrapFailed')}</p>
        <p className="max-w-lg text-[12px] leading-relaxed text-muted" data-selectable>
          {bootstrapError}
        </p>
      </div>
    )
  }

  const emptyAction = (
    <Button variant="primary" size="sm" icon={<ArrowDownToLine size={14} />} onClick={() => useApp.getState().openDialog('add')}>
      {t('toolbar.add')}
    </Button>
  )

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <TitleBar />
      <EngineBanner />

      {/* `relative` anchors the detail drawer, which floats over the list instead
          of shrinking it when the window is narrow. The `data-detail` flag lets
          the stylesheet drop queue columns while that panel is docked. */}
      <div className="relative flex min-h-0 flex-1" data-detail={detailGid !== null ? 'open' : 'closed'}>
        <Sidebar />

        <main className="flex min-w-0 flex-1 flex-col">
          {(view === 'all' || view === 'active' || view === 'waiting' || view === 'paused' || view === 'complete' || view === 'error') && (
            <>
              <Toolbar />
              <DownloadTable items={visible} emptyAction={emptyAction} />
            </>
          )}

          {view === 'history' && <HistoryView />}
          {view === 'settings' && <SettingsView />}
        </main>

        <DetailDrawer />
      </div>

      <StatusBar />

      <AddUrlDialog />
      <ExtensionDialog />
      <CommandPalette />
      <Toasts />

      {dropping && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-brand/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-brand bg-surface/95 px-8 py-6 text-center shadow-2xl">
            <ArrowDownToLine size={26} className="mx-auto text-brand" />
            <p className="mt-2 text-[13px] font-medium text-fg">{t('app.dropHint')}</p>
            <p className="mt-0.5 text-[11.5px] text-muted">{t('app.dropSupport')}</p>
          </div>
        </div>
      )}

      {detailGid !== null && <div className="sr-only">{t('app.detailOpen')}</div>}
    </div>
  )
}
