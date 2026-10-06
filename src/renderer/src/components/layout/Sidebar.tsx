import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  Clock,
  History,
  List,
  Pause,
  Settings as SettingsIcon
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { DownloadItem } from '@shared/download'
import { formatBytes } from '@shared/format'
import { t } from '@shared/i18n'

import { cn } from '../../lib/cn'
import { useApp, type ViewKey } from '../../store/app-store'

function countBy(items: DownloadItem[], status: DownloadItem['status']): number {
  return items.filter((item) => item.status === status).length
}

function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
  tone
}: {
  icon: ReactNode
  label: string
  count?: number
  active: boolean
  onClick(): void
  tone?: 'danger' | 'ok'
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
        active ? 'bg-brand/15 text-fg' : 'text-muted hover:bg-line/40 hover:text-fg'
      )}
    >
      <span className={cn('shrink-0', active ? 'text-brand' : tone === 'danger' ? 'text-danger/80' : 'text-faint')}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className={cn('text-tabular text-[11px]', active ? 'text-brand' : 'text-faint')}>{count}</span>
      )}
    </button>
  )
}

export function Sidebar(): JSX.Element {
  const items = useApp((state) => state.items)
  const view = useApp((state) => state.view)
  const setView = useApp((state) => state.setView)
  const openSettings = useApp((state) => state.openSettings)

  const totalSize = items.reduce((sum, item) => sum + item.totalLength, 0)
  const completedSize = items
    .filter((item) => item.status === 'complete')
    .reduce((sum, item) => sum + item.totalLength, 0)

  const statusNav: { key: ViewKey; label: string; icon: ReactNode; count?: number; tone?: 'danger' | 'ok' }[] = [
    { key: 'all', label: t('nav.all'), icon: <List size={15} />, count: items.length },
    { key: 'active', label: t('nav.active'), icon: <ArrowDownToLine size={15} />, count: countBy(items, 'active') },
    { key: 'waiting', label: t('nav.waiting'), icon: <Clock size={15} />, count: countBy(items, 'waiting') },
    { key: 'paused', label: t('nav.paused'), icon: <Pause size={15} />, count: countBy(items, 'paused') },
    { key: 'complete', label: t('nav.complete'), icon: <CheckCircle2 size={15} />, count: countBy(items, 'complete'), tone: 'ok' },
    { key: 'error', label: t('nav.error'), icon: <AlertTriangle size={15} />, count: countBy(items, 'error'), tone: 'danger' }
  ]

  return (
    <aside className="flex w-[180px] shrink-0 flex-col border-r border-line bg-surface/50">
      <div className="scrollbar-none flex-1 overflow-y-auto px-2 py-3">
        <p className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
          {t('nav.status')}
        </p>
        <nav className="space-y-0.5">
          {statusNav.map((entry) => (
            <NavItem
              key={entry.key}
              icon={entry.icon}
              label={entry.label}
              count={entry.count}
              tone={entry.tone}
              active={view === entry.key}
              onClick={() => setView(entry.key)}
            />
          ))}
        </nav>

        <p className="px-2.5 pb-1.5 pt-5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
          {t('nav.other')}
        </p>
        <nav className="space-y-0.5">
          <NavItem
            icon={<History size={15} />}
            label={t('nav.history')}
            active={view === 'history'}
            onClick={() => setView('history')}
          />
          {/* One entry, not two. Speed profiles used to have their own row that
              opened a different tab of the same settings page, which read as two
              destinations and then landed in the same place. */}
          <NavItem
            icon={<SettingsIcon size={15} />}
            label={t('nav.settings')}
            active={view === 'settings'}
            onClick={() => openSettings('general')}
          />
        </nav>
      </div>

      <div className="border-t border-line px-3 py-2.5 text-[11px] text-faint">
        <div className="flex items-center justify-between">
          <span>{t('nav.totalSize')}</span>
          <span className="text-tabular text-muted">{formatBytes(totalSize)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span>{t('nav.completedSize')}</span>
          <span className="text-tabular text-muted">{formatBytes(completedSize)}</span>
        </div>
      </div>
    </aside>
  )
}
