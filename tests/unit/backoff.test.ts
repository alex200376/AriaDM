import { describe, expect, it } from 'vitest'

import { nextBackoffDelay } from '../../src/main/backoff'

describe('nextBackoffDelay', () => {
  it('waits the base delay after the first failure', () => {
    expect(nextBackoffDelay(1, 2_000, 30_000)).toBe(2_000)
  })

  it('doubles the wait after each consecutive failure', () => {
    expect(nextBackoffDelay(2, 2_000, 30_000)).toBe(4_000)
    expect(nextBackoffDelay(3, 2_000, 30_000)).toBe(8_000)
    expect(nextBackoffDelay(4, 2_000, 30_000)).toBe(16_000)
  })

  it('caps the wait at the maximum instead of growing without bound', () => {
    // The uncapped curve would be 1_024_000ms here; a listener that slept 17
    // minutes between retries would look permanently dead.
    expect(nextBackoffDelay(10, 2_000, 30_000)).toBe(30_000)
    expect(nextBackoffDelay(50, 2_000, 30_000)).toBe(30_000)
  })

  it('never waits less than the base, even for a nonsense attempt count', () => {
    expect(nextBackoffDelay(0, 2_000, 30_000)).toBe(2_000)
    expect(nextBackoffDelay(-5, 2_000, 30_000)).toBe(2_000)
  })

  it('is monotonic until it reaches the cap', () => {
    let previous = 0
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const delay = nextBackoffDelay(attempt, 5_000, 60_000)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
    expect(previous).toBe(60_000)
  })
})
