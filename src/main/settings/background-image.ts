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

/** The data URL for an image file, or null when it cannot be used. */
export function readImageDataUrl(file: string): string | null {
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

  const key = `${file}\u0000${stats.size}\u0000${stats.mtimeMs}`
  if (cache !== null && cache.key === key) return cache.value

  try {
    const value = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
    cache = { key, value }
    return value
  } catch {
    return null
  }
}
