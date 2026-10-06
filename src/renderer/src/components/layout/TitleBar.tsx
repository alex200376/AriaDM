import { Maximize2, Minimize2, Minus, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { t } from '@shared/i18n'

// The app mark, generated from the same artwork as the executable's icon by
// `npm run icons` at 64px and bundled next to the renderer's other assets. The
// window's own name and mark are the only thing identifying it now that the frame
// is hidden, and it is small enough to draw straight away rather than to fetch.
import appMark from '../../../../../resources/icons/mark.png'
import { cn } from '../../lib/cn'
import { engineLabel, engineTone } from '../../lib/labels'
import { useApp } from '../../store/app-store'
import { TONE_DOT } from '../ui/primitives'

/**
 * The window's caption row.
 *
 * The window has no native title bar, so this strip is what the user drags and
 * the app draws its own minimise/maximise/close. It is also the queue toolbar's
 * row — `children` is where the toolbar goes — because a download manager with a
 * browser-style caption has no reason to spend two rows on chrome.
 *
 * Narrow is handled by giving things up in the stated order: the wordmark, then
 * the labels that only name a control its icon already identifies (see
 * `.toolbar-compact`), and only then a second line, which the toolbar takes on
 * its own. The window buttons are pinned to the corner rather than being a flex
 * item, so they stay where a user reaches for them whatever the row does.
 */
export function TitleBar({ children }: { children?: ReactNode }): JSX.Element {
  const engine = useApp((state) => state.engine)

  const tone = engineTone(engine.state)
  const engineState = engineLabel(engine.state)
  // macOS draws its own traffic lights, in the other top corner.
  const isMac = window.api.platform === 'darwin'

  return (
    <header
      className={cn(
        'drag-region relative flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 border-b border-line bg-surface/80',
        // Room for the window buttons is reserved rather than laid out, so the
        // toolbar can wrap underneath without taking them with it.
        isMac ? 'pl-20 pr-3' : 'pl-3 pr-32'
      )}
    >
      {/* The mark and the name, top left, where a window says what it is. The
          mark stays at every width — it is 20px — while the word is the first
          thing to go when the row is cramped. */}
      <img src={appMark} alt="" aria-hidden="true" className="h-5 w-5 shrink-0 rounded-[5px]" />
      <span className="chrome-brand text-[13px] font-semibold tracking-tight text-fg">AriaDM</span>

      {/* A dot rather than the state's name: the caption is one line tall, and a
          sentence about the engine belongs in the status bar. The tooltip still
          spells it out and the label is there for a screen reader. Nothing here
          is clickable, so it stays inside the drag region on purpose. */}
      <span
        role="status"
        aria-label={engineState}
        title={engine.message || engineState}
        className="flex h-5 w-5 items-center justify-center"
      >
        <span
          className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone], engine.state !== 'ready' && 'animate-pulse-soft')}
        />
      </span>

      {engine.restarts > 0 && (
        <span className="no-drag chip bg-warn/15 text-warn" title={t('engine.restartsHint')}>
          {t('engine.restarts', { count: engine.restarts })}
        </span>
      )}

      {children}

      <WindowButtons />
    </header>
  )
}

/**
 * Minimise, maximise and close, drawn by the app.
 *
 * A window with a hidden title bar has no native buttons to fall back on, and an
 * overlay painted by Electron cannot follow the theme — which is what a dark
 * block in the corner of a light window was. These keep the shape and the hover
 * behaviour of the OS ones so they still read as window buttons rather than as
 * toolbar actions.
 */
function WindowButtons(): JSX.Element {
  const [maximised, setMaximised] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.window.isMaximised().then((value) => {
      if (alive) setMaximised(value)
    })
    const off = window.api.on.windowState((state) => setMaximised(state.maximised))
    return () => {
      alive = false
      off()
    }
  }, [])

  // On macOS the traffic lights are the controls, in the corner the platform puts
  // them in; a second set beside them would be two of everything.
  if (window.api.platform === 'darwin') return <></>

  const button =
    'no-drag flex h-8 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-line/60 hover:text-fg'

  return (
    <div className="absolute right-1.5 top-0 flex h-11 items-center gap-0.5">
      <button
        type="button"
        aria-label={t('window.minimise')}
        title={t('window.minimise')}
        className={button}
        onClick={() => void window.api.window.minimise()}
      >
        <Minus size={14} />
      </button>

      <button
        type="button"
        aria-label={maximised ? t('window.restore') : t('window.maximise')}
        title={maximised ? t('window.restore') : t('window.maximise')}
        className={button}
        onClick={() => void window.api.window.toggleMaximise()}
      >
        {maximised ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>

      <button
        type="button"
        aria-label={t('common.close')}
        title={t('common.close')}
        className={cn(button, 'hover:bg-danger hover:text-white')}
        onClick={() => void window.api.window.close()}
      >
        <X size={15} />
      </button>
    </div>
  )
}
