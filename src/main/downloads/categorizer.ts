import path from 'node:path'

import { categoryFolderPath } from '@shared/categories'
import type { CategoryRule } from '@shared/settings'

// Re-exported so the main process keeps one import site for the categoriser even
// though the pure rules now live with the preview that reads the same answer.
export { FALLBACK_CATEGORY, categorize } from '@shared/categories'

export function findCategory(categories: CategoryRule[], id: string): CategoryRule | undefined {
  return categories.find((entry) => entry.id === id)
}

/**
 * Whether two directory paths point at the same folder.
 *
 * Needed because an "untouched" folder field still carries a value: the add
 * dialog prefills it with the default download folder, and a dropped torrent
 * passes that folder explicitly. Treating those as a deliberate choice would
 * silently disable type folders for everything started that way, so the
 * comparison decides whether the user actually picked somewhere else.
 *
 * Windows paths are case-insensitive and may end in either separator, so the
 * answer is computed from resolved paths rather than raw strings.
 */
export function sameDirectory(a: string, b: string): boolean {
  if (!a || !b) return false
  const normalise = (value: string): string => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalise(a) === normalise(b)
}

/**
 * Where a download in this category should land.
 *
 * The rules live in `shared/categories` because the renderer previews the same
 * answer before the download exists; `path.join` is passed in so the main
 * process keeps its native separators and normalisation.
 */
export function categoryDirectory(
  categories: CategoryRule[],
  categoryId: string,
  defaultDir: string,
  sortByType = false
): string {
  return categoryFolderPath(categories, categoryId, defaultDir, sortByType, path.join)
}

/**
 * The directory a new download should use.
 *
 * `requested` is the folder a caller passed in; it only wins when it names a
 * folder other than the default one, because the add dialog and the torrent drop
 * both send the default back unchanged.
 */
export function resolveDownloadDirectory(
  categories: CategoryRule[],
  categoryId: string,
  defaultDir: string,
  requested: string,
  sortByType = false
): string {
  // Real callers always send a string, but the request is assembled from several
  // entry points and a missing field must mean "no choice", not a crash.
  if (requested && requested.trim().length > 0 && !sameDirectory(requested, defaultDir)) return requested
  return categoryDirectory(categories, categoryId, defaultDir, sortByType)
}
