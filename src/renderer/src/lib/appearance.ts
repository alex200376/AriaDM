import { accentTriples } from '@shared/theme'
import { wallpaperPan, wallpaperSize, type WallpaperSize } from '@shared/wallpaper'

/**
 * Everything that paints a window, in one place.
 *
 * The theme is a set of CSS variables on the document element rather than a
 * stylesheet per palette: `dark` flips the variables, `data-accent` swaps the
 * brand colour, `data-density` the row height. This module is the only writer of
 * those, because the main window and the catch popup used to each carry their own
 * copy of the logic — which is exactly how the popup ended up without the density
 * token, and how "custom accent" would have reached only one of them.
 *
 * Nothing here touches the DOM beyond the root element, so it can be called
 * before React mounts without a flash of the wrong theme. The colour arithmetic
 * lives in `@shared/theme` and the crop geometry in `@shared/wallpaper`, both
 * pure and therefore testable without a DOM.
 */

export interface Appearance {
  theme: 'dark' | 'light' | 'system'
  /** Palette name matching a `[data-accent]` rule; used when `customAccent` is ''. */
  accent: string
  /** `#rgb` or `#rrggbb` picked by the user, or '' to use the palette. */
  customAccent: string
  density: string
  /** The wallpaper as a data URL, or '' for the flat background. */
  wallpaper: string
  /** Wallpaper blur in pixels. */
  blur: number
  /** How far the wallpaper is pushed toward the interface colour, in percent. */
  dim: number
  /** How much colour the app paints over the wallpaper, in percent. */
  opacity: number
  /** Wallpaper zoom in percent: 100 fills the window, higher crops into it. */
  zoom: number
  /** Horizontal crop position: 0 shows the picture's left edge, 100 its right. */
  positionX: number
  /** Vertical crop position: 0 shows the picture's top edge, 100 its bottom. */
  positionY: number
}

/** The parts of the look a slider can move while the user is still dragging. */
export type WallpaperAdjust = Pick<Appearance, 'blur' | 'dim' | 'opacity' | 'zoom' | 'positionX' | 'positionY'>

/** The picture itself plus those parts, which together describe the layer. */
type WallpaperLook = WallpaperAdjust & { wallpaper: string }

/** Properties this module owns, so turning the wallpaper off clears all of them. */
const WALLPAPER_PROPERTIES = [
  '--wallpaper-image',
  '--wallpaper-blur',
  '--wallpaper-dim',
  '--app-alpha',
  '--wallpaper-size',
  '--wallpaper-position'
]

/**
 * The picture on screen, kept so a resize or a slider can recompose it without
 * decoding the data URL again. `natural` stays null until it has loaded, which is
 * why the geometry is only written once the picture's real size is known.
 */
let composed: { root: HTMLElement; look: WallpaperLook; natural: WallpaperSize | null } | null = null

/**
 * Write the drawn size and the offset that together crop the picture.
 *
 * The picture is placed with `calc(50% + n px)`: 50% centres it in the layer, and
 * the offset moves it by exactly the pixels the pan asks for — which keeps a drag
 * and the slider telling the same story, and keeps both edges reachable at any
 * zoom.
 */
function writeGeometry(root: HTMLElement, look: WallpaperLook, natural: WallpaperSize): void {
  // Before the first layout the root has no box yet; the window is the same size
  // it is about to settle on, so a first paint is never drawn at zero.
  const viewport = {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight
  }
  const size = wallpaperSize(natural, viewport, look.zoom)
  if (size.width <= 0 || size.height <= 0) {
    // A picture that decoded to nothing is better off at the `cover` fallback
    // than drawn at zero size.
    root.style.removeProperty('--wallpaper-size')
    root.style.removeProperty('--wallpaper-position')
    return
  }
  const pan = wallpaperPan(size, viewport, look.positionX, look.positionY)
  root.style.setProperty('--wallpaper-size', `${size.width}px ${size.height}px`)
  root.style.setProperty('--wallpaper-position', `calc(50% + ${pan.x}px) calc(50% + ${pan.y}px)`)
}

/** Measure the picture once; until then it is drawn at the `cover` fallback. */
function measure(root: HTMLElement, look: WallpaperLook): void {
  const image = new Image()
  const stillCurrent = (): boolean => composed !== null && composed.look.wallpaper === look.wallpaper

  image.onload = () => {
    if (!stillCurrent() || composed === null) return
    composed.natural = { width: image.naturalWidth, height: image.naturalHeight }
    writeGeometry(root, composed.look, composed.natural)
  }
  image.onerror = () => {
    if (!stillCurrent()) return
    root.style.removeProperty('--wallpaper-size')
    root.style.removeProperty('--wallpaper-position')
  }
  image.src = look.wallpaper
}

