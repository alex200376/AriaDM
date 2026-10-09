import type { DownloadItem } from './download'

/**
 * Fold a tick's changes into the list the renderer already holds.
 *
 * A tick carries only what moved since the previous one, so the queue the app
 * keeps in memory is rebuilt here rather than resent from the main process:
 * without this, a thousand finished downloads were cloned and re-rendered every
 * second just to say the same thing again.
 *
 * The order the renderer already had is preserved — a download that changes must
 * not jump to the end of the list — and that is also why it is not sorted here at
 * all: the table sorts by whatever the user chose.
 *
 * Lives in `shared` rather than beside the store because it is pure data work on
 * the IPC payload's own types, and because the main process's delta logic is the
 * other half of the same contract.
 */
export function mergeItems(
  current: DownloadItem[],
  changed: DownloadItem[],
  removedGids: string[]
): DownloadItem[] {
  const removed = new Set(removedGids)
  const merged = new Map<string, DownloadItem>()
  for (const item of current) {
    if (!removed.has(item.gid)) merged.set(item.gid, item)
  }
  for (const item of changed) merged.set(item.gid, item)
  return [...merged.values()]
}
