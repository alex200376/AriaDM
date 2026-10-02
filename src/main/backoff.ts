/**
 * Delay before the next retry, capped at `maxMs`.
 *
 * Both fixed-port listeners retry the same way: double the wait after each
 * consecutive failure until it stops being worth waiting longer. Keeping the
 * formula in one place is what stops the handoff endpoint and the discovery
 * listener from drifting into two subtly different curves.
 *
 * `attempt` is 1-based (`1` is the delay after the first failure), so the first
 * wait is exactly `baseMs`.
 */
export function nextBackoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const step = Math.max(1, Math.floor(attempt))
  return Math.min(baseMs * 2 ** (step - 1), maxMs)
}
