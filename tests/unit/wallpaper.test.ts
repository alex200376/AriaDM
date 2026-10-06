import { describe, expect, it } from 'vitest'

import {
  MAX_WALLPAPER_ZOOM,
  MIN_WALLPAPER_ZOOM,
  WALLPAPER_OVERSCAN,
  pannedPosition,
  positionAfterZoom,
  type WallpaperSize,
  wallpaperPan,
  wallpaperSize,
  wallpaperTravel
} from '@shared/wallpaper'

const WINDOW = { width: 1024, height: 664 }
const WIDE = { width: 1600, height: 900 }
const TALL = { width: 900, height: 1600 }

/**
 * Where the picture's own edges land on screen, in window pixels.
 *
 * The renderer hands CSS a `50%` background position plus the offset from
 * `wallpaperPan`, so the picture's leading edge starts half of its overflow to
 * the left of the window's edge and then moves by that offset. Reading the
 * result as edges is the point: an offset on its own cannot say whether 0
 * percent means the picture's left edge or its right one, and that direction is
 * exactly what shipped backwards in 0.1.30.
 */
function edges(
  size: WallpaperSize,
  viewport: WallpaperSize,
  positionX: number,
  positionY: number
): { left: number; top: number; right: number; bottom: number } {
  const pan = wallpaperPan(size, viewport, positionX, positionY)
  const left = (viewport.width - size.width) / 2 + pan.x
  const top = (viewport.height - size.height) / 2 + pan.y
  return { left, top, right: left + size.width, bottom: top + size.height }
}

/**
 * The offset is rounded to whole pixels, so an extreme position can land a
 * fraction of a pixel inside the window edge. Anything beyond this is not
 * rounding: it is the picture panned off the window.
 */
const EDGE_SLACK = 0.5

describe('wallpaperSize', () => {
  it('fills the window at 100 percent with no gap', () => {
    const size = wallpaperSize(WIDE, WINDOW, 100)
    expect(size.width).toBeGreaterThanOrEqual(WINDOW.width)
    expect(size.height).toBeGreaterThanOrEqual(WINDOW.height)
  })

  it('keeps the picture aspect ratio', () => {
    const size = wallpaperSize(WIDE, WINDOW, 100)
    expect(size.width / size.height).toBeCloseTo(WIDE.width / WIDE.height, 2)
  })

  it('fits by the tighter axis, so a tall picture is as wide as the window', () => {
    const size = wallpaperSize(TALL, WINDOW, 100)
    expect(size.width).toBeGreaterThanOrEqual(WINDOW.width)
    expect(size.height).toBeGreaterThanOrEqual(WINDOW.height)
    // The binding axis is the width for a portrait picture on a landscape window.
    expect(size.width / WINDOW.width).toBeLessThan(size.height / WINDOW.height)
  })

  it('grows with zoom and shrinks back, centred on the same fit', () => {
    const base = wallpaperSize(WIDE, WINDOW, 100)
    const doubled = wallpaperSize(WIDE, WINDOW, 200)
    expect(doubled.width).toBeGreaterThan(base.width)
    // Each size is rounded to a whole pixel, so doubling may be a pixel out.
    expect(Math.abs(doubled.width - base.width * 2)).toBeLessThanOrEqual(2)
    expect(wallpaperSize(WIDE, WINDOW, 150).width).toBeGreaterThan(base.width)
  })

  it('overscans by the bleed factor so a blur cannot show a rim', () => {
    const size = wallpaperSize(WIDE, WINDOW, 100)
    const fit = Math.max(WINDOW.width / WIDE.width, WINDOW.height / WIDE.height)
    expect(size.width).toBeCloseTo(WIDE.width * fit * WALLPAPER_OVERSCAN, 0)
  })

  it('clamps zoom to the supported range', () => {
    const atMax = wallpaperSize(WIDE, WINDOW, MAX_WALLPAPER_ZOOM)
    expect(wallpaperSize(WIDE, WINDOW, 5000).width).toBe(atMax.width)
    const atMin = wallpaperSize(WIDE, WINDOW, MIN_WALLPAPER_ZOOM)
    expect(wallpaperSize(WIDE, WINDOW, 10).width).toBe(atMin.width)
    expect(wallpaperSize(WIDE, WINDOW, Number.NaN).width).toBe(atMin.width)
  })

  it('reports nothing to draw when a size is unknown', () => {
    expect(wallpaperSize({ width: 0, height: 0 }, WINDOW, 100)).toEqual({ width: 0, height: 0 })
    expect(wallpaperSize(WIDE, { width: 0, height: 664 }, 100)).toEqual({ width: 0, height: 0 })
  })
})

