import { t } from '@shared/i18n'

import { cn } from '../../lib/cn'
import { engineLabel, engineTone } from '../../lib/labels'
import { useApp } from '../../store/app-store'
import { TONE_DOT } from '../ui/primitives'

/**
 * A custom title bar for the frameless window.
 *
 * Electron draws the native minimise/maximise/close buttons via the title bar
 * overlay on the right, so that region is left clear with reserved padding
 * rather than being covered by our own controls.
 */
export function TitleBar(): JSX.Element {
  const engine = useApp((state) => state.engine)
  const global = useApp((state) => state.global)

  const tone = engineTone(engine.state)

  return (
    <header className="drag-region flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface/80 pl-3">
      {/* The wordmark only: the window frame and taskbar already carry the app
          icon, so a second mark here was just noise. */}
      <span className="text-[13px] font-semibold tracking-tight text-fg">AriaDM</span>

      <div className="ml-1 flex items-center gap-1.5" title={engine.message || engineLabel(engine.state)}>
        <span
          className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone], engine.state !== 'ready' && 'animate-pulse-soft')}
        />
        <span className="no-drag text-[11px] text-muted">{engineLabel(engine.state)}</span>
      </div>

      {engine.restarts > 0 && (
        <span className="chip bg-warn/15 text-warn" title={t('engine.restartsHint')}>
          {t('engine.restarts', { count: engine.restarts })}
        </span>
      )}

      <div className="flex-1" />

      {global.numActive > 0 && (
        <span className="text-[11px] text-muted">
          {t('statusBar.active', { count: global.numActive })}
          {global.numWaiting > 0 ? ` · ${t('statusBar.queued', { count: global.numWaiting })}` : ''}
        </span>
      )}
    </header>
  )
}
