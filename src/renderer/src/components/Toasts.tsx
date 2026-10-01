import { AlertTriangle, CheckCircle2, Clipboard, Info, Plus, X } from 'lucide-react'

import { t } from '@shared/i18n'

import { useApp } from '../store/app-store'
import { cn } from '../lib/cn'
import { Button, IconButton } from './ui/primitives'

const TONE_STYLE = {
  info: { icon: <Info size={15} />, accent: 'text-info', ring: 'border-info/30' },
  success: { icon: <CheckCircle2 size={15} />, accent: 'text-ok', ring: 'border-ok/30' },
  warn: { icon: <AlertTriangle size={15} />, accent: 'text-warn', ring: 'border-warn/30' },
  error: { icon: <AlertTriangle size={15} />, accent: 'text-danger', ring: 'border-danger/30' }
} as const

/**
 * The clipboard prompt is deliberately separate from the toast stack: it is
 * asking a question and needs to stay until answered, whereas toasts are
 * informational and expire.
 */
function ClipboardOffer(): JSX.Element | null {
  const offer = useApp((state) => state.clipboardOffer)
  const settings = useApp((state) => state.settings)
  const setClipboardOffer = useApp((state) => state.setClipboardOffer)
  const addDownload = useApp((state) => state.addDownload)

  if (!offer) return null

  const accept = (): void => {
    void addDownload({
      uris: offer.urls,
      out: '',
      dir: '',
      split: settings?.split ?? 8,
      maxConnectionPerServer: settings?.maxConnectionPerServer ?? 8,
      minSplitSize: settings?.minSplitSize ?? 4 * 1024 * 1024,
      maxDownloadLimit: 0,
      referer: '',
      userAgent: '',
      cookieHeader: '',
      headers: [],
      username: '',
      password: '',
      proxy: '',
      paused: false,
      seedRatio: settings?.seedRatio ?? 1,
      seedTime: settings?.seedTime ?? 0,
      selectFileIndices: [],
      category: '',
      tags: [],
      source: 'clipboard',
      torrentBase64: null,
      metalinkBase64: null,
      allowDuplicate: false,
      engine: 'auto'
    })
    setClipboardOffer(null)
  }

  const openDialog = (): void => {
    useApp.getState().openDialog('add', offer.urls.join('\n'))
    setClipboardOffer(null)
  }

  return (
    <div className="animate-slide-in-right rounded-xl border border-line bg-elevated p-3 shadow-xl">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-brand">
          <Clipboard size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-fg">{t('toast.clipboard.title')}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={offer.urls.join('\n')}>
            {offer.urls.length > 1
              ? t('toast.clipboard.linkCount', { count: offer.urls.length })
              : offer.urls[0]}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={accept}>
              {t('toast.clipboard.add')}
            </Button>
            <Button variant="ghost" size="sm" onClick={openDialog}>
              {t('toast.clipboard.viewOptions')}
            </Button>
          </div>
        </div>
        <IconButton label={t('common.ignore')} icon={<X size={14} />} onClick={() => setClipboardOffer(null)} />
      </div>
    </div>
  )
}

export function Toasts(): JSX.Element {
  const toasts = useApp((state) => state.toasts)
  const dismissToast = useApp((state) => state.dismissToast)

  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-40 flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => {
        const style = TONE_STYLE[toast.tone]
        return (
          <div
            key={toast.id}
            role="status"
            className={cn(
              'pointer-events-auto animate-slide-in-right rounded-xl border bg-elevated/95 p-3 shadow-xl backdrop-blur',
              style.ring
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className={cn('mt-0.5 shrink-0', style.accent)}>{style.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-fg">{toast.title}</p>
                {toast.body && (
                  <p className="mt-0.5 break-words text-[11.5px] leading-relaxed text-muted" data-selectable>
                    {toast.body}
                  </p>
                )}
              </div>
              <IconButton label={t('common.close')} icon={<X size={13} />} onClick={() => dismissToast(toast.id)} />
            </div>
          </div>
        )
      })}

      <div className="pointer-events-auto">
        <ClipboardOffer />
      </div>
    </div>
  )
}
