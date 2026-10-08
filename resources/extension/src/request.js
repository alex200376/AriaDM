/**
 * The extension's loopback request policy.
 *
 * Kept apart from background.js so it can be exercised without a browser:
 * fetching, pairing, config reading and endpoint building are all passed in.
 *
 * Why this exists: re-pairing used to happen only on an HTTP 401, which covers a
 * token the app rotated but not the case that actually bites — the port we stored
 * stops answering, because the app restarted onto another one or was closed.
 * `fetch` then rejects outright, and the user got a bare "Failed to fetch" with
 * no way forward except the reconnect button. Every request now earns exactly one
 * automatic repair, so a moved endpoint heals itself and a closed app reports
 * something a person can act on.
 */
;(function (root) {
  /**
   * A message from the shared table.
   *
   * `strings.js` is loaded before this file (see the manifest and popup.html), so
   * the table is there in the browser; the key comes back when it is not, which
   * names the mistake rather than showing the wrong language.
   */
  const s = (key, substitutions) =>
    root.AriaDmStrings ? root.AriaDmStrings.t(key, substitutions) : key

  /**
   * Human text for a transport failure.
   *
   * The raw DOM message is "Failed to fetch", which tells the user nothing and
   * made a closed app look like a broken extension.
   */
  function describeError(error) {
    const raw = String((error && error.message) || error || '')
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
      return s('error.connect')
    }
    return raw || s('error.unknown')
  }

  /**
   * One loopback request, with at most one repair attempt.
   *
   * Only one, deliberately: a genuinely unreachable app has to report back
   * promptly rather than retry against a port that is never coming back.
   */
  async function requestWithRepair(deps, config, path, init) {
    const send = () =>
      deps.fetch(deps.endpoint(config, path), {
        ...(init || {}),
        headers: { ...((init && init.headers) || {}), 'x-ariadm-token': config.token }
      })

    /** Re-pair, then adopt whatever port and token the app handed back. */
    const repair = async () => {
      let paired = null
      try {
        paired = await deps.pair()
      } catch {
        return false
      }
      if (!paired || !paired.ok) return false
      Object.assign(config, await deps.getConfig())
      return true
    }

    try {
      const response = await send()
      if (response.status !== 401) return response
    } catch (error) {
      // Nothing answered at all: the endpoint moved or the app is gone. Give the
      // repair a chance, and if pairing fails let the original error through so
      // the caller can report "unreachable" rather than a silent nothing.
      if (!(await repair())) throw error
      return send()
    }

    // A rotated token. When pairing cannot be redone, still retry once: the
    // caller's error handling is a better place to decide what to say.
    if (!(await repair())) return send()
    return send()
  }

  root.AriaDmRequest = { describeError, requestWithRepair }
})(typeof self !== 'undefined' ? self : globalThis)
