import { describe, expect, it } from 'vitest'

import { queueEmptyReason } from '@shared/queue-empty'

describe('queueEmptyReason', () => {
  it('explains a search before anything else', () => {
    // Search wins over category and status: it is the narrowest and the easiest
    // to undo, and the reset button clears exactly that.
    expect(queueEmptyReason({ hasSearch: true, hasCategory: true, hasStatus: true, itemCount: 8 })).toBe('search')
  })

  it('falls back to the category when there is no search', () => {
    expect(queueEmptyReason({ hasSearch: false, hasCategory: true, hasStatus: true, itemCount: 8 })).toBe('category')
  })

  it('explains an empty status view only when the queue has downloads', () => {
    expect(queueEmptyReason({ hasSearch: false, hasCategory: false, hasStatus: true, itemCount: 8 })).toBe('status')
  })

  it('leaves a brand-new empty queue to the "nothing here yet" state', () => {
    // Selecting "Failed" (or a category) on a fresh install must not describe a
    // filter; there is nothing to filter yet, and "add a download" is the useful
    // advice. A search is different: naming it is a real way back.
    expect(queueEmptyReason({ hasSearch: false, hasCategory: true, hasStatus: true, itemCount: 0 })).toBeNull()
    expect(queueEmptyReason({ hasSearch: true, hasCategory: true, hasStatus: true, itemCount: 0 })).toBe('search')
    expect(queueEmptyReason({ hasSearch: false, hasCategory: false, hasStatus: false, itemCount: 0 })).toBeNull()
  })
})
