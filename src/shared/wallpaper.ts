/**
 * Where the wallpaper sits inside the window.
 *
 * `background-size: cover` on its own fills the window but cannot be cropped:
 * the browser works out the drawn size from the picture's own aspect ratio,
 * which CSS cannot do arithmetic on, and zooming with a `transform` would scale
 * the pan range as well — which is how a "moved" picture ends up showing a strip
 * of background along an edge. So the drawn size and the offset are computed
 * here, from the picture's real pixel size, and handed to CSS as the two custom
 * properties the layer reads.
 *
 * Pure arithmetic on purpose: the renderer measures the window and decodes the
 * picture, this decides what to draw.
 */

export interface WallpaperSize {
  width: number
  height: number
}

/**
 * Extra size drawn around the picture, as a multiplier.
 *
 * A blurred layer samples outside its own box, so at exactly `cover` the window
 * edge picks up a pale rim. Overscanning by a few percent pushes that rim off
 * screen. It is part of the drawn size rather than a `transform` on the layer so
 * it grows the room the picture has to move in instead of shifting the edges.
 */
export const WALLPAPER_OVERSCAN = 1.06

/** Zoom bounds in percent. Below 100 the window would show the theme through. */
export const MIN_WALLPAPER_ZOOM = 100
export const MAX_WALLPAPER_ZOOM = 300

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function isUsable(size: WallpaperSize): boolean {
  return size.width > 0 && size.height > 0
}

/**
 * The size to draw a picture at so it fills `viewport` without gaps.
 *
 * `zoomPercent` is relative to that fit: 100 is the smallest scale that leaves
 * nothing empty, 200 shows a quarter as much of the picture.
 */
export function wallpaperSize(
  natural: WallpaperSize,
  viewport: WallpaperSize,
  zoomPercent: number
): WallpaperSize {
  if (!isUsable(natural) || !isUsable(viewport)) return { width: 0, height: 0 }
  const fit = Math.max(viewport.width / natural.width, viewport.height / natural.height)
  const scale = fit * (clamp(zoomPercent, MIN_WALLPAPER_ZOOM, MAX_WALLPAPER_ZOOM) / 100) * WALLPAPER_OVERSCAN
  return { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) }
}

/**
 * How far the picture is moved from the centre of the window, in pixels.
 *
 * Position is a percentage of the room the picture has to move in, not of the
 * window: 0 puts the picture's left (or top) edge against the window's, 100 its
 * right (or bottom), 50 centres it. Measuring against the room rather than the
 * window is what keeps a saved position meaning the same thing after the window
 * is resized, and it is what a `background-position` percentage would have done.
 */
export function wallpaperPan(
  size: WallpaperSize,
  viewport: WallpaperSize,
  positionX: number,
  positionY: number
): { x: number; y: number } {
  const along = (total: number, visible: number, percent: number): number => {
    const offset = Math.round(((clamp(percent, 0, 100) - 50) / 100) * Math.max(0, total - visible))
    // A rounded negative zero would reach CSS as `-0px`. Normalising it keeps the
    // written offset either a real move or exactly none.
    return offset === 0 ? 0 : offset
  }
  return {
    x: along(size.width, viewport.width, positionX),
    y: along(size.height, viewport.height, positionY)
  }
}
