import { describe, expect, it } from 'vitest'

import { bounded } from '../../src/main/bounded'

/**
 * Every shutdown step runs through this, because a step that never returns used
 * to stall the quit sequence for minutes — and during an update the installer
 * was waiting on the other end of it.
 */
describe('bounded', () => {
  it('reports a promise that finished', async () => {
    expect(await bounded(Promise.resolve('ok'), 50)).toEqual({ outcome: 'done' })
  })

  it('reports a rejection as a failure rather than throwing', async () => {
    const result = await bounded(Promise.reject(new Error('nope')), 50)

    expect(result.outcome).toBe('failed')
    expect(result.error?.message).toBe('nope')
  })

  it('gives up on a promise that never settles', async () => {
    const started = Date.now()
    const result = await bounded(new Promise(() => {}), 30)

    expect(result.outcome).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('honours a promise that settles just before the deadline', async () => {
    const result = await bounded(
      new Promise((resolve) => setTimeout(resolve, 10)),
      1_000
    )

    expect(result.outcome).toBe('done')
  })
})
