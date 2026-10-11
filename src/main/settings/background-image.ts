import fs from 'node:fs'
import path from 'node:path'

/**
 * A wallpaper, read from disk and handed to the renderer as a data URL.
 *
 * The renderer's CSP allows images from `self` and `data:` only, and that is
 * deliberate: the window must never load remote content. Reading the file in the
 * main process keeps the policy intact while still letting the user point at any
 * picture on their machine.
 *
 * Note that the *setting* holds a path, not the image. Settings are written to
 * `settings.json` on every change and read on every start, so storing a
 * multi-megabyte base64 blob there would make the file awkward to open, and a
 * shared settings file would stop being shareable.
 */

/** Extensions a Chromium window can paint. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

/** The extensions the file picker offers, so the two lists cannot disagree. */
export const IMAGE_EXTENSIONS = Object.keys(MIME_BY_EXTENSION).map((extension) =>
  extension.replace('.', '')
)

/**
 * Refuse anything bigger than this. Base64 inflates by about a third, and the
 * whole thing then travels over IPC and lands in the renderer's memory, so a
 * 50 MB photo would be felt as a stutter every time the window paints.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/**
 * One entry is enough: the window has one wallpaper, and keeping the previous
 * one alive would hold a second copy of a multi-megabyte string.
 *
 * The key carries the size and modification time as well as the path, so
 * replacing the file with a different picture at the same location is picked up
 * instead of serving the old image forever.
 */
let cache: { key: string; value: string } | null = null

/**
 * The MIME type to read a file as, or null when it is not a usable picture.
 *
 * Extension, existence and size only — no reading — so callers that just need
 * to know whether a file is worth copying do not pay for a base64 encode of
 * something they will only then copy.
 */
function usableImage(file: string): { mime: string; stats: fs.Stats } | null {
  if (typeof file !== 'string' || file.length === 0) return null

  const mime = MIME_BY_EXTENSION[path.extname(file).toLowerCase()]
  if (!mime) return null

  let stats: fs.Stats
  try {
    stats = fs.statSync(file)
  } catch {
    // Missing, unreadable, or not a regular file: all mean "no wallpaper".
    return null
  }
  if (!stats.isFile() || stats.size === 0 || stats.size > MAX_IMAGE_BYTES) return null
  return { mime, stats }
}

/** Whether a file is a picture this app can paint. */
export function isUsableImage(file: string): boolean {
  return usableImage(file) !== null
}

/** The data URL for an image file, or null when it cannot be used. */
export function readImageDataUrl(file: string): string | null {
  const usable = usableImage(file)
  if (!usable) return null

  const key = `${file}\u0000${usable.stats.size}\u0000${usable.stats.mtimeMs}`
  if (cache !== null && cache.key === key) return cache.value

  try {
    const value = `data:${usable.mime};base64,${fs.readFileSync(file).toString('base64')}`
    cache = { key, value }
    return value
  } catch {
    return null
  }
}

/**
 * Whether a path already lives in the app's own wallpaper folder.
 *
 * Anything outside it is a borrowed file: the user may move, rename or delete
 * it, and the wallpaper would silently disappear with it.
 */
export function isManagedImage(file: string, destinationDir: string): boolean {
  if (!file) return false
  return path.resolve(file).startsWith(path.resolve(destinationDir) + path.sep)
}

/**
 * The name a copied picture gets, keeping the one the user knows it by.
 *
 * The original name is kept because the settings window shows it, and
 * "wallpaper.png" would say nothing about which picture is set. It is stripped
 * of the characters Windows refuses in a file name, of leading and trailing dots
 * and spaces, and of anything past 80 characters, so a name that cannot be a
 * file name still produces one.
 */
function managedName(source: string): string {
  const extension = path.extname(source).toLowerCase()
  const base = path
    .basename(source, path.extname(source))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  return `${base || 'wallpaper'}${extension}`
}

/**
 * Copy a picture into the app's own folder and return the copy's path.
 *
 * The setting holds a path, and a path into the user's own folders is a loan:
 * move that file, rename it, or empty the recycle bin, and the wallpaper is gone
 * with it — which is exactly what a user who has set a screenshot as their
 * background reports. A copy under the app's user-data directory belongs to the
 * app, so the picture survives whatever happens to the file it came from.
 *
 * One wallpaper is kept: the folder is cleared of the previous one after the
 * copy lands, so re-picking leaves a single file behind rather than a folder of
 * every picture ever chosen.
 */
export function importImage(source: string, destinationDir: string): string | null {
  if (!isUsableImage(source)) return null

  const target = path.join(destinationDir, managedName(source))
  // Re-picking the picture that is already managed: nothing to copy.
  if (path.resolve(source) === path.resolve(target)) return target

  try {
    fs.mkdirSync(destinationDir, { recursive: true })
    // Staged, then renamed over the target: a crash or a full disk mid-copy must
    // not leave a half-written picture where the setting points.
    const staged = `${target}.tmp`
    fs.copyFileSync(source, staged)
    fs.renameSync(staged, target)
  } catch {
    return null
  }

  pruneImages(destinationDir, path.basename(target))
  return target
}

/** Delete a wallpaper the app owns, after the user has removed it from settings. */
export function removeManagedImage(file: string, destinationDir: string): void {
  if (!isManagedImage(file, destinationDir)) return
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // A wallpaper that cannot be deleted is not worth failing a settings change
    // over; the next import overwrites it anyway.
  }
}

/** Keep only the picture that was just imported. */
function pruneImages(destinationDir: string, keep: string): void {
  try {
    for (const entry of fs.readdirSync(destinationDir)) {
      if (entry === keep) continue
      if (!MIME_BY_EXTENSION[path.extname(entry).toLowerCase()]) continue
      fs.rmSync(path.join(destinationDir, entry), { force: true })
    }
  } catch {
    // An unreadable folder just means nothing to prune.
  }
}
