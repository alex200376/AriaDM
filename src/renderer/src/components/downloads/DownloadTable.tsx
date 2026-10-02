import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, Inbox, Minus } from 'lucide-react'
import { useRef, type ReactNode } from 'react'

import type { DownloadItem } from '@shared/download'
import { t } from '@shared/i18n'
import { nextSelectionAfterSelectAll } from '@shared/selection'

import { useApp, type SortField } from '../../store/app-store'
import { cn } from '../../lib/cn'
import { EmptyState } from '../ui/primitives'

import { DownloadRow } from './DownloadRow'

const ROW_HEIGHT: Record<string, number> = {
  compact: 46,
  comfortable: 60,
  roomy: 72
}

interface Column {
  key: SortField | null
  label: string
  className?: string
}

/**
 * Header cells, in the order the stylesheet's `.queue-grid` expects.
 *
 * Labels are resolved at render time rather than baked in here, so switching
 * language does not need a reload.
 */
const COLUMNS: Column[] = [
  { key: null, label: '', className: 'justify-center' },
  { key: 'name', label: 'name' },
  { key: 'size', label: 'size', className: 'text-right' },
  { key: 'progress', label: 'progress' },
  { key: 'speed', label: 'speed', className: 'text-right' },
  { key: 'eta', label: 'eta', className: 'text-right' },
  { key: null, label: 'connections', className: 'text-right' },
  { key: 'status', label: 'status' },
  { key: null, label: '', className: 'text-right' }
]

const COLUMN_LABELS: Record<string, () => string> = {
  name: () => t('table.name'),
  size: () => t('table.size'),
  progress: () => t('table.progress'),
  speed: () => t('table.speed'),
  eta: () => t('table.eta'),
  connections: () => t('table.connections'),
  status: () => t('table.status')
}

export function DownloadTable({
  items,
  emptyAction
}: {
  items: DownloadItem[]
  emptyAction?: ReactNode
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  const density = useApp((state) => state.settings?.density ?? 'comfortable')
  const sortField = useApp((state) => state.sortField)
  const sortDirection = useApp((state) => state.sortDirection)
  const selection = useApp((state) => state.selection)
  const toggleSort = useApp((state) => state.toggleSort)
  const toggleSelected = useApp((state) => state.toggleSelected)
  const selectAll = useApp((state) => state.selectAll)
  const openDetail = useApp((state) => state.openDetail)
  const removeGids = useApp((state) => state.removeGids)
  const pauseGids = useApp((state) => state.pauseGids)
  const resumeGids = useApp((state) => state.resumeGids)
  const retryGids = useApp((state) => state.retryGids)
  const openFile = useApp((state) => state.openFile)
  const showInFolder = useApp((state) => state.showInFolder)

  const rowHeight = ROW_HEIGHT[density] ?? 60
  const selectedSet = new Set(selection)

  // The header checkbox reflects the rows that are actually rendered: "all" for
  // this control means everything the current search and category leave visible,
  // which is the same set `Ctrl+A` acts on. A partially selected list still
  // counts as neither, so it draws the indeterminate dash.
  const allSelected = items.length > 0 && items.every((item) => selectedSet.has(item.gid))
  const someSelected = items.some((item) => selectedSet.has(item.gid))
  const headerLabel = allSelected ? t('table.clearSelection') : t('table.selectAll')

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8
  })

  const handleAction = (
    action: 'pause' | 'resume' | 'retry' | 'remove' | 'open' | 'folder',
    gid: string
  ): void => {
    switch (action) {
      case 'pause':
        void pauseGids([gid])
        break
      case 'resume':
        void resumeGids([gid])
        break
      case 'retry':
        void retryGids([gid])
        break
      case 'remove':
        void removeGids([gid], false)
        break
      case 'open':
        void openFile(gid)
        break
      case 'folder':
        void showInFolder(gid)
        break
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="row"
        className="queue-grid grid shrink-0 items-center gap-3 border-b border-line bg-surface/60 px-3 py-2 text-[11px] font-medium text-faint"
      >
        {COLUMNS.map((column, index) => {
          const label = COLUMN_LABELS[column.label]?.() ?? ''
          // The first column holds the select-all control instead of a heading.
          if (index === 0) {
            return (
              <div key="select-all" className={cn('flex items-center gap-1', column.className)}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
                  aria-label={headerLabel}
                  title={headerLabel}
                  disabled={items.length === 0}
                  onClick={() => selectAll(nextSelectionAfterSelectAll(selection, items.map((item) => item.gid)))}
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-[5px] border transition-colors',
                    allSelected
                      ? 'border-brand bg-brand text-brand-fg'
                      : someSelected
                        ? 'border-brand bg-brand/25 text-brand'
                        : 'border-line hover:border-faint/70',
                    items.length === 0 && 'cursor-not-allowed opacity-40'
                  )}
                >
                  {allSelected ? (
                    <Check size={11} strokeWidth={3} />
                  ) : someSelected ? (
                    <Minus size={11} strokeWidth={3} />
                  ) : null}
                </button>
              </div>
            )
          }
          return (
            <div key={`${column.label}-${index}`} className={cn('flex items-center gap-1', column.className)}>
              {column.key ? (
                <button
                  type="button"
                  onClick={() => toggleSort(column.key as SortField)}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-fg',
                    sortField === column.key && 'text-brand'
                  )}
                >
                  {label}
                  {sortField === column.key && (
                    <span className="text-[9px] leading-none">{sortDirection === 'asc' ? '▲' : '▼'}</span>
                  )}
                </button>
              ) : (
                label
              )}
            </div>
          )
        })}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title={t('table.empty.title')}
            body={t('table.empty.body')}
            action={emptyAction}
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index]!
              return (
                <div
                  key={item.gid}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <DownloadRow
                    item={item}
                    selected={selectedSet.has(item.gid)}
                    onSelect={toggleSelected}
                    onOpenDetail={openDetail}
                    onAction={handleAction}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
