import { Check, ExternalLink, FolderOpen, MoreHorizontal, Pause, Play, RotateCw, Trash2 } from 'lucide-react'
import { memo, useState } from 'react'

import type { DownloadItem } from '@shared/download'
import { etaOf, progressOf } from '@shared/download'
import { formatBytes, formatBytesPair, formatEta, formatPercent, formatSpeed } from '@shared/format'

import { cn } from '../../lib/cn'
import { useEasedNumber } from '../../hooks/useEased'
// `memo` means the parent re-rendering is not enough, so this row subscribes to
// the language itself through the hook rather than the module-level `t`.
import { useTranslation } from '../../lib/i18n'
import { kindGlyph, kindLabel } from '../../lib/labels'
import { IconButton } from '../ui/primitives'

import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

// The column template is `.queue-grid` in globals.css: it is responsive, which a
// JS constant cannot be.

export interface DownloadRowProps {
  item: DownloadItem
  selected: boolean
  /** Position in the rendered list; drives roving focus and the ARIA row index. */
  index: number
  /** One row is tabbable at a time; the rest are reached with the arrow keys. */
  tabIndex: number
  /** Whether this row owns the roving focus; its controls follow the row. */
  active: boolean
  onFocusRow(index: number): void
  onNavigate(kind: 'up' | 'down' | 'home' | 'end'): void
  /** Only the checkbox toggles the selection; clicking the row itself does not. */
  onToggleSelected(gid: string): void
  onOpenDetail(gid: string): void
  onAction(action: 'pause' | 'resume' | 'retry' | 'remove' | 'open' | 'folder', gid: string): void
}

function hostOf(item: DownloadItem): string {
  const uri = item.files[0]?.uris?.[0]?.uri
  if (!uri) return item.dir
  try {
    return new URL(uri).host
  } catch {
    return item.dir
  }
}