/** Every wallpaper custom property except the geometry. */
function paintLook(root: HTMLElement, look: WallpaperLook): void {
  root.style.setProperty('--wallpaper-image', `url("${look.wallpaper}")`)
  root.style.setProperty('--wallpaper-blur', `${look.blur}px`)
  root.style.setProperty('--wallpaper-dim', String(look.dim / 100))
  root.style.setProperty('--app-alpha', String(look.opacity / 100))
}

/** Recompose for the current window size, which a resize or a drag can change. */
function repaintGeometry(): void {
  if (composed?.natural) writeGeometry(composed.root, composed.look, composed.natural)
}

/**
 * Paint the root element, and return a cleanup for the listeners it added.
 *
 * The returned function is always safe to call, so a caller can wire it straight
 * into an effect's teardown whatever the theme is.
 */
export function applyAppearance(root: HTMLElement, look: Appearance): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const followsSystem = look.theme === 'system'

  const paintTheme = (): void => {
    root.classList.toggle('dark', look.theme === 'dark' || (followsSystem && media.matches))
  }
  paintTheme()
  if (followsSystem) media.addEventListener('change', paintTheme)

  root.setAttribute('data-accent', look.accent)
  root.setAttribute('data-density', look.density)

  paintAccent(root, look.customAccent)

  // `data-wallpaper` rather than a class: the CSS that reacts to it is about the
  // same appearance state the rest of the attributes describe.
  const hasWallpaper = look.wallpaper.length > 0
  root.setAttribute('data-wallpaper', hasWallpaper ? 'on' : 'off')
  if (hasWallpaper) {
    // A resize changes the room the picture has to move in, so the crop has to be
    // worked out again rather than left at the size the old window needed.
    const natural = composed?.look.wallpaper === look.wallpaper ? composed.natural : null
    composed = { root, look, natural }
    paintLook(root, look)
    if (natural) writeGeometry(root, look, natural)
    else measure(root, look)
    window.addEventListener('resize', repaintGeometry)
  } else {
    for (const property of WALLPAPER_PROPERTIES) root.style.removeProperty(property)
    composed = null
  }

  return () => {
    if (followsSystem) media.removeEventListener('change', paintTheme)
    window.removeEventListener('resize', repaintGeometry)
    composed = null
  }
}

/**
 * Set the brand colour from a custom hex, or clear it back to the palette.
 *
 * Exported because Settings previews a colour while the user is still dragging
 * the picker: waiting for the round trip through settings and the store would
 * make the swatch feel detached from the pointer.
 */
export function paintAccent(root: HTMLElement, hex: string): void {
  const triples = accentTriples(hex)
  if (triples === null) {
    root.style.removeProperty('--brand')
    root.style.removeProperty('--brand-fg')
    return
  }
  root.style.setProperty('--brand', triples.brand)
  root.style.setProperty('--brand-fg', triples.foreground)
}

/** What the wallpaper layer is drawing right now, in the pixels it was drawn at. */
export interface WallpaperFrame {
  natural: WallpaperSize
  size: WallpaperSize
  viewport: WallpaperSize
}

/**
 * The frame the layer currently has, for a gesture that has to work in pixels.
 *
 * A drag and a wheel both turn screen movement into a crop position, and both
 * need the same two numbers: how big the picture is drawn and how much of the
 * window it has to fill. The picture and the window come from what was last
 * painted rather than from a fresh measurement, so a gesture can never act on a
 * picture the paint did not use. `null` means there is nothing to move — no
 * picture, or one that has not decoded yet.
 *
 * `zoom` is the crop the caller is working from. A gesture has to pass its own:
 * a wheel event can land before the drag before it has been painted, and the size
 * a gesture converts hand movement through has to be the size the hand is
 * dragging, not the size still on screen.
 */
export function currentWallpaperFrame(zoom?: number): WallpaperFrame | null {
  if (composed === null || composed.natural === null) return null
  const { root, look, natural } = composed
  const viewport = {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight
  }
  const size = wallpaperSize(natural, viewport, zoom ?? look.zoom)
  if (size.width <= 0 || size.height <= 0) return null
  return { natural, size, viewport }
}

/**
 * Repaint the picture for a live preview, before the value has been saved.
 *
 * Separate from `applyAppearance` for the same reason as `paintAccent`: the
 * sliders need to follow the pointer, and a settings write per pixel is not worth
 * it. A preview requested before the picture has decoded is a no-op — the values
 * are remembered and applied the moment its size is known, rather than cropping
 * to a guess.
 */
export function paintWallpaperPreview(root: HTMLElement, change: Partial<WallpaperAdjust>): void {
  if (composed === null || composed.root !== root) return
  const look = { ...composed.look, ...change }
  composed.look = look
  paintLook(root, look)
  if (composed.natural) writeGeometry(root, look, composed.natural)
}
