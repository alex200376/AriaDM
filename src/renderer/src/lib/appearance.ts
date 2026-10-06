import { accentTriples } from '@shared/theme'

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
 * lives in `@shared/theme`, which is pure and therefore testable without a DOM.
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
}

/** Properties this module owns, so turning the wallpaper off clears all of them. */
const WALLPAPER_PROPERTIES = [
  '--wallpaper-image',
  '--wallpaper-blur',
  '--wallpaper-dim',
  '--app-alpha'
]

/**
 * Paint the root element, and return a cleanup for the OS-theme listener.
 *
 * The returned function is a no-op unless the theme is `system`, so a caller can
 * always wire it into an effect's teardown.
 */
export function applyAppearance(root: HTMLElement, look: Appearance): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')

  const paintTheme = (): void => {
    root.classList.toggle('dark', look.theme === 'dark' || (look.theme === 'system' && media.matches))
  }
  paintTheme()

  root.setAttribute('data-accent', look.accent)
  root.setAttribute('data-density', look.density)

  paintAccent(root, look.customAccent)

  // `data-wallpaper` rather than a class: the CSS that reacts to it is about the
  // same appearance state the rest of the attributes describe.
  const hasWallpaper = look.wallpaper.length > 0
  root.setAttribute('data-wallpaper', hasWallpaper ? 'on' : 'off')
  if (hasWallpaper) {
    root.style.setProperty('--wallpaper-image', `url("${look.wallpaper}")`)
    paintWallpaperAmounts(root, look)
  } else {
    for (const property of WALLPAPER_PROPERTIES) root.style.removeProperty(property)
  }

  if (look.theme !== 'system') return () => undefined
  media.addEventListener('change', paintTheme)
  return () => media.removeEventListener('change', paintTheme)
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

/**
 * The wallpaper's three amounts, without touching the picture.
 *
 * Separate from `applyAppearance` for the same reason as `paintAccent`: the
 * sliders need a live preview, and these are the only variables they move.
 */
export function paintWallpaperAmounts(
  root: HTMLElement,
  amounts: { blur: number; dim: number; opacity: number }
): void {
  root.style.setProperty('--wallpaper-blur', `${amounts.blur}px`)
  root.style.setProperty('--wallpaper-dim', String(amounts.dim / 100))
  root.style.setProperty('--app-alpha', String(amounts.opacity / 100))
}
