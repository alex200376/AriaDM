import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { t } from '@shared/i18n'
import {
  MAX_WALLPAPER_ZOOM,
  MIN_WALLPAPER_ZOOM,
  pannedPosition,
  positionAfterZoom,
  wallpaperSize,
  wallpaperTravel
} from '@shared/wallpaper'

import { currentWallpaperFrame, paintWallpaperPreview } from '../../lib/appearance'
import { cn } from '../../lib/cn'
import { useApp } from '../../store/app-store'
import { Button } from '../ui/primitives'

/**
 * The crop, as three numbers the user can drag.
 *
 * A percentage and a slider can express a crop but cannot show one: picking the
 * part of a picture you want behind the interface means seeing it move under
 * your hands, which is why this mode exists next to the sliders rather than
 * instead of them. The sliders stay the precise control, and this stays the one
 * that answers "what does this look like".
 *
 * It is a layer over the whole window rather than a panel with its own preview
 * frame, because the window is already the crop: dragging the wallpaper itself
 * is the same gesture as dragging the picture, with nothing to translate.
 *
 * It is rendered by `SettingsView` rather than by the card that opens it, and
 * outside the column of `space-y` panels: those put a margin on each child, and
 * a `fixed` layer is no exception — it would sit a row-height down from the
 * window's edge instead of over it.
 */

/** A crop, in the three settings that describe it. */
export interface WallpaperCrop {
  zoom: number
  x: number
  y: number
}

/** One wheel notch. Small enough to aim with, large enough to get somewhere. */
const ZOOM_STEP = 5

/**
 * How much wheel travel makes a notch, in pixels and then in lines.
 *
 * A mouse wheel reports about a hundred pixels per click while a trackpad sends a
 * stream of two or three, so a notch per event would zoom a trackpad thirty times
 * faster than a wheel. Travel is accumulated and spent a notch at a time instead;
 * lines are the other unit an OS may report in, and are about sixteen pixels.
 */
const WHEEL_NOTCH = 100
const PIXELS_PER_LINE = 16

/** One arrow key, in position points — the distance the sliders move by point. */
const NUDGE = 1

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The crop as it is worth saving.
 *
 * A drag reports whatever the pointer did, which is a number with more places
 * than a percentage has: nothing under a tenth of a point is visible, and the
 * raw float would be printed in full by the sliders that read these back.
 */
function tidy(crop: WallpaperCrop): WallpaperCrop {
  return {
    zoom: Math.round(crop.zoom),
    x: Math.round(crop.x * 10) / 10,
    y: Math.round(crop.y * 10) / 10
  }
}

