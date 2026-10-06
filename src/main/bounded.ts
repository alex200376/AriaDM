/**
 * Running a teardown step without letting it hold the app open.
 *
 * Every shutdown step here talks to something outside the process — a child
 * process, an HTTP server, the disk — and any of them can fail to answer. When
 * one of them hangs, the old shutdown simply never finished, and the update
 * installer waiting for this process to exit was never launched. From the user's
 * side that is indistinguishable from pressing install and having nothing
 * happen, which is exactly the bug this exists to prevent.
 *
 * So no step is awaited bare any more: each one gets a deadline, and whatever it
 * does after that deadline is the operating system's problem.
 */

export type BoundedOutcome = 'done' | 'timeout' | 'failed'

export interface BoundedResult {
  outcome: BoundedOutcome
  /** Present only when `outcome` is 'failed'. */
  error?: Error
}

/** A bounded wait that keeps the answer: the value, or why there was none. */
export interface BoundedValue<T> {
  outcome: BoundedOutcome
  /** Present only when `outcome` is 'done'. */
  value?: T
  /** Present only when `outcome` is 'failed'. */
  error?: Error
}

/**
 * Await `promise`, but never for longer than `ms`, and keep its value.
 *
 * A rejection is reported as `'failed'` rather than thrown, and a promise that
 * outlives the deadline is left running (only the wait ends). The returned
 * promise itself never rejects. This is what lets a slow answer — a format probe
 * on a site that refuses the session — be abandoned without being cancelled.
 */
export async function boundedValue<T>(promise: Promise<T>, ms: number): Promise<BoundedValue<T>> {
  let timer: NodeJS.Timeout | undefined

  const deadline = new Promise<BoundedValue<T>>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: 'timeout' }), ms)
    // Never let the watchdog itself keep the process alive.
    timer.unref?.()
  })

  try {
    const settled = promise.then<BoundedValue<T>, BoundedValue<T>>(
      (value) => ({ outcome: 'done', value }),
      (error: unknown) => ({
        outcome: 'failed',
        error: error instanceof Error ? error : new Error(String(error))
      })
    )
    return await Promise.race([settled, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Await `promise`, but never for longer than `ms`.
 *
 * A rejection is reported as `'failed'` rather than thrown: during a shutdown a
 * failing step is information to log, not a reason to abandon the remaining
 * steps. The returned promise itself never rejects.
 */
export async function bounded(promise: Promise<unknown>, ms: number): Promise<BoundedResult> {
  const { outcome, error } = await boundedValue(promise, ms)
  return error ? { outcome, error } : { outcome }
}
