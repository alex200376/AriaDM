/**
 * Browser-download interception, kept apart from background.js.
 *
 * Why this exists: the decision used to be read straight from an in-memory copy
 * of the config, and a service worker that has just been woken starts with the
 * defaults in memory — where interception is off. Chrome evaluates the worker
 * top to bottom and can dispatch `chrome.downloads.onCreated` before the stored
 * config has come back, so the first download after the worker went idle was
 * silently left to the browser. The decision here is never made from a config
 * that has not been read yet.
 *
 * Everything a browser would supply (cancelling, handing over, putting the
 * download back) is passed in, so this file is a plain script that can be
 * exercised without Chrome — see tests/unit/extension-intercept.test.ts.
 */
;(function (root) {
  /** Long enough for a busy app to answer, short enough to not look like a hang. */
  const RETRY_DELAY_MS = 700

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Whether a download is one the app can take at all.
   *
   * A `blob:` or `data:` URL only exists inside the page that made it, so the
   * app could not fetch it even if it were asked to.
   */
  function usable(item) {
    if (!item || !item.url) return false
    return !item.url.startsWith('blob:') && !item.url.startsWith('data:')
  }

  /**
   * Handle one `chrome.downloads.onCreated` event.
   *
   * `deps` is the browser: `isIgnored` (an entry we re-created ourselves),
   * `isHydrated`/`hydration` (whether the stored config has been read yet),
   * `isEnabled` (the config's answer), `cleanup`, `payloadFor`, `handoff`,
   * `restore` and `notify`.
   */
  async function handleCreated(item, deps) {
    // The safety net re-creates the download through the browser's own API,
    // which fires this event again. Without this the pair would take turns
    // cancelling each other forever.
    if (deps.isIgnored(item)) return { ok: true, action: 'ignored' }
    if (!usable(item)) return { ok: true, action: 'skipped' }

    /*
     * Wait for the config before deciding anything.
     *
     * Note that this happens *before* the cancel: the alternative — cancelling
     * on the assumption that the setting might be on — would cancel downloads
     * for every user who has interception switched off. Nothing is lost by
     * waiting, because a download the browser already finished is cancelled and
     * deleted by `cleanup` just the same.
     */
    if (!deps.isHydrated() && deps.hydration) await deps.hydration.catch(() => {})
    if (!deps.isEnabled()) return { ok: true, action: 'idle' }

    /*
     * Cancel the browser's copy and start the handoff at the same time: they do
     * not depend on each other, and the browser keeps writing the file for every
     * millisecond the cancel spends waiting on a loopback round trip.
     */
    const cleanup = Promise.resolve()
      .then(() => deps.cleanup(item))
      .catch(() => {})

    const payload = await deps.payloadFor(item.url, undefined, false)
    if (item.filename) payload.filename = deps.basename(item.filename)

    // One retry: the usual reason a handoff fails is temporary — the app was
    // starting, or it rotated its token and the repair is already in flight.
    // `deps.delay` is injectable purely so a test does not have to wait it out.
    const wait = deps.delay ?? delay
    let sent = await deps.handoff(payload)
    if (!sent || sent.ok !== true) {
      await wait(RETRY_DELAY_MS)
      sent = await deps.handoff(payload)
    }

    await cleanup
    if (sent && sent.ok === true) return { ok: true, action: 'handed-off' }

    /*
     * The app could not take it — closed, still starting, or it refused the
     * URL. Put the download back in the browser's hands rather than leaving it
     * deleted: the user asked for this file, and "AriaDM is not running" is not
     * a reason to lose it.
     */
    const reason = (sent && sent.error) || deps.unknownError()
    const restored = await deps.restore(item)
    await deps.notify(reason, restored)
    return { ok: false, action: 'restored', error: reason }
  }

  root.AriaDmIntercept = { handleCreated, usable, RETRY_DELAY_MS }
})(typeof self !== 'undefined' ? self : globalThis)
