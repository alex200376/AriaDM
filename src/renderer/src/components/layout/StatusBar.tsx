import { ArrowDown, ArrowUp, Zap } from 'lucide-react'

import { formatSpeed } from '@shared/format'
import { t } from '@shared/i18n'

import { useEasedNumber } from '../../hooks/useEased'
import { engineLabel, engineTone } from '../../lib/labels'
import { useApp } from '../../store/app-store'
import { SpeedGraph } from '../charts/SpeedGraph'
import { TONE_DOT } from '../ui/primitives'

export function StatusBar(): JSX.Element {
  const global = useApp((state) => state.global)
  const engine = useApp((state) => state.engine)
  const series = useApp((state) => state.speedSeries)

  const download = useEasedNumber(global.downloadSpeed)
  const upload = useEasedNumber(global.uploadSpeed)

  const peak = series.reduce((max, sample) => Math.max(max, sample.download), 0)

  const tone = engineTone(engine.state)

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-surface/70 px-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <ArrowDown size={12} className="text-brand" />
        <span className="text-tabular w-[76px] text-right font-medium text-fg">{formatSpeed(download)}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <ArrowUp size={12} className="text-info" />
        <span className="text-tabular w-[68px] text-right">{formatSpeed(upload)}</span>
      </span>

      <div className="w-[190px]">
        <SpeedGraph series={series} />
      </div>

      <span className="flex items-center gap-1.5" title={t('statusBar.peak')}>
        <Zap size={12} className="text-warn" />
        <span className="text-tabular">{formatSpeed(peak)}</span>
      </span>

      {/* The queue's counts and the finished total live in the title bar and the
          sidebar. This bar is about *throughput*, and repeating them here made a
          narrow window's status area say the same number twice. */}
      <div className="flex-1" />

      <span className="flex items-center gap-1.5" title={engine.lastError || engine.message || engineLabel(engine.state)}>
        <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
        <span>{engineLabel(engine.state)}</span>
      </span>
    </footer>
  )
}
