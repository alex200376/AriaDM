/**
 * Turning the app's quality answer into menu rows.
 *
 * Shared because two places render the same menu — the on-page panel and the
 * toolbar popup — and a list of qualities that reads differently depending on
 * which one you opened would be a bug the user has to notice twice.
 *
 * The app decides what the choices *are* (see its `formatChoices`): it knows
 * whether ffmpeg is installed and what this session can actually fetch. This
 * file only decides how they read.
 */
;(function (root) {
  /**
   * A label from the shared table.
   *
   * `strings.js` is loaded before this file in every context that uses it (see
   * the manifest's `content_scripts` order and `popup.html`), so the table is
   * always there in the browser. The key is returned when it is not, which names
   * the mistake instead of silently showing the wrong language.
   */
  const s = (key, substitutions) =>
    root.AriaDmStrings ? root.AriaDmStrings.t(key, substitutions) : key

  /** A file size a person can compare at a glance. */
  function sizeLabel(bytes) {
    if (!bytes || bytes < 0) return ''
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    // One decimal where it tells you something — 22.1 MB, 1.0 GB — and a round
    // number where it would just be noise at that magnitude.
    const shown = unit > 0 && value < 100 ? value.toFixed(1) : Math.round(value)
    return `${shown} ${units[unit]}`
  }

  /**
   * The menu for one probe result.
   *
   * The first row is the download the button would have made on its own, so
   * opening the menu never takes away the one-click path. `formatId: ''` is what
   * asks the app to choose, which is exactly what it did before this menu.
   */
  function menuFor(result) {
    const rows = [{ formatId: '', label: s('menu.auto'), note: '' }]
    for (const format of (result && result.formats) || []) {
      if (!format || !format.formatId) continue
      rows.push({
        formatId: format.formatId,
        label: format.label || format.formatId,
        note: [format.note, sizeLabel(format.filesize)].filter(Boolean).join(' · ')
      })
    }
    return rows
  }

  root.AriaDmFormats = { sizeLabel, menuFor }
})(typeof self !== 'undefined' ? self : globalThis)
