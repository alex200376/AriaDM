import {
  Archive,
  Boxes,
  Eraser,
  FileText,
  Film,
  Gauge,
  Image as ImageIcon,
  MoreHorizontal,
  Music,
  Package,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { ReactElement } from 'react'

import { formatBytes, formatSpeed } from '@shared/format'
import { t } from '@shared/i18n'

import { useApp } from '../../store/app-store'
import { Button, IconButton, Input } from '../ui/primitives'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/**
 * Speed limit presets offered directly in the toolbar.
 *
 * Built per render rather than at module scope because the first entry's label
 * is translated and the language can change while the app is open.
 */
const LIMIT_VALUES = [0, 20 * 1024 * 1024, 10 * 1024 * 1024, 5 * 1024 * 1024, 1024 * 1024, 256 * 1024]

const LIMIT_LABELS = ['20 MB/s', '10 MB/s', '5 MB/s', '1 MB/s', '256 KB/s']

function limitPresets(): { label: string; value: number }[] {
  return LIMIT_VALUES.map((value, index) => ({
    value,
    label: index === 0 ? t('common.unlimited') : LIMIT_LABELS[index - 1]!
  }))
}

/** The "no filter" option value. Matches the store's default for `category`. */
const ALL_CATEGORIES = 'all'

/**
 * Icons per built-in category id.
 *
 * The category filter used to be a list in the sidebar, where these made it
 * scannable. A dropdown keeps the same recognition cue with far less chrome.
 */
const CATEGORY_ICONS: Record<string, ReactElement> = {
  video: <Film size={14} />,
  audio: <Music size={14} />,
  archive: <Archive size={14} />,
  document: <FileText size={14} />,
  program: <Package size={14} />,
  image: <ImageIcon size={14} />,
  torrent: <Radio size={14} />,
  other: <Boxes size={14} />
}

/**
 * The queue toolbar.
 *
 * Only what a user reaches for constantly stays on screen — adding a download,
 * the category filter and the search box. Everything that acts on the whole
 * queue lives in the `⋯` menu, which keeps the row from growing with every new
 * feature (and keeps it usable in a small window).
 *
 * It is rendered inside the caption row (see `TitleBar`), so the controls are
 * marked `no-drag` individually and the gaps between them keep dragging the
 * window. Marking the whole row instead would leave nothing to grab.
 */
export function Toolbar(): JSX.Element {
  const selection = useApp((state) => state.selection)
  const items = useApp((state) => state.items)
  const search = useApp((state) => state.search)
  const category = useApp((state) => state.category)
  const settings = useApp((state) => state.settings)
  const global = useApp((state) => state.global)
  const setSearch = useApp((state) => state.setSearch)
  const setCategory = useApp((state) => state.setCategory)
  const openDialog = useApp((state) => state.openDialog)
  const pauseAll = useApp((state) => state.pauseAll)
  const resumeAll = useApp((state) => state.resumeAll)
  const removeGids = useApp((state) => state.removeGids)
  const clearCompleted = useApp((state) => state.clearCompleted)
  const patchSettings = useApp((state) => state.patchSettings)

  const hasSelection = selection.length > 0
  const limit = settings?.globalDownloadLimit ?? 0
  const limits = limitPresets()
  const limitIsCustom = !limits.some((entry) => entry.value === limit)

  const actionsDisabled = global.numActive === 0 && global.numWaiting === 0

  // Categories come from the user's own list. "Other" is a real rule that a user
  // may have deleted, so it is added back when missing: uncategorised downloads
  // land there and would otherwise be unreachable now that the sidebar list is
  // gone.
  const configured = settings?.categories ?? []
  const categoryRows = [
    ...configured.map((entry) => ({ id: entry.id, name: entry.name })),
    ...(configured.some((entry) => entry.id === 'other') ? [] : [{ id: 'other', name: t('category.other') }])
  ].map((entry) => ({ ...entry, count: items.filter((item) => item.category === entry.id).length }))
  // Empty categories are noise in a filter, but the active one always stays put
  // so the trigger keeps naming what is being filtered.
  const activeCategory = categoryRows.find((entry) => entry.id === category)
  const allLabel = t('toolbar.categoryAll')
  const activeLabel = category === ALL_CATEGORIES ? allLabel : (activeCategory?.name ?? allLabel)

  // A selected row that is still moving is the only place the remaining size and
  // the aggregate rate are both meaningful, so they are computed rather than
  // stored.
  const selectedItems = items.filter((item) => selection.includes(item.gid))
  const selectedRemaining = selectedItems.reduce(
    (sum, item) => sum + Math.max(0, item.totalLength - item.completedLength),
    0
  )
  const selectedSpeed = selectedItems.reduce((sum, item) => sum + item.downloadSpeed, 0)

  return (
    /* `flex-[1_1_30rem]`: beside the caption when the window is wide enough, on
       its own line below it when it is not. */
    <div className="flex min-w-0 flex-[1_1_30rem] items-center gap-1.5 overflow-hidden">
      <Button
        variant="primary"
        size="sm"
        className="no-drag"
        icon={<Plus size={14} />}
        onClick={() => openDialog('add')}
      >
        {t('toolbar.add')}
      </Button>

      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger
          aria-label={t('toolbar.category')}
          className="no-drag h-7 w-auto min-w-[7.5rem] max-w-[11rem] shrink gap-1.5 px-2.5 text-[12px]"
        >
          {/* Radix mirrors the selected item's children into `SelectValue` when
              it has none of its own, which put the icon and the count on screen
              twice. Passing plain text opts out of that and keeps one icon. */}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-faint">{CATEGORY_ICONS[category] ?? <Boxes size={13} />}</span>
            <SelectValue>{activeLabel}</SelectValue>
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-[12rem]">
          <SelectItem value={ALL_CATEGORIES}>
            <span className="flex w-full items-center gap-2">
              <Boxes size={14} className="text-faint" />
              {allLabel}
              <span className="text-tabular ml-auto text-[11px] text-faint">{items.length}</span>
            </span>
          </SelectItem>
          {categoryRows
            .filter((entry) => entry.count > 0 || entry.id === category)
            .map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              <span className="flex w-full items-center gap-2">
                <span className="text-faint">{CATEGORY_ICONS[entry.id] ?? <Boxes size={14} />}</span>
                {entry.name}
                <span className="text-tabular ml-auto text-[11px] text-faint">{entry.count}</span>
                </span>
              </SelectItem>
            ))}
        </SelectContent>
      </Select>

      {category !== ALL_CATEGORIES && (
        <IconButton
          label={t('toolbar.categoryClear')}
          className="no-drag"
          icon={<X size={13} />}
          onClick={() => setCategory(ALL_CATEGORIES)}
        />
      )}

      {hasSelection && (
        <>
          {/* The separator belongs to the summary beside it, so both step aside
              together in a narrow window. */}
          <div className="toolbar-compact mx-0.5 h-5 w-px bg-line" />
          {/* Shrinks and ellipsises before anything can be pushed off the row;
              the numbers after the count are the part worth losing. */}
          <span className="text-tabular min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted">
            {t('toolbar.selected', { count: selection.length })}
            {selectedRemaining > 0 && ` · ${t('toolbar.selectedRemaining', { size: formatBytes(selectedRemaining) })}`}
            {selectedSpeed > 0 && ` · ${formatSpeed(selectedSpeed)}`}
          </span>
          <Button
            variant="danger"
            size="sm"
            className="no-drag"
            icon={<Trash2 size={13} />}
            onClick={() => void removeGids(selection, false)}
          >
            {t('toolbar.remove')}
          </Button>
          <IconButton
            label={t('toolbar.deselect')}
            className="no-drag"
            icon={<X size={14} />}
            onClick={() => useApp.getState().setSelection([])}
          />
        </>
      )}

      {/* Pushes the search and the queue-wide controls to the right; `min-w-0`
          lets it vanish rather than squeeze them when the window is tight. */}
      <div className="min-w-0 flex-1" />

      {/* Keeps its full width when there is room and gives it back first when
          there is not, which is what keeps the row on one line: everything else
          here is a button that has to stay legible and clickable. */}
      <div className="no-drag toolbar-search relative min-w-[4.5rem]">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('toolbar.search')}
          className="h-8 pl-8 pr-7 text-[12px]"
        />
        {search && (
          <button
            type="button"
            aria-label={t('toolbar.searchClear')}
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-fg"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <Select
        value={limitIsCustom ? 'custom' : String(limit)}
        onValueChange={(value) => {
          if (value === 'custom') return
          void patchSettings({ globalDownloadLimit: Number(value) })
        }}
      >
        <SelectTrigger
          aria-label={t('toolbar.limit')}
          className="no-drag h-8 w-auto shrink-0 gap-1.5 px-2.5 text-[12px]"
        >
          <span className="flex items-center gap-1.5">
            <Gauge size={13} className="text-faint" />
            {/* The gauge alone still says what this control is, and the trigger
                keeps its `aria-label`, so a narrow window loses the word rather
                than the control. */}
            <span className="toolbar-compact">
              <SelectValue />
            </span>
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-[11rem]">
          {limits.map((entry) => (
            <SelectItem key={entry.value} value={String(entry.value)}>
              {entry.label}
            </SelectItem>
          ))}
          {limitIsCustom && <SelectItem value="custom">{formatSpeed(limit)}</SelectItem>}
        </SelectContent>
      </Select>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('toolbar.more')} className="no-drag" icon={<MoreHorizontal size={15} />} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={actionsDisabled} onSelect={() => void resumeAll()}>
            <Play size={14} className="text-faint" />
            {t('toolbar.resumeAll')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={actionsDisabled} onSelect={() => void pauseAll()}>
            <Pause size={14} className="text-faint" />
            {t('toolbar.pauseAll')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void clearCompleted()}>
            <Eraser size={14} className="text-faint" />
            {t('toolbar.clearCompleted')}
          </DropdownMenuItem>

          {hasSelection && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => void removeGids(selection, true)}>
                <Trash2 size={14} />
                {t('toolbar.removeWithFiles')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