describe('wallpaperPan', () => {
  // 176 and 136 pixels of overflow, so half of each is a whole number and the
  // extremes land on the window edge exactly rather than half a pixel out.
  const size = { width: 1200, height: 800 }

  it('puts the picture left and top edges against the window at 0', () => {
    const frame = edges(size, WINDOW, 0, 0)
    expect(frame.left).toBe(0)
    expect(frame.top).toBe(0)
  })

  it('puts the picture right and bottom edges against the window at 100', () => {
    const frame = edges(size, WINDOW, 100, 100)
    expect(frame.right).toBe(WINDOW.width)
    expect(frame.bottom).toBe(WINDOW.height)
    // The far edges are the ones flush, which means the near ones are off screen.
    expect(frame.left).toBeLessThan(0)
    expect(frame.top).toBeLessThan(0)
  })

  it('centres the picture at 50, with the same overflow on each side', () => {
    const frame = edges(size, WINDOW, 50, 50)
    expect(frame.left).toBe(-(size.width - WINDOW.width) / 2)
    expect(frame.right).toBe(WINDOW.width + (size.width - WINDOW.width) / 2)
    expect(frame.top).toBe(-(size.height - WINDOW.height) / 2)
    expect(frame.bottom).toBe(WINDOW.height + (size.height - WINDOW.height) / 2)
  })

  it('moves the picture up and left as the position rises', () => {
    // The direction of the whole mapping in one sweep: if the subtraction inside
    // `wallpaperPan` is ever flipped again, this fails on the first pair.
    const frames = [0, 25, 50, 75, 100].map((percent) => edges(size, WINDOW, percent, percent))
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].left).toBeLessThan(frames[i - 1].left)
      expect(frames[i].top).toBeLessThan(frames[i - 1].top)
    }
  })

  it('does not move a picture that exactly fills an axis', () => {
    // Exactly the window's width, with plenty of height, so the horizontal
    // position has nothing to move and the vertical one still does.
    const exact = { width: WINDOW.width, height: 2600 }
    const atStart = edges(exact, WINDOW, 0, 0)
    const atEnd = edges(exact, WINDOW, 100, 100)
    expect(atEnd.left).toBe(atStart.left)
    expect(atEnd.top).not.toBe(atStart.top)
  })

  it('brings a percentage outside the range to the edge it passed', () => {
    expect(edges(size, WINDOW, 200, -50)).toEqual(edges(size, WINDOW, 100, 0))
  })
})

describe('wallpaper crop coverage', () => {
  it('always covers the window, at every position and zoom', () => {
    const positions = [0, 25, 50, 75, 100]
    const zooms = [MIN_WALLPAPER_ZOOM, 150, MAX_WALLPAPER_ZOOM]
    // A landscape picture overflows sideways and a portrait one vertically, so
    // between them both axes of the mapping are driven to their extremes.
    for (const picture of [WIDE, TALL]) {
      for (const zoom of zooms) {
        const size = wallpaperSize(picture, WINDOW, zoom)
        for (const positionX of positions) {
          for (const positionY of positions) {
            const frame = edges(size, WINDOW, positionX, positionY)
            expect(frame.left).toBeLessThanOrEqual(EDGE_SLACK)
            expect(frame.top).toBeLessThanOrEqual(EDGE_SLACK)
            expect(frame.right).toBeGreaterThanOrEqual(WINDOW.width - EDGE_SLACK)
            expect(frame.bottom).toBeGreaterThanOrEqual(WINDOW.height - EDGE_SLACK)
          }
        }
      }
    }
  })
})

