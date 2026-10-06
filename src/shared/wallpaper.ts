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
 *
 * The offset is added to a `50%` background position, so a *positive* offset
 * pushes the picture rightwards: 0 percent needs the picture (which overflows
 * the window) moved back by half that overflow, hence `50 - percent`. Subtracting
 * the percentage the other way round would draw the picture's right edge at 0 —
 * which is what 0.1.30 shipped, and the opposite of what this says.
 */
export function wallpaperPan(
  size: WallpaperSize,
  viewport: WallpaperSize,
  positionX: number,
  positionY: number
): { x: number; y: number } {
  const along = (total: number, visible: number, percent: number): number => {
    // Truncated rather than rounded: the offset is written to CSS as whole pixels,
    // and rounding half a pixel towards the picture would leave that half pixel of
    // theme showing along the edge the position is supposed to be flush with.
    // Truncating can only push the picture further past the edge, which the
    // window clips anyway.
    const offset = Math.trunc(((50 - clamp(percent, 0, 100)) / 100) * Math.max(0, total - visible))
    // A truncated negative zero would reach CSS as `-0px`. Normalising it keeps the
    // written offset either a real move or exactly none.
    return offset === 0 ? 0 : offset
  }
  return {
    x: along(size.width, viewport.width, positionX),
    y: along(size.height, viewport.height, positionY)
  }
}

/**
 * How much room the picture has to move in on each axis, in pixels.
 *
 * This is the divisor the position percentages are measured against, so a drag
 * converts screen pixels into position points through it and zooming changes it.
 */
export function wallpaperTravel(size: WallpaperSize, viewport: WallpaperSize): { x: number; y: number } {
  return {
    x: Math.max(0, size.width - viewport.width),
    y: Math.max(0, size.height - viewport.height)
  }
}

/**
 * The position after the picture has been dragged by `delta` pixels.
 *
 * Dragging right moves the picture right, which means a *smaller* percentage:
 * 0 is the picture's left edge against the window's, so pushing the picture
 * rightwards walks the percentage down towards it. An axis with no room stays
 * where it is (though a percentage outside the range is still brought inside).
 */
export function pannedPosition(
  travel: { x: number; y: number },
  position: { x: number; y: number },
  delta: { x: number; y: number }
): { x: number; y: number } {
  const along = (room: number, current: number, moved: number): number => {
    if (room <= 0) return clamp(current, 0, 100)
    return clamp(current - (moved * 100) / room, 0, 100)
  }
  return {
    x: along(travel.x, position.x, delta.x),
    y: along(travel.y, position.y, delta.y)
  }
}

/**
 * The position that keeps one point of the picture under the pointer across a zoom.
 *
 * Zooming anchored at the window centre would slide the picture out from under
 * the part of it being looked at. Instead the picture point sitting under `anchor`
 * is measured before the zoom and put back under it after, within the room the
 * new size has. When the anchor is past what the picture can cover the nearest
 * reachable position wins, which is why the result is clamped: the anchor cannot
 * be honoured there, and pretending otherwise would tear a gap along the edge.
 */
export function positionAfterZoom(
  before: WallpaperSize,
  after: WallpaperSize,
  viewport: WallpaperSize,
  position: { x: number; y: number },
  anchor: { x: number; y: number }
): { x: number; y: number } {
  const along = (
    sizeBefore: number,
    sizeAfter: number,
    visible: number,
    percent: number,
    point: number
  ): number => {
    if (sizeBefore <= 0 || sizeAfter <= 0 || visible <= 0) return clamp(percent, 0, 100)
    const room = visible - sizeAfter
    // A zoom that leaves nothing overflowing has nowhere to sit but the centre.
    if (room >= 0) return 50
    const edgeBefore = (visible - sizeBefore) * (clamp(percent, 0, 100) / 100)
    const held = (point - edgeBefore) * (sizeAfter / sizeBefore)
    return clamp(((point - held) / room) * 100, 0, 100)
  }
  return {
    x: along(before.width, after.width, viewport.width, position.x, anchor.x),
    y: along(before.height, after.height, viewport.height, position.y, anchor.y)
  }
}
