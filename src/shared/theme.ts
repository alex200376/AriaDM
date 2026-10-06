/**
 * The colour maths behind the accent setting.
 *
 * Kept in `shared` rather than next to the DOM code that uses it because it is
 * pure arithmetic: the CSS variables hold bare RGB triples (`124 92 255`) so
 * Tailwind's alpha syntax keeps working, which means every colour that reaches
 * them has to be converted on the way in.
 */

/** `#abc` or `#aabbcc` to the bare `r g b` triple the CSS variables hold. */
export function hexToRgbTriple(hex: string): string | null {
  const value = hex.trim().replace(/^#/, '')
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null
  const full =
    value.length === 3
      ? value
          .split('')
          .map((character) => character + character)
          .join('')
      : value

  const red = Number.parseInt(full.slice(0, 2), 16)
  const green = Number.parseInt(full.slice(2, 4), 16)
  const blue = Number.parseInt(full.slice(4, 6), 16)
  return `${red} ${green} ${blue}`
}

/**
 * The text colour to use on top of a brand colour, as an `r g b` triple.
 *
 * `--brand-fg` is what a filled brand button writes in. The shipped palettes only
 * ever hold colours dark enough for white, so this exists for the custom accent:
 * without it, a pale yellow would render white-on-yellow and the button's label
 * would disappear.
 */
export function brandForegroundFor(triple: string): string {
  const parts = triple.split(' ').map(Number)
  const red = parts[0] ?? 0
  const green = parts[1] ?? 0
  const blue = parts[2] ?? 0
  // Rec. 601 luma: cheap, and close enough to how the eye weights these three.
  const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return luma > 0.62 ? '17 19 24' : '255 255 255'
}

/** The accent pairs a custom colour resolves to, or null when it is not usable. */
export function accentTriples(hex: string): { brand: string; foreground: string } | null {
  const brand = hexToRgbTriple(hex)
  if (brand === null) return null
  return { brand, foreground: brandForegroundFor(brand) }
}
