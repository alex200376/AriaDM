import {
  Archive,
  Boxes,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Package,
  Radio
} from 'lucide-react'
import type { ReactElement } from 'react'

/**
 * Icons per built-in category id.
 *
 * Shared by the toolbar's filter and the folders panel so the same type looks
 * the same in both places. A custom category has no entry and falls back to the
 * neutral box.
 */
export const CATEGORY_ICONS: Record<string, ReactElement> = {
  video: <Film size={14} />,
  audio: <Music size={14} />,
  archive: <Archive size={14} />,
  document: <FileText size={14} />,
  program: <Package size={14} />,
  image: <ImageIcon size={14} />,
  torrent: <Radio size={14} />,
  other: <Boxes size={14} />
}

export function categoryIcon(id: string): ReactElement {
  return CATEGORY_ICONS[id] ?? <Boxes size={14} />
}
