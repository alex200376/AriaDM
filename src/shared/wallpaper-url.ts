/**
 * The picture, in the form CSS can actually hold.
 *
 * A wallpaper arrives from the main process as a base64 data URL, and it used to
 * go straight into `--wallpaper-image`. That is fine until the picture is a
 * normal photograph: the declaration for a 1.7 MB PNG is 2.36 million characters,
 * and Blink **silently drops a CSS declaration longer than 2 MiB** — the property
 * keeps no value, the layer falls back to `none`, and the window shows the flat
 * theme. Nothing reports an error: the setting is saved, the file is a perfectly
 * good image, and the same bytes decode instantly when loaded as an image. The
 * only symptom is that some pictures work and some do not, which is exactly how
 * this was reported.
 *
 * A `blob:` URL is a few dozen characters whatever the picture weighs, so the
 * declaration is always accepted, and the image loader takes the bytes instead of
 * the style system parsing megabytes of base64 as text. The limit below is
 * measured, not guessed — see `tests/unit/wallpaper-url.test.ts`.
 */

/**
 * The longest CSS declaration Chromium keeps, observed in Blink (Chromium 130):
 * a 2 MiB declaration is accepted, one character more is dropped in silence.
 *
 * Kept as a named constant because it is the reason this module exists: it is the
 * budget a picture has to fit in if it is ever written into a style declaration,
 * and any picture worth setting as a wallpaper is bigger than it.
 */
export const CSS_DECLARATION_CHAR_LIMIT = 2 * 1024 * 1024

/** The MIME type named by a data URL, or '' when it names none. */
function mimeOf(meta: string): string {
  const type = meta.split(';')[0]?.trim() ?? ''
  return type === '' ? 'application/octet-stream' : type
}

/**
 * The bytes a base64 data URL carries, as a Blob, or null when it is not one.
 *
 * Null rather than a throw: a wallpaper that cannot be converted (a hand-edited
 * setting, a data URL that is not base64) is still worth trying as it is, which
 * is what the caller does with the answer.
 */
export function pictureBlobFrom(dataUrl: string): Blob | null {
  if (!dataUrl.startsWith('data:')) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null

  const meta = dataUrl.slice('data:'.length, comma)
  if (!meta.toLowerCase().includes(';base64')) return null

  try {
    const binary = atob(dataUrl.slice(comma + 1))
    // No bytes at all is not a picture, and a Blob of nothing would paint a blank
    // layer where the fallback at least keeps the old behaviour.
    if (binary.length === 0) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mimeOf(meta) })
  } catch {
    // Malformed base64 is a wallpaper this cannot help with, not a crash.
    return null
  }
}

/**
 * The URL to hand to CSS for `dataUrl`.
 *
 * `createObjectUrl` is injected so the decision can be tested without a DOM: the
 * point of the module is *which* URL reaches the declaration, and that is the one
 * thing a test has to be able to see.
 */
export function wallpaperCssUrl(
  dataUrl: string,
  createObjectUrl: (blob: Blob) => string
): string {
  const blob = pictureBlobFrom(dataUrl)
  return blob === null ? dataUrl : createObjectUrl(blob)
}
