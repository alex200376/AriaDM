import { extensionOf } from '@shared/uri'
import type { CategoryRule } from '@shared/settings'

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
 * Where a download in this category should land. An empty category dir means
 * "use the global download directory", mirroring how IDM files things by type.
 */
export function categoryDirectory(categories: CategoryRule[], categoryId: string, defaultDir: string): string {
  const category = findCategory(categories, categoryId)
  if (!category?.dir) return defaultDir
  return category.dir
}

export function categoryLabel(categories: CategoryRule[], id: string): string {
  return findCategory(categories, id)?.name ?? id
}