function DownloadRowImpl({
  item,
  selected,
  index,
  tabIndex,
  active,
  onFocusRow,
  onNavigate,
  onToggleSelected,
  onOpenDetail,
  onAction
}: DownloadRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const { t } = useTranslation()

  const fraction = progressOf(item)
  const eta = etaOf(item)
  const easedSpeed = useEasedNumber(item.downloadSpeed)
  const easedUpload = useEasedNumber(item.uploadSpeed)

  const isActive = item.status === 'active'
  const isComplete = item.status === 'complete'
  const isError = item.status === 'error'
  const canOpen = item.files.some((file) => file.path.length > 0) || item.dir.length > 0

  const primaryAction = isActive
    ? { key: 'pause' as const, label: t('table.pause'), icon: <Pause size={13} /> }
    : isError
      ? { key: 'retry' as const, label: t('common.retry'), icon: <RotateCw size={13} /> }
      : { key: 'resume' as const, label: t('table.resume'), icon: <Play size={13} /> }

  const sizeText =
    item.totalLength > 0 ? formatBytesPair(item.completedLength, item.totalLength) : formatBytes(item.completedLength)

  return (
    <div
      role="row"
      // The header is row 1, so the first item is row 2.
      aria-rowindex={index + 2}
      data-row-index={index}
      tabIndex={tabIndex}
      onFocus={() => onFocusRow(index)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={() => onOpenDetail(item.gid)}
      onKeyDown={(event) => {
        // Only when the row itself has focus: Enter on one of its buttons must
        // press that button, not open the details panel behind it.
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter') {
          onOpenDetail(item.gid)
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          onNavigate('down')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          onNavigate('up')
        } else if (event.key === 'Home') {
          event.preventDefault()
          onNavigate('home')
        } else if (event.key === 'End') {
          event.preventDefault()
          onNavigate('end')
        }
      }}
      className={cn(
        'row-hover queue-grid grid items-center gap-3 border-b border-line/60 px-3 text-[12.5px]',
        'cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60',
        selected ? 'bg-brand/12' : hovered ? 'bg-line/30' : '',
        item.status === 'complete' && 'text-muted'
      )}
      style={{ height: 'var(--row-height)' }}
    >
      {/* Selection */}
      <div role="cell" className="flex items-center justify-center">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? t('table.deselect') : t('table.select')}
          tabIndex={active ? 0 : -1}
          onClick={() => onToggleSelected(item.gid)}
          // `dblclick` is a separate event from `click`, so without this a
          // double-click on the checkbox bubbles up to the row and opens the
          // details panel on top of the two toggles.
          onDoubleClick={(event) => event.stopPropagation()}
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-[5px] border transition-colors',
            selected
              ? 'border-brand bg-brand text-brand-fg'
              : hovered
                ? 'border-faint/70'
                : 'border-line'
          )}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </button>
      </div>

      {/* Name */}
      <div role="cell" className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'grid h-5 w-5 shrink-0 place-items-center rounded text-[11px]',
              item.kind === 'bittorrent'
                ? 'bg-ok/15 text-ok'
                : item.kind === 'media'
                  ? 'bg-warn/15 text-warn'
                  : 'bg-info/15 text-info'
            )}
            data-tip={kindLabel(item.kind)}
          >
            {kindGlyph(item.kind)}
          </span>
          <span className="truncate font-medium text-fg" data-tip={item.name}>
            {item.name}
          </span>
          {item.numFiles > 1 && (
            <span
              className="chip bg-line/70 text-faint"
              data-tip={t('table.fileCount', { count: item.numFiles })}
            >
              {t('table.filesShort', { count: item.numFiles })}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate pl-7 text-[11px] text-faint" data-tip={hostOf(item)}>
          {hostOf(item)}
          {item.kind === 'bittorrent' &&
            item.numSeeders > 0 &&
            ` · ${t('table.seeding', { count: item.numSeeders })}`}
        </div>
      </div>

      {/* Size */}
      <div role="cell" className="text-tabular truncate text-right text-muted" data-tip={sizeText}>
        {item.totalLength > 0 ? formatBytes(item.totalLength) : '—'}
      </div>

      {/* Progress */}
      <div role="cell" className="min-w-0">
        <ProgressBar
          fraction={fraction}
          status={item.status}
          indeterminate={item.metadataPending || (isActive && item.totalLength === 0)}
        />
        <div className="queue-progress-meta mt-1 flex items-center justify-between gap-2 text-[11px]">
          <span className="text-tabular text-muted">
            {item.metadataPending
              ? t('table.metadataPending')
              : item.totalLength > 0
                ? formatPercent(fraction)
                : '—'}
          </span>
          <span className="queue-bytes text-tabular text-faint">
            {item.totalLength > 0 ? formatBytes(item.completedLength) : formatBytes(item.completedLength)}
          </span>
          {/* The 5-column layout has no speed track, so the number moves here
              instead of disappearing. `.queue-progress-meta:has(...)` in
              globals.css hides the byte count only when this is rendered. */}
          {isActive && (
            <span className="queue-inline-speed text-tabular text-fg">
              {item.verifyIntegrityPending ? t('table.verifying') : formatSpeed(easedSpeed)}
            </span>
          )}
        </div>
      </div>

      {/* Speed */}
      <div role="cell" className="text-tabular text-right">
        {isActive && easedSpeed > 0 ? (
          <span className="text-fg">{formatSpeed(easedSpeed)}</span>
        ) : isActive && item.verifyIntegrityPending ? (
          <span className="text-warn">{t('table.verifying')}</span>
        ) : (
          <span className="text-faint">—</span>
        )}
        {item.uploadSpeed > 0 && (
          <div className="text-[10.5px] text-info">↑ {formatSpeed(easedUpload)}</div>
        )}
      </div>

      {/* ETA */}
      <div role="cell" className="text-tabular text-right text-muted">
        {isActive ? formatEta(eta) : isComplete ? '—' : item.status === 'waiting' ? `#${item.queuePosition + 1}` : '—'}
      </div>

      {/* Connections */}
      <div role="cell" className="text-tabular text-right text-muted" data-tip={t('table.connectionsHint')}>
        {item.connections > 0 ? item.connections : '—'}
      </div>

      {/* Status. `overflow-hidden` is a backstop: the column is sized for the
          longest label, and if a translation ever outgrows it the badge clips
          instead of painting over the action buttons beside it. */}
      <div role="cell" className="flex min-w-0 justify-start overflow-hidden">
        <StatusBadge item={item} />
      </div>

      {/* Actions */}
      {/* Focus-within matters as much as hover: the buttons are tabbable, and
          an invisible 28px target is one a keyboard user cannot see they are on. */}
      <div
        role="cell"
        className={cn(
          'flex items-center justify-end gap-0.5 focus-within:opacity-100',
          hovered || selected ? 'opacity-100' : 'opacity-0'
        )}
        // Double-clicking a button is two presses of that button, not a request
        // to open the details panel behind it.
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {!isComplete && (
          <IconButton
            label={primaryAction.label}
            icon={primaryAction.icon}
            tabIndex={active ? 0 : -1}
            onClick={() => onAction(primaryAction.key, item.gid)}
          />
        )}
        {isError && (
          <IconButton
            label={t('table.viewMore')}
            icon={<MoreHorizontal size={14} />}
            tabIndex={active ? 0 : -1}
            onClick={() => onOpenDetail(item.gid)}
          />
        )}
        {canOpen && (
          <>
            {/* Only once there is a file to open. Rendering this disabled for an
                unfinished download added a fifth button to an errored row, which
                is what used to overflow the column. */}
            {isComplete && (
              <IconButton
                label={t('table.openFile')}
                icon={<ExternalLink size={14} />}
                tabIndex={active ? 0 : -1}
                onClick={() => onAction('open', item.gid)}
              />
            )}
            <IconButton
              label={t('table.openFolder')}
              icon={<FolderOpen size={14} />}
              tabIndex={active ? 0 : -1}
              onClick={() => onAction('folder', item.gid)}
            />
          </>
        )}
        <IconButton
          label={t('common.remove')}
          icon={<Trash2 size={14} />}
          tabIndex={active ? 0 : -1}
          onClick={() => onAction('remove', item.gid)}
        />
      </div>
    </div>
  )
}

export const DownloadRow = memo(DownloadRowImpl)
