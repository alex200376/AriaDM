import path from 'node:path'

import type { CategoryRule } from '@shared/settings'
import { extensionOf, sanitizeFileName } from '@shared/uri'

export const FALLBACK_CATEGORY = 'other'

/**
 * Map a filename to a category id using the user's rules.
 * Rules are evaluated in order, so a user rule can shadow a built-in one.
 */
export function categorize(fileName: string, categories: CategoryRule[]): string {
  const extension = extensionOf(fileName)
  if (!extension) return FALLBACK_CATEGORY
  for (const category of categories) {
    if (category.extensions.some((candidate) => candidate.toLowerCase() === extension)) {
      return category.id
    }
  }
  return FALLBACK_CATEGORY
}

export function findCategory(categories: CategoryRule[], id: string): CategoryRule | undefined {
  return categories.find((entry) => entry.id === id)
}

/**
 * The folder name a category's downloads are filed under.
 *
 * Deliberately the category's own name: the sidebar already shows it, so the
 * disk and the filter cannot disagree, and a custom category needs no second
 * label to invent. `sanitizeFileName` keeps a name like `A/B` a single folder
 * instead of a nested path, and a name of only dots or separators falls back to
 * the id.
 */
export function categoryFolderName(category: CategoryRule): string {
  // Separators become underscores before the filename sanitiser runs: that
  // sanitiser keeps only the last path segment, which would turn a category
  // named "Movies/HD" into a folder called just "HD" rather than "Movies_HD".
  return sanitizeFileName(category.name.replace(/[\\/]+/g, '_'), category.id)
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
 * Precedence is: the category's own folder, then the type subfolder when sorting
 * is on, then the global download directory. An unknown category (a settings file
 * with no rules, or an id the user deleted) has no folder name to use, so it
 * stays in the root rather than inventing one.
 */
export function categoryDirectory(
  categories: CategoryRule[],
  categoryId: string,
  defaultDir: string,
  sortByType = false
): string {
  const category = findCategory(categories, categoryId)
  if (category?.dir) return category.dir
  if (!sortByType || !category) return defaultDir
  return path.join(defaultDir, categoryFolderName(category))
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

export function categoryLabel(categories: CategoryRule[], id: string): string {
  return findCategory(categories, id)?.name ?? id
}
