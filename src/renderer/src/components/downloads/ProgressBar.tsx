import type { DownloadStatus } from '@shared/download'

import { cn } from '../../lib/cn'
import { useEasedNumber } from '../../hooks/useEased'

/**
 * Progress bar driven by a 1 Hz snapshot but animated at frame rate.
 *
 * The width is expressed as a transform rather than a width change so it stays on
 * the compositor and never triggers layout.
 */
export function ProgressBar({
  fraction,
  status,
  indeterminate = false,
  className
}: {
  fraction: number
  status: DownloadStatus
  indeterminate?: boolean
  className?: string
}): JSX.Element {
  const eased = useEasedNumber(indeterminate ? 0 : Math.min(Math.max(fraction, 0), 1))

  const fillClass =
    status === 'complete'
      ? 'bg-ok'
      : status === 'error'
        ? 'bg-danger'
        : status === 'paused'
          ? 'bg-faint'
          : status === 'waiting'
            ? 'bg-info/70'
            : 'bg-gradient-to-r from-brand to-info'

  return (
    <div className={cn('progress-track h-1.5 w-full', indeterminate && 'progress-indeterminate', className)}>
      <div
        className={cn('progress-fill', fillClass)}
        style={{ width: '100%', transform: `scaleX(${indeterminate ? 0.35 : eased})` }}
      />
    </div>
  )
}
