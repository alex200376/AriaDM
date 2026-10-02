import { describe, expect, it } from 'vitest'

import { nextSelectionAfterSelectAll } from '@shared/selection'

describe('nextSelectionAfterSelectAll', () => {
  it('selects every visible row when nothing is selected', () => {
    expect(nextSelectionAfterSelectAll([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('selects the missing rows when only some are selected', () => {
    expect(nextSelectionAfterSelectAll(['b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('clears the selection once every visible row is selected', () => {
    expect(nextSelectionAfterSelectAll(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([])
  })

  it('keeps the selection when there is nothing visible to select', () => {
    // Clearing here would silently drop a selection the user made in another
    // view, so an empty list is a no-op.
    expect(nextSelectionAfterSelectAll(['a'], [])).toEqual(['a'])
  })

  it('ignores selected gids that are not visible', () => {
    // 'z' is filtered out by the search box: it must not make the control think
    // everything is already selected.
    expect(nextSelectionAfterSelectAll(['a', 'z'], ['a', 'b'])).toEqual(['a', 'b'])
    // ...and it is dropped, because the new selection is exactly the visible set.
    expect(nextSelectionAfterSelectAll(['a', 'b', 'z'], ['a', 'b'])).toEqual([])
  })
})
