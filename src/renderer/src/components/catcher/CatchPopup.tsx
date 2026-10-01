import { ArrowDownToLine, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { t } from '@shared/i18n'
import type { CatcherInfo } from '@shared/ipc'

import { Button, IconButton } from '../ui/primitives'

/**
 * The body of the IDM-style catch popup.
 *
 * Nothing here starts a download: the capture is already in the queue, paused,
 * and the three actions decide what happens to it. That is why closing the
 * window is safe — it can only ever mean "later".
 */
export function CatchPopup({ initial }: { initial: CatcherInfo | null }): JSX.Element | null {
  const [info, setInfo] = useState<CatcherInfo | null>(initial)

  // A second capture while this window is open updates it in place.
  useEffect(() => window.api.on.catcherUpdate(setInfo), [])

  // Enter and Escape match the buttons, so the whole popup is keyboard-drivable.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void window.api.catcher.resolve('start')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void window.api.catcher.resolve('later')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!info) return null

  return (
    <div className="catcher-shell flex h-screen w-screen flex-col border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-brand">
          <ArrowDownToLine size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-fg">{t('catcher.title')}</p>
          <p className="mt-0.5 truncate text-[12px] text-fg" title={info.title}>
            {info.title}
          </p>
          <p className="truncate text-[11px] text-faint">
            {info.host || t('catcher.unknownHost')}
            {info.count > 1 && ` · ${t('catcher.count', { count: info.count })}`}
          </p>
        </div>
        {/* Dismissing is "later", not "cancel": the download is kept. */}
        <IconButton
          label={t('catcher.later')}
          icon={<X size={13} />}
          onClick={() => void window.api.catcher.resolve('later')}
        />
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{t('catcher.hint')}</p>

      <div className="mt-auto flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void window.api.catcher.resolve('cancel')}>
          {t('common.cancel')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void window.api.catcher.resolve('later')}>
          {t('catcher.later')}
        </Button>
        {/* Focused by hand: the window opens on the answer most people want. */}
        <Button variant="primary" size="sm" autoFocus onClick={() => void window.api.catcher.resolve('start')}>
          {t('catcher.start')}
        </Button>
      </div>
    </div>
  )
}
