import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { tooltipPosition, type AnchorRect } from '@shared/tooltip-position'

interface Tip {
  text: string
  anchor: AnchorRect
}

const SHOW_DELAY = 300

/**
 * One tooltip layer for the whole app, driven by `data-tip`.
 *
 * This replaces the native `title` on icon buttons. `title` is drawn by the OS,
 * so it cannot be kept inside the window — the action at the right edge of a row
 * got a bubble that was itself clipped — and it cannot be themed or tied to
 * keyboard focus. Here the bubble is a portalled fixed element, measured after
 * render and clamped to the viewport by `tooltipPosition`.
 *
 * Hover is delayed so sweeping across a row of icons does not flash a trail of
 * bubbles; keyboard focus shows it immediately, which is the case `title` never
 * handled well.
 */
export function TooltipLayer(): JSX.Element | null {
  const [tip, setTip] = useState<Tip | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: Element | null = null
    let timer: number | undefined

    const hide = (): void => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
      current = null
      setTip(null)
      setPlace(null)
    }

    const reveal = (element: Element): void => {
      const text = element.getAttribute('data-tip')
      if (!text) return
      const rect = element.getBoundingClientRect()
      current = element
      // Position is measured from the rendered bubble, so start hidden.
      setPlace(null)
      setTip({
        text,
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
    }

    const tipTarget = (node: EventTarget | null): Element | null => {
      if (!(node instanceof Element)) return null
      return node.closest('[data-tip]')
    }

    const onPointerOver = (event: PointerEvent): void => {
      const element = tipTarget(event.target)
      if (!element || element === current) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => reveal(element), SHOW_DELAY)
    }

    const onPointerOut = (event: PointerEvent): void => {
      if (!current) return
      const next = event.relatedTarget
      // Moving onto a child of the same button (its icon) is not leaving it.
      if (next instanceof Node && current.contains(next)) return
      hide()
    }

    const onFocusIn = (event: FocusEvent): void => {
      const element = tipTarget(event.target)
      if (!element) return
      if (timer !== undefined) window.clearTimeout(timer)
      reveal(element)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide)
    document.addEventListener('keydown', onKeyDown)
    // Capture so a scroll inside the queue hides the bubble too, not just the page.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)

    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  useLayoutEffect(() => {
    const element = tipRef.current
    if (!tip || !element) return
    setPlace(
      tooltipPosition(
        tip.anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [tip])

  if (!tip) return null

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="pointer-events-none fixed z-[100] max-w-[min(320px,calc(100vw-16px))] rounded-md border border-line bg-elevated px-2 py-1 text-[11.5px] leading-snug text-fg shadow-lg"
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        // Visible only once measured, so it never flashes at the origin.
        visibility: place ? 'visible' : 'hidden'
      }}
    >
      {tip.text}
    </div>,
    document.body
  )
}
