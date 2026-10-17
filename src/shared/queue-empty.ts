/**
 * Why the queue table has nothing to show.
 *
 * The table sees only the already-filtered list, so it cannot tell "the queue is
 * empty" from "the search matched nothing" — and used to tell every one of those
 * cases the same thing: "nothing here yet, add a download", which is the wrong
 * advice when the user is one character away from their data. This stays pure so
 * the priority (search, then category, then status view) can be tested without a
 * DOM; the strings and reset buttons live in `App`.
 *
 * A category or status view with no rows is only worth explaining once the queue
 * itself has something in it; a brand-new install with the "Error" tab selected
 * should still say there is nothing yet rather than describe an empty filter
 * whose reset button leads to another empty screen. A search is always worth
 * naming, because clearing it is a real way back.
 */
export type QueueEmptyReason = 'search' | 'category' | 'status'

export function queueEmptyReason(input: {
  hasSearch: boolean
  hasCategory: boolean
  hasStatus: boolean
  itemCount: number
}): QueueEmptyReason | null {
  if (input.hasSearch) return 'search'
  if (input.hasCategory && input.itemCount > 0) return 'category'
  if (input.hasStatus && input.itemCount > 0) return 'status'
  return null
}