export function WallpaperCropOverlay({
  saved,
  onCommit,
  onClose
}: {
  /** The crop in settings, which is what a cancel puts back and a drag starts from. */
  saved: WallpaperCrop
  onCommit(crop: WallpaperCrop): void
  onClose(): void
}): JSX.Element {
  const [draft, setDraft] = useState<WallpaperCrop>(saved)
  const [dragging, setDragging] = useState(false)

  /**
   * The live crop, for the listeners that outlive a render.
   *
   * The wheel listener is registered once, and the pointer handlers need
   * whatever the draft is mid-drag: reading it from state through a closure
   * would give them the value from the render that created them.
   */
  const draftRef = useRef(draft)

  /**
   * Apply a change from a gesture.
   *
   * A flick of a wheel arrives as dozens of events inside one frame, and React
   * does not render between them: each has to build on the one before rather
   * than on the value the last render saw, or thirty notches come out as one.
   * So the ref is moved as the gesture reads it, and the render below is what
   * keeps it in step with what is actually on screen.
   */
  const show = (next: WallpaperCrop): void => {
    draftRef.current = next
    setDraft(next)
  }
  draftRef.current = draft

  const surfaceRef = useRef<HTMLDivElement>(null)

  /** Wheel travel not yet spent on a notch. */
  const pending = useRef(0)

  /**
   * Where a drag started, in window pixels, and the crop it started from.
   *
   * The move is measured from this origin rather than accumulated per event, so
   * a clamped edge cannot be walked back with the pointer: the picture returns
   * when the pointer does, which is what dragging something feels like.
   */
  const drag = useRef<{
    pointerId: number
    startX: number
    startY: number
    origin: WallpaperCrop
    travel: { x: number; y: number }
  } | null>(null)

  const paint = (crop: WallpaperCrop): void => {
    paintWallpaperPreview(document.documentElement, {
      zoom: crop.zoom,
      positionX: crop.x,
      positionY: crop.y
    })
  }

  // Every move repaints from the draft, which is what makes the picture follow the
  // pointer rather than only moving once the mode is done.
  useEffect(() => {
    paint(draft)
  }, [draft])

  // The settings object changes whenever the app re-reads settings — a window
  // focus resync, a tray menu, another control — and every one of those repaints
  // the wallpaper from the saved crop, dropping a draft the user is halfway
  // through. Repainting a frame later wins that race without depending on the
  // order two effects run in, and a frame is still before the next paint.
  const settings = useApp((state) => state.settings)
  useEffect(() => {
    const frame = requestAnimationFrame(() => paint(draftRef.current))
    return () => cancelAnimationFrame(frame)
  }, [settings])

  // Focus on mount so the arrow keys and Escape work without a click first.
  useEffect(() => {
    surfaceRef.current?.focus()
  }, [])

  /**
   * Animate the zoom, keeping the picture still under `anchor`.
   *
   * Zooming about the window's centre is the obvious behaviour and the wrong
   * one: it slides whatever the user was looking at out of view. `anchor` is a
   * point in window pixels — the pointer for a wheel notch, the middle for a key.
   */
  const zoomBy = (steps: number, anchor: { x: number; y: number }): void => {
    const current = draftRef.current
    const frame = currentWallpaperFrame(current.zoom)
    if (!frame) return
    const zoom = clamp(current.zoom + steps * ZOOM_STEP, MIN_WALLPAPER_ZOOM, MAX_WALLPAPER_ZOOM)
    if (zoom === current.zoom) return
    const size = wallpaperSize(frame.natural, frame.viewport, zoom)
    const position = positionAfterZoom(
      frame.size,
      size,
      frame.viewport,
      { x: current.x, y: current.y },
      anchor
    )
    show({ zoom, x: position.x, y: position.y })
  }

  // Wheel zoom. React's `onWheel` is registered passively, so `preventDefault`
  // there is ignored and the settings panel merrily scrolls under the zoom; the
  // listener has to be attached by hand to be allowed to stop it.
  useEffect(() => {
    const node = surfaceRef.current
    if (!node) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const travel = event.deltaY * (event.deltaMode === 1 ? PIXELS_PER_LINE : 1)
      pending.current += travel
      const notches = Math.trunc(pending.current / WHEEL_NOTCH)
      // Whatever is left of a part-notch stays owed to the next event, so a slow
      // scroll still arrives at the zoom it asked for.
      if (notches === 0) return
      pending.current -= notches * WHEEL_NOTCH
      const rect = node.getBoundingClientRect()
      zoomBy(-notches, { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const frame = currentWallpaperFrame(draftRef.current.zoom)
    if (!frame) return
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: draftRef.current,
      travel: wallpaperTravel(frame.size, frame.viewport)
    }
    setDragging(true)
    try {
      // So a drag that leaves the window keeps panning instead of stopping dead
      // at the edge, which is where the interesting drags end up. A platform that
      // refuses the capture (a pointer already released, say) still gets the
      // drag: the capture only widens where the moves are heard from.
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Nothing to recover: the drag is already under way above.
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null || state.pointerId !== event.pointerId) return
    const position = pannedPosition(
      state.travel,
      { x: state.origin.x, y: state.origin.y },
      { x: event.clientX - state.startX, y: event.clientY - state.startY }
    )
    show({ ...draftRef.current, x: position.x, y: position.y })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  /**
   * Move the picture by one point of its room, in picture pixels.
   *
   * The step goes through the drag mapping rather than straight to the numbers,
   * so the keys and the pointer can never disagree about which way is which.
   */
  const nudge = (steps: { x: number; y: number }): void => {
    const current = draftRef.current
    const frame = currentWallpaperFrame(current.zoom)
    if (!frame) return
    const travel = wallpaperTravel(frame.size, frame.viewport)
    const position = pannedPosition(
      travel,
      { x: current.x, y: current.y },
      { x: (travel.x / 100) * steps.x, y: (travel.y / 100) * steps.y }
    )
    show({ ...current, x: position.x, y: position.y })
  }

  const reset = (): void => {
    // Travel scrolls before the reset is not owed to the crop after it.
    pending.current = 0
    show({ zoom: MIN_WALLPAPER_ZOOM, x: 50, y: 50 })
  }

  const cancel = (): void => {
    paint(saved)
    onClose()
  }

  const commit = (): void => {
    onCommit(tidy(draftRef.current))
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const centre = (): { x: number; y: number } => {
      const frame = currentWallpaperFrame(draftRef.current.zoom)
      return frame === null
        ? { x: 0, y: 0 }
        : { x: frame.viewport.width / 2, y: frame.viewport.height / 2 }
    }

    switch (event.key) {
      case 'Escape':
        // The app closes the detail drawer on Escape, and this mode is not a
        // drawer: the key belongs to the crop while the crop is being adjusted.
        event.stopPropagation()
        cancel()
        return
      case 'Enter':
        event.stopPropagation()
        commit()
        return
      case 'ArrowLeft':
        nudge({ x: -NUDGE, y: 0 })
        break
      case 'ArrowRight':
        nudge({ x: NUDGE, y: 0 })
        break
      case 'ArrowUp':
        nudge({ x: 0, y: -NUDGE })
        break
      case 'ArrowDown':
        nudge({ x: 0, y: NUDGE })
        break
      case '+':
      case '=':
        zoomBy(1, centre())
        break
      case '-':
      case '_':
        zoomBy(-1, centre())
        break
      case 'r':
      case 'R':
        reset()
        break
      default:
        return
    }
    // Reaching here means the key moved something, so it must not also scroll
    // the panel underneath or step the focused button.
    event.preventDefault()
  }

  return (
    <div
      ref={surfaceRef}
      // `no-drag` because the window's caption is a drag region and this layer
      // sits over it: without the opt-out a drag up there would move the window
      // instead of the picture.
      className="no-drag fixed inset-0 z-[65] outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.backgroundAdjust')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/* The crop is what the window shows, so the ring marks the window itself
          rather than a frame drawn inside it. */}
      <div className="pointer-events-none absolute inset-1.5 rounded-xl border-2 border-dashed border-brand/60" />

      <div
        className={cn('absolute inset-0', dragging ? 'cursor-grabbing' : 'cursor-grab')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />

      {/* The wrapper stays transparent to the pointer so a drag near the bottom
          edge still reaches the picture; only the bar itself takes clicks. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-6">
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-surface/95 px-4 py-2 shadow-2xl">
          <span className="hidden text-[11.5px] text-muted sm:block">
            {t('settings.backgroundAdjustHint')}
          </span>
          <span className="text-tabular text-[12px] font-medium text-fg">{draft.zoom}%</span>
          <span className="h-5 w-px bg-line" />
          <Button variant="ghost" size="sm" onClick={reset}>
            {t('settings.backgroundCropReset')}
          </Button>
          <Button variant="ghost" size="sm" onClick={cancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={commit}>
            {t('settings.backgroundAdjustDone')}
          </Button>
        </div>
      </div>
    </div>
  )
}
