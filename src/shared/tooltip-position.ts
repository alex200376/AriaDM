/**
 * Where a tooltip goes, clamped inside the window.
 *
 * The native `title` tooltip is positioned by the operating system and cannot be
 * kept on screen: an icon at the right edge of the queue got a bubble that ran
 * off the window, so the action it was describing was only half readable. The
 * replacement is a fixed-position layer, and this is the arithmetic it runs
 * after the bubble has been measured.
 *
 * Pure, and separate from the component, so the edge cases (right edge, top of a
 * window shorter than the tooltip) can be tested directly.
 */
export interface AnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

/** Distance between the anchor and the bubble, and the smallest margin to the window edge. */
const GAP = 8
const MARGIN = 8

export function tooltipPosition(
  anchor: AnchorRect,
  size: Size,
  viewport: Size,
  gap = GAP,
  margin = MARGIN
): { left: number; top: number } {
  const width = Math.min(size.width, Math.max(0, viewport.width - margin * 2))
  const centre = anchor.left + (anchor.right - anchor.left) / 2
  const left = Math.min(Math.max(centre - width / 2, margin), Math.max(margin, viewport.width - margin - width))

  // Above the anchor when there is room, otherwise below it. The `${margin}`
  // check keeps a tooltip off the title bar on a very short window instead of
  // letting it hang over the top edge.
  const above = anchor.top - gap - size.height >= margin
  const top = above
    ? anchor.top - gap - size.height
    : Math.min(anchor.bottom + gap, Math.max(margin, viewport.height - margin - size.height))

  return { left, top }
}
