import { describe, expect, it } from 'vitest'

import {
  MAX_WALLPAPER_ZOOM,
  MIN_WALLPAPER_ZOOM,
  WALLPAPER_OVERSCAN,
  wallpaperPan,
  wallpaperSize
} from '@shared/wallpaper'

const WINDOW = { width: 1024, height: 664 }
const WIDE = { width: 1600, height: 900 }
const TALL = { width: 900, height: 1600 }

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
  const size = { width: 1200, height: 800 }

  it('centres at 50 percent', () => {
    expect(wallpaperPan(size, WINDOW, 50, 50)).toEqual({ x: 0, y: 0 })
  })

  it('puts the picture edge against the window edge at 0 and 100', () => {
    expect(wallpaperPan(size, WINDOW, 0, 0)).toEqual({ x: -88, y: -68 })
    expect(wallpaperPan(size, WINDOW, 100, 100)).toEqual({ x: 88, y: 68 })
  })

  it('moves within the room the picture actually has', () => {
    // Half of the total overflow: any more would pull an edge into the window.
    const pan = wallpaperPan(size, WINDOW, 0, 0)
    expect(Math.abs(pan.x)).toBe((size.width - WINDOW.width) / 2)
    expect(Math.abs(pan.y)).toBe((size.height - WINDOW.height) / 2)
  })

  it('does not move on an axis with no room', () => {
    const exact = { width: WINDOW.width, height: 2600 }
    expect(wallpaperPan(exact, WINDOW, 0, 0).x).toBe(0)
    expect(wallpaperPan(exact, WINDOW, 100, 0).x).toBe(0)
  })

  it('clamps a percentage outside the range', () => {
    expect(wallpaperPan(size, WINDOW, 200, -50)).toEqual({ x: 88, y: -68 })
  })
})
