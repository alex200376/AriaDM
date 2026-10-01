import type { DownloadItem } from '@shared/download'
import { t } from '@shared/i18n'

import { Badge } from '../ui/primitives'
import { statusLabel, statusTone } from '../../lib/labels'

export function StatusBadge({ item }: { item: DownloadItem }): JSX.Element {
  const tone = statusTone(item.status)

  // More specific states win over the plain status: "seeding" and "verifying"
  // are still `active` as far as aria2 is concerned.
  let label = statusLabel(item.status)
  if (item.metadataPending) label = t('table.metadataPendingShort')
  else if (item.status === 'active' && item.verifyIntegrityPending) label = t('table.verifying')
  else if (item.status === 'active' && item.seeder && item.downloadSpeed === 0) label = t('table.seedingNow')
  else if (item.status === 'complete' && item.postActionState === 'running') label = t('table.processing')

  // The label is also carried as a tooltip: the queue column can truncate a long
  // state ("Fetching metadata"), and the drawer is not always open to explain it.
  return (
    <span title={label} className="flex min-w-0 overflow-hidden">
      <Badge
        tone={tone}
        dot
        className={`truncate${item.status === 'active' ? ' [&>span:first-child]:animate-pulse-soft' : ''}`}
      >
        {label}
      </Badge>
    </span>
  )
}
