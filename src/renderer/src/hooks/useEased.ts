import { useEffect, useRef, useState } from 'react'

/**
 * Eases a displayed number toward its target on the animation frame clock.
 *
 * The engine reports state once per second, which makes a progress bar look
 * stepped. Easing locally means the bar and the speed readout move at 60fps while
 * still being driven by real measurements. The loop stops issuing renders once it
 * has caught up, so an idle row costs nothing.
 */
export function useEasedNumber(target: number, easing = 0.22): number {
  const [, forceRender] = useState(0)
  const current = useRef(target)
  const goal = useRef(target)
  goal.current = target

  useEffect(() => {
    let frame = 0
    let running = true

    const step = (): void => {
      if (!running) return
      const difference = goal.current - current.current
      if (Math.abs(difference) > 0.0004) {
        current.current += difference * easing
        forceRender((value) => value + 1)
      } else if (current.current !== goal.current) {
        // Snap so the final resting value is exact rather than asymptotically close.
        current.current = goal.current
        forceRender((value) => value + 1)
      }
      frame = requestAnimationFrame(step)
    }

    frame = requestAnimationFrame(step)
    return () => {
      running = false
      cancelAnimationFrame(frame)
    }
  }, [easing])

  return current.current
}

/** Snap immediately when the value should not be animated (e.g. a reset). */
export function useEasedOptional(target: number, animate: boolean, easing = 0.22): number {
  const value = useEasedNumber(target, easing)
  return animate ? value : target
}