describe('wallpaperTravel', () => {
  it('is the overflow the picture has on each axis', () => {
    expect(wallpaperTravel({ width: 1200, height: 800 }, WINDOW)).toEqual({ x: 176, y: 136 })
  })

  it('is zero on an axis the picture exactly fills', () => {
    expect(wallpaperTravel({ width: WINDOW.width, height: 800 }, WINDOW)).toEqual({ x: 0, y: 136 })
  })

  it('never reports negative room for a picture smaller than the window', () => {
    expect(wallpaperTravel({ width: 0, height: 0 }, WINDOW)).toEqual({ x: 0, y: 0 })
    expect(wallpaperTravel({ width: 200, height: 100 }, WINDOW)).toEqual({ x: 0, y: 0 })
  })
})

describe('pannedPosition', () => {
  const travel = { x: 176, y: 136 }

  it('moves the picture with the drag, by the drag itself', () => {
    const size = { width: 1200, height: 800 }
    const before = edges(size, WINDOW, 50, 50)
    const dragged = pannedPosition(travel, { x: 50, y: 50 }, { x: 60, y: -30 })
    const after = edges(size, WINDOW, dragged.x, dragged.y)
    // Dragging right has to take the picture's left edge right with it. The offset
    // is rounded, so "by the drag" holds to within a pixel.
    expect(after.left - before.left).toBeCloseTo(60, 0)
    expect(after.top - before.top).toBeCloseTo(-30, 0)
  })

  it('walks the position down when the picture is dragged right and down', () => {
    // Half of each axis' room, so the position should fall by exactly 25.
    const moved = pannedPosition(travel, { x: 50, y: 50 }, { x: 44, y: 68 })
    expect(moved.x).toBeCloseTo(25, 6)
    expect(moved.y).toBeCloseTo(0, 6)
  })

  it('walks the position up when the picture is dragged left and up', () => {
    const moved = pannedPosition(travel, { x: 50, y: 50 }, { x: -44, y: -34 })
    expect(moved.x).toBeCloseTo(75, 6)
    expect(moved.y).toBeCloseTo(75, 6)
  })

  it('stops at the picture edges however far the pointer goes', () => {
    expect(pannedPosition(travel, { x: 50, y: 50 }, { x: 10_000, y: 10_000 })).toEqual({ x: 0, y: 0 })
    expect(pannedPosition(travel, { x: 50, y: 50 }, { x: -10_000, y: -10_000 })).toEqual({ x: 100, y: 100 })
  })

  it('leaves an axis with no room exactly where it is', () => {
    expect(pannedPosition({ x: 0, y: 136 }, { x: 42, y: 50 }, { x: 500, y: 0 })).toEqual({ x: 42, y: 50 })
  })

  it('still brings an out-of-range position inside on an axis with no room', () => {
    expect(pannedPosition({ x: 0, y: 0 }, { x: 200, y: -50 }, { x: 0, y: 0 })).toEqual({ x: 100, y: 0 })
  })
})

