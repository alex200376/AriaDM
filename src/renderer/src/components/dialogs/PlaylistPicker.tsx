import { CheckSquare, Loader2, Square } from 'lucide-react'
import { useEffect, useState } from 'react'

import { formatEta } from '@shared/format'
import { t } from '@shared/i18n'
import type { MediaPlaylistEntry } from '@shared/settings'

import { cn } from '../../lib/cn'
import { Button, Input, Modal } from '../ui/primitives'

/**
 * Choose which items of a playlist to download.
 *
 * The dialog this replaces had one all-or-nothing switch, so a 200-video channel
 * was either everything or nothing. Here the common case is preselected (all of
 * it, unchecking the few unwanted items), a whole range can be set at once, and
 * the count is always visible before anything is queued.
 *
 * Positions are 1-based, matching what the user sees and what yt-dlp's
 * `--playlist-items` expects.
 */
export interface PlaylistPickerProps {
  open: boolean
  loading: boolean
  /** The playlist's title, when the probe reported one. */
  title: string
  entries: MediaPlaylistEntry[]
  onClose(): void
  onConfirm(indices: number[]): void
}

export function PlaylistPicker({
  open,
  loading,
  title,
  entries,
  onClose,
  onConfirm
}: PlaylistPickerProps): JSX.Element | null {
  const [selected, setSelected] = useState<number[]>([])
  const [rangeFrom, setRangeFrom] = useState('')
  const [rangeTo, setRangeTo] = useState('')

  // Everything starts ticked: a subset was impossible before, and starting from
  // "all" means the unchecked ones are a deliberate choice rather than a default.
  useEffect(() => {
    if (open) setSelected(entries.map((_, index) => index + 1))
  }, [open, entries])

  if (!open) return null

  const picked = new Set(selected)
  const allSelected = entries.length > 0 && selected.length === entries.length

  const toggle = (position: number): void =>
    setSelected((previous) =>
      previous.includes(position)
        ? previous.filter((value) => value !== position)
        : [...previous, position].sort((a, b) => a - b)
    )

  const applyRange = (): void => {
    const from = Math.max(1, Math.min(entries.length, Math.floor(Number(rangeFrom) || 1)))
    const to = Math.max(1, Math.min(entries.length, Math.floor(Number(rangeTo) || entries.length)))
    if (to < from) return
    const next: number[] = []
    for (let position = from; position <= to; position += 1) next.push(position)
    setSelected(next)
  }

  return (
    <Modal
      open={open}
      title={t('playlist.title')}
      subtitle={
        title
          ? `${title} · ${t('playlist.items', { count: entries.length })}`
          : t('playlist.items', { count: entries.length })
      }
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-faint">
            {t('playlist.selected', { count: selected.length })}
          </span>
          <Button variant="ghost" onClick={onClose}>
            {t('playlist.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected)}
          >
            {t('playlist.confirm', { count: selected.length })}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted">
          <Loader2 size={14} className="animate-spin" />
          {t('playlist.loading')}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-8 text-center text-[12px] text-muted">{t('playlist.empty')}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSelected(allSelected ? [] : entries.map((_, index) => index + 1))}
            >
              {allSelected ? t('playlist.clear') : t('playlist.selectAll')}
            </Button>
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <span>{t('playlist.range')}</span>
              <Input
                className="w-16 text-right"
                inputMode="numeric"
                value={rangeFrom}
                onChange={(event) => setRangeFrom(event.target.value)}
                placeholder="1"
              />
              <span>–</span>
              <Input
                className="w-16 text-right"
                inputMode="numeric"
                value={rangeTo}
                onChange={(event) => setRangeTo(event.target.value)}
                placeholder={String(entries.length)}
              />
              <Button variant="ghost" size="sm" onClick={applyRange}>
                {t('playlist.rangeApply')}
              </Button>
            </div>
          </div>

          <div className="max-h-[46vh] overflow-y-auto rounded-lg border border-line bg-elevated/30">
            {entries.map((entry, index) => {
              const position = index + 1
              const active = picked.has(position)
              return (
                <button
                  key={`${entry.id}-${position}`}
                  type="button"
                  onClick={() => toggle(position)}
                  className={cn(
                    'flex w-full items-center gap-2.5 border-b border-line/60 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-elevated/60',
                    active && 'bg-brand/10'
                  )}
                >
                  {active ? (
                    <CheckSquare size={15} className="shrink-0 text-brand" />
                  ) : (
                    <Square size={15} className="shrink-0 text-faint" />
                  )}
                  <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-faint">
                    {position}
                  </span>
                  <span className="flex-1 truncate text-[12px] text-fg">{entry.title}</span>
                  {entry.durationSeconds > 0 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-faint">
                      {formatEta(entry.durationSeconds)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Modal>
  )
}
