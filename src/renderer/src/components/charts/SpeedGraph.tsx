import { useMemo } from 'react'

import type { SpeedSample } from '@shared/download'
import { formatSpeed } from '@shared/format'
import { t } from '@shared/i18n'

import { cn } from '../../lib/cn'

const WIDTH = 200
const HEIGHT = 34

/**
 * Throughput sparkline.
 *
 * Drawn as a plain SVG polyline rather than a charting dependency: the data is a
 * rolling window of a hundred-odd samples, and the whole thing is a few hundred
 * bytes of markup.
 */
export function SpeedGraph({
  series,
  className,
  showUpload = true
}: {
  series: SpeedSample[]
  className?: string
  showUpload?: boolean
}): JSX.Element {
  const { downloadPath, uploadPath, areaPath, peak } = useMemo(() => {
    if (series.length < 2) {
      return { downloadPath: '', uploadPath: '', areaPath: '', peak: 0 }
    }

    const peakValue = series.reduce((max, sample) => Math.max(max, sample.download), 1)
    // Leave headroom so the line never touches the top edge.
    const scale = peakValue * 1.15

    const pointAt = (index: number, value: number): [number, number] => [
      (index / (series.length - 1)) * WIDTH,
      HEIGHT - (value / scale) * HEIGHT
    ]

    const downloadPoints = series.map((sample, index) => pointAt(index, sample.download))
    const uploadPoints = series.map((sample, index) => pointAt(index, sample.upload))

    const line = (points: [number, number][]): string =>
      points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

    const area = `${line(downloadPoints)} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`

    return {
      downloadPath: line(downloadPoints),
      uploadPath: line(uploadPoints),
      areaPath: area,
      peak: peakValue
    }
  }, [series])

  const idle = series.length < 2

  return (
    <div
      className={cn('relative', className)}
      title={idle ? t('speedGraph.idle') : t('speedGraph.peak', { speed: formatSpeed(peak) })}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[34px] w-full"
        aria-hidden
      >
        <defs>
          <linearGradient id="speed-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--brand))" stopOpacity="0.42" />
            <stop offset="100%" stopColor="rgb(var(--brand))" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {!idle && (
          <>
            <path d={areaPath} fill="url(#speed-area)" />
            <path
              d={downloadPath}
              fill="none"
              stroke="rgb(var(--brand))"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {showUpload && (
              <path
                d={uploadPath}
                fill="none"
                stroke="rgb(var(--info))"
                strokeWidth="1.2"
                strokeDasharray="3 3"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </>
        )}

        {/* Baseline keeps the panel from looking empty before data arrives. */}
        <line
          x1="0"
          y1={HEIGHT - 0.5}
          x2={WIDTH}
          y2={HEIGHT - 0.5}
          stroke="rgb(var(--line))"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