describe('positionAfterZoom', () => {
  const before = { width: 1200, height: 800 }
  const after = { width: 2400, height: 1600 }
  const CENTRE = { x: WINDOW.width / 2, y: WINDOW.height / 2 }

  /**
   * How far the held point may drift.
   *
   * The drawn size is a whole number of pixels and so is the offset, so a
   * position cannot always be expressed closely enough to hold a point exactly:
   * at these zooms the picture's edges themselves move by hundreds of pixels, so
   * a pixel or two at the anchor is the rounding, not the anchor being ignored.
   */
  const HELD_SLACK = 2

  it('leaves a centred picture centred when the zoom is anchored at the centre', () => {
    const zoomed = positionAfterZoom(before, after, WINDOW, { x: 50, y: 50 }, CENTRE)
    expect(zoomed.x).toBeCloseTo(50, 6)
    expect(zoomed.y).toBeCloseTo(50, 6)
  })

  it('keeps the picture point under the pointer across the zoom', () => {
    const anchor = { x: 200, y: 100 }
    const position = { x: 50, y: 50 }
    const frame = edges(before, WINDOW, position.x, position.y)
    // Which part of the picture the pointer is over, before the zoom.
    const fractionX = (anchor.x - frame.left) / before.width
    const fractionY = (anchor.y - frame.top) / before.height

    const grown = positionAfterZoom(before, after, WINDOW, position, anchor)
    const grownFrame = edges(after, WINDOW, grown.x, grown.y)

    expect(Math.abs(grownFrame.left + fractionX * after.width - anchor.x)).toBeLessThanOrEqual(HELD_SLACK)
    expect(Math.abs(grownFrame.top + fractionY * after.height - anchor.y)).toBeLessThanOrEqual(HELD_SLACK)

    // And the anchor really did hold: a zoom about the centre instead would have
    // carried this point most of the way to the middle of the window.
    const centreAnchored = edges(after, WINDOW, position.x, position.y)
    const carried = centreAnchored.left + fractionX * after.width
    expect(Math.abs(anchor.x - carried)).toBeGreaterThan(50)
  })

  it('holds the anchor while zooming out too', () => {
    // Zooming out shrinks the room the picture has, so only an anchor near the
    // middle is still reachable; the edge cases are the next two tests.
    const anchor = { x: 500, y: 300 }
    const position = { x: 50, y: 50 }
    const frame = edges(after, WINDOW, position.x, position.y)
    const fractionX = (anchor.x - frame.left) / after.width
    const fractionY = (anchor.y - frame.top) / after.height

    const shrunk = positionAfterZoom(after, before, WINDOW, position, anchor)
    const shrunkFrame = edges(before, WINDOW, shrunk.x, shrunk.y)

    expect(Math.abs(shrunkFrame.left + fractionX * before.width - anchor.x)).toBeLessThanOrEqual(HELD_SLACK)
    expect(Math.abs(shrunkFrame.top + fractionY * before.height - anchor.y)).toBeLessThanOrEqual(HELD_SLACK)
  })

  it('takes the nearest reachable position when the anchor asks for more than the zoom leaves', () => {
    // Zooming out at the window's right edge would need the picture's left edge to
    // move right of the window's, which would tear a gap. The nearest position that
    // keeps the window covered is 0, the picture's own left edge flush with it.
    const anchor = { x: WINDOW.width, y: WINDOW.height }
    expect(positionAfterZoom(after, before, WINDOW, { x: 0, y: 0 }, anchor)).toEqual({ x: 0, y: 0 })
    // And the mirror image at the other edge.
    expect(positionAfterZoom(after, before, WINDOW, { x: 100, y: 100 }, { x: 0, y: 0 })).toEqual({
      x: 100,
      y: 100
    })
  })

  it('centres an axis the new size no longer overflows', () => {
    const small = { width: 800, height: 600 }
    expect(positionAfterZoom(before, small, WINDOW, { x: 0, y: 100 }, { x: 10, y: 10 })).toEqual({
      x: 50,
      y: 50
    })
  })

  it('leaves the position alone when a size is unknown', () => {
    const position = { x: 20, y: 70 }
    expect(positionAfterZoom({ width: 0, height: 0 }, after, WINDOW, position, CENTRE)).toEqual(position)
    expect(positionAfterZoom(before, after, { width: 0, height: 0 }, position, CENTRE)).toEqual(position)
  })
})
