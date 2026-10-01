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
  onSelect(gid: string, additive: boolean): void
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

function DownloadRowImpl({ item, selected, onSelect, onOpenDetail, onAction }: DownloadRowProps): JSX.Element {
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
      aria-selected={selected}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => onSelect(item.gid, event.ctrlKey || event.metaKey || event.shiftKey)}
      onDoubleClick={() => onOpenDetail(item.gid)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpenDetail(item.gid)
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
      <div className="flex items-center justify-center">
        <button
          type="button"
          aria-label={selected ? t('table.deselect') : t('table.select')}
          onClick={(event) => {
            event.stopPropagation()
            onSelect(item.gid, true)
          }}
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
      <div className="min-w-0">
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
            title={kindLabel(item.kind)}
          >
            {kindGlyph(item.kind)}
          </span>
          <span className="truncate font-medium text-fg" title={item.name}>
            {item.name}
          </span>
          {item.numFiles > 1 && (
            <span
              className="chip bg-line/70 text-faint"
              title={t('table.fileCount', { count: item.numFiles })}
            >
              {t('table.filesShort', { count: item.numFiles })}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate pl-7 text-[11px] text-faint" title={hostOf(item)}>
          {hostOf(item)}
          {item.kind === 'bittorrent' &&
            item.numSeeders > 0 &&
            ` · ${t('table.seeding', { count: item.numSeeders })}`}
        </div>
      </div>

      {/* Size */}
      <div className="text-tabular truncate text-right text-muted" title={sizeText}>
        {item.totalLength > 0 ? formatBytes(item.totalLength) : '—'}
      </div>

      {/* Progress */}
      <div className="min-w-0">
        <ProgressBar
          fraction={fraction}
          status={item.status}
          indeterminate={item.metadataPending || (isActive && item.totalLength === 0)}
        />
        <div className="mt-1 flex items-center justify-between text-[11px]">
          <span className="text-tabular text-muted">
            {item.metadataPending
              ? t('table.metadataPending')
              : item.totalLength > 0
                ? formatPercent(fraction)
                : '—'}
          </span>
          <span className="text-tabular text-faint">
            {item.totalLength > 0 ? formatBytes(item.completedLength) : formatBytes(item.completedLength)}
          </span>
        </div>
      </div>

      {/* Speed */}
      <div className="text-tabular text-right">
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
      <div className="text-tabular text-right text-muted">
        {isActive ? formatEta(eta) : isComplete ? '—' : item.status === 'waiting' ? `#${item.queuePosition + 1}` : '—'}
      </div>

      {/* Connections */}
      <div className="text-tabular text-right text-muted" title={t('table.connectionsHint')}>
        {item.connections > 0 ? item.connections : '—'}
      </div>

      {/* Status */}
      <div className="flex justify-start">
        <StatusBadge item={item} />
      </div>

      {/* Actions */}
      <div
        className={cn('flex items-center justify-end gap-0.5', hovered || selected ? 'opacity-100' : 'opacity-0')}
        onClick={(event) => event.stopPropagation()}
      >
        {!isComplete && (
          <IconButton
            label={primaryAction.label}
            icon={primaryAction.icon}
            onClick={() => onAction(primaryAction.key, item.gid)}
          />
        )}
        {isError && (
          <IconButton
            label={t('table.viewMore')}
            icon={<MoreHorizontal size={14} />}
            onClick={() => onOpenDetail(item.gid)}
          />
        )}
        {canOpen && (
          <>
            <IconButton
              label={t('table.openFile')}
              icon={<ExternalLink size={14} />}
              disabled={!isComplete}
              onClick={() => onAction('open', item.gid)}
            />
            <IconButton
              label={t('table.openFolder')}
              icon={<FolderOpen size={14} />}
              onClick={() => onAction('folder', item.gid)}
            />
          </>
        )}
        <IconButton label={t('common.remove')} icon={<Trash2 size={14} />} onClick={() => onAction('remove', item.gid)} />
      </div>
    </div>
  )
}

export const DownloadRow = memo(DownloadRowImpl)
