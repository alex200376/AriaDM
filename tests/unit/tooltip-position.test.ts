import { describe, expect, it } from 'vitest'

import { tooltipPosition } from '@shared/tooltip-position'

const viewport = { width: 800, height: 600 }
const size = { width: 100, height: 24 }

describe('tooltipPosition', () => {
  it('centres the bubble over the anchor when there is room', () => {
    const anchor = { left: 300, right: 340, top: 300, bottom: 328 }
    expect(tooltipPosition(anchor, size, viewport)).toEqual({ left: 270, top: 268 })
  })

  it('keeps a bubble at the right edge inside the window', () => {
    // This is the reported case: an action button in the last column. Half a
    // bubble overhanging the window is what the native tooltip did.
    const anchor = { left: 770, right: 798, top: 300, bottom: 328 }
    expect(tooltipPosition(anchor, size, viewport)).toEqual({ left: 692, top: 268 })
  })

  it('keeps a bubble at the left edge inside the window', () => {
    const anchor = { left: 0, right: 28, top: 300, bottom: 328 }
    expect(tooltipPosition(anchor, size, viewport)).toEqual({ left: 8, top: 268 })
  })

  it('flips below the anchor when there is no room above', () => {
    const anchor = { left: 300, right: 340, top: 10, bottom: 38 }
    expect(tooltipPosition(anchor, size, viewport)).toEqual({ left: 270, top: 46 })
  })

  it('stays inside a window shorter than the bubble', () => {
    const anchor = { left: 300, right: 340, top: 10, bottom: 38 }
    expect(tooltipPosition(anchor, { width: 100, height: 80 }, { width: 800, height: 60 })).toEqual({
      left: 270,
      top: 8
    })
  })

  it('shrinks to the window width instead of overhanging a tiny window', () => {
    const anchor = { left: 40, right: 60, top: 300, bottom: 328 }
    expect(tooltipPosition(anchor, { width: 200, height: 24 }, { width: 120, height: 600 })).toEqual({
      left: 8,
      top: 268
    })
  })
})
