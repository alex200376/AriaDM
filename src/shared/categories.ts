/**
 * Category names and type-folder destinations, shared by both processes.
 *
 * The main process decides where a download lands; the renderer has to show the
 * same answer before the download exists. Keeping the naming rules here is what
 * stops the settings preview and the file on disk from disagreeing — the bug
 * that made a category row say "no folder" while the files went somewhere else.
 *
 * The built-in categories are stored with the names the app shipped with
 * (Chinese). `categoryDisplayName` translates those while they are untouched, so
 * an English interface does not show Chinese labels, and a name the user typed
 * still wins over the dictionary.
 */
import type { TranslationKey } from './i18n'
import { t } from './i18n'
import { DEFAULT_CATEGORIES, type CategoryRule } from './settings'
import { extensionOf, sanitizeFileName } from './uri'

/** Joins a folder and a name; `path.join` in main, a small separator-aware one here. */
export type FolderJoin = (base: string, name: string) => string

const SHIPPED_NAMES = new Map(DEFAULT_CATEGORIES.map((rule) => [rule.id, rule.name]))

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  video: 'category.video',
  audio: 'category.audio',
  archive: 'category.archive',
  document: 'category.document',
  program: 'category.program',
  image: 'category.image',
  torrent: 'category.torrent',
  other: 'category.other'
}

/**
 * Folder names are separate from filter labels on purpose: "Video" reads well in
 * a dropdown, "Videos" reads well on disk, and a translation change should not
 * silently rename a folder on the next download.
 */
const FOLDER_KEYS: Record<string, TranslationKey> = {
  video: 'category.folder.video',
  audio: 'category.folder.audio',
  archive: 'category.folder.archive',
  document: 'category.folder.document',
  program: 'category.folder.program',
  image: 'category.folder.image',
  torrent: 'category.folder.torrent',
  other: 'category.folder.other'
}

export const FALLBACK_CATEGORY = 'other'

export function isBuiltinCategory(id: string): boolean {
  return SHIPPED_NAMES.has(id)
}

/**
 * Map a filename to a category id using the user's rules.
 *
 * Rules are evaluated in order, so a user rule can shadow a built-in one. This
 * lives here as well as in the main process because the add dialog previews the
 * destination before the request exists, and the preview has to use the same
 * rule order the engine will.
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

/**
 * The name a category is shown under.
 *
 * A built-in category whose stored name is still the one the app shipped is
 * translated; one the user renamed is left alone. That is deliberately a name
 * comparison rather than a new schema flag: old settings files have no flag, and
 * inventing one would make every existing category look customised.
 */
export function categoryDisplayName(rule: CategoryRule): string {
  const shipped = SHIPPED_NAMES.get(rule.id)
  const key = CATEGORY_KEYS[rule.id]
  if (shipped !== undefined && key !== undefined && rule.name === shipped) return t(key)
  return rule.name.trim().length > 0 ? rule.name : rule.id
}

/**
 * The folder a type is filed under inside the default download folder.
 *
 * Separators become underscores before `sanitizeFileName` runs: that sanitiser
 * keeps only the last path segment, which would turn "Movies/HD" into a folder
 * called just "HD" instead of "Movies_HD". A name of only dots or separators
 * falls back to the category id.
 */
export function categoryFolderName(rule: CategoryRule): string {
  const pinned = (rule.folderName ?? '').trim()
  if (pinned.length > 0) return sanitizeFileName(pinned.replace(/[\\/]+/g, '_'), rule.id)

  const shipped = SHIPPED_NAMES.get(rule.id)
  const folderKey = FOLDER_KEYS[rule.id]
  const label =
    shipped !== undefined && folderKey !== undefined && rule.name === shipped
      ? t(folderKey)
      : rule.name.trim().length > 0
        ? rule.name
        : rule.id
  return sanitizeFileName(label.replace(/[\\/]+/g, '_'), rule.id)
}

/**
 * A separator-aware join for the renderer, which has no `path` module.
 *
 * The base's own separator is the cue: a Windows path keeps backslashes, a
 * normalised one stays with forward slashes. Both are valid to Windows.
 */
export function joinFolderPath(base: string, name: string): string {
  const trimmed = base.trim().replace(/[\\/]+$/, '')
  if (trimmed.length === 0) return name
  const separator = trimmed.includes('\\') ? '\\' : '/'
  return `${trimmed}${separator}${name}`
}

/**
 * Where a download in this category lands.
 *
 * Precedence: the category's own folder, then the type subfolder when sorting is
 * on, then the global download directory. An unknown category (a settings file
 * with no rules, or an id the user deleted) has no folder name to use, so it
 * stays in the root rather than inventing one.
 */
export function categoryFolderPath(
  categories: CategoryRule[],
  categoryId: string,
  defaultDir: string,
  sortByType = false,
  join: FolderJoin = joinFolderPath
): string {
  const category = categories.find((entry) => entry.id === categoryId)
  if (category?.dir) return category.dir
  if (!sortByType || !category) return defaultDir
  return join(defaultDir, categoryFolderName(category))
}

/** The display name of a category id, falling back to the id itself. */
export function categoryLabel(categories: CategoryRule[], id: string): string {
  const rule = categories.find((entry) => entry.id === id)
  return rule ? categoryDisplayName(rule) : id
}
