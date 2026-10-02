/**
 * Select-all arithmetic for the download table.
 *
 * Kept in `shared` rather than next to the store so it can be tested without a
 * DOM, and so the renderer never has to re-derive it.
 */

/**
 * What the table header's select-all checkbox should produce next.
 *
 * "All" means every row the user can currently see, which is what `Ctrl+A` and
 * the row click already act on — a row hidden by the search box or the category
 * filter is not something this control can claim to have selected.
 *
 * Pressing it while everything is already selected clears the selection, so the
 * checkbox toggles rather than only ever adding. An empty list is left alone
 * instead of clearing a selection the user cannot see the reason for.
 */
export function nextSelectionAfterSelectAll(selection: string[], visibleGids: string[]): string[] {
  if (visibleGids.length === 0) return selection
  const chosen = new Set(selection)
  return visibleGids.every((gid) => chosen.has(gid)) ? [] : [...visibleGids]
}
