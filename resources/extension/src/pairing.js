/**
 * Pairing with the desktop app.
 *
 * AriaDM listens on a small set of fixed loopback ports whose only job is to
 * answer "where is the real endpoint, and what is the token?". That is what lets
 * this extension work with nothing typed in. It previously asked the user to copy
 * a token out of Settings and type a port, and shipped a default port of 6800 —
 * aria2's RPC port — so a fresh install simply never connected.
 *
 * A *list* of ports rather than one because the obvious single choice, 7070, is
 * also AnyDesk's default direct-connection port. When it is taken the app cannot
 * bind it, and a one-port extension retries a stranger's socket forever, which
 * looks exactly like "auto setup never detects the app".
 *
 * Loaded as a plain script by both the background worker and the popup, so it
 * defines one global rather than using module syntax.
 */
;(function () {
  /** Must match HANDOFF_DISCOVERY_PORTS in src/shared/ipc.ts, in the same order. */
  const DISCOVERY_PORTS = [7070, 7071, 7072, 7073, 7074]

  /** Keys this module owns in chrome.storage.local. */
  const KEYS = ['port', 'token', 'pairedAt', 'pairError', 'discoveryPort']

  const DISCOVERY_HOST = '127.0.0.1'

  function discoverUrl(port) {
    return `http://${DISCOVERY_HOST}:${port}/discover`
  }

  /**
   * Ask one port where the app is.
   *
   * Aborted on a short timer because the awkward case is a *different* program
   * holding the port and accepting the connection without answering; a port with
   * nothing on it refuses immediately, so the common misses cost nothing.
   */
  async function probe(port, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(discoverUrl(port), { signal: controller.signal, cache: 'no-store' })
      if (!response.ok) return null
      const body = await response.json()
      if (!body || body.app !== 'AriaDM' || typeof body.port !== 'number' || typeof body.token !== 'string') {
        return null
      }
      // The port that answered, so a failure can be explained and a success
      // reported without guessing.
      return { ...body, discoveryPort: port }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Walk the candidate ports until one identifies itself as AriaDM.
   *
   * The identity check matters more than it looks: a port held by another
   * program must not be mistaken for the app, or the extension would store a
   * stranger's port and token.
   */
  async function discover(timeoutMs = 800) {
    for (const port of DISCOVERY_PORTS) {
      const found = await probe(port, timeoutMs)
      if (found) return found
    }
    return null
  }

  /** Discover and store the endpoint. Safe to call on every startup. */
  async function pair() {
    const found = await discover()
    if (!found) {
      await chrome.storage.local.set({
        pairError:
          `找不到 AriaDM（已嘗試連接埠 ${DISCOVERY_PORTS.join('、')}）。` +
          '請確認應用程式正在執行，且「設定 → 整合與工具」中已啟用瀏覽器整合。',
        discoveryPort: null
      })
      return { ok: false, error: 'not-found', ports: DISCOVERY_PORTS.slice() }
    }

    await chrome.storage.local.set({
      port: found.port,
      token: found.token,
      pairedAt: Date.now(),
      pairError: '',
      discoveryPort: found.discoveryPort
    })
    return { ok: true, port: found.port, discoveryPort: found.discoveryPort, version: found.version ?? '' }
  }

  /** Forget a stored endpoint, so the next call pairs from scratch. */
  async function unpair() {
    await chrome.storage.local.remove(['port', 'token', 'pairedAt', 'discoveryPort'])
  }

  async function status() {
    const stored = await chrome.storage.local.get(KEYS)
    return {
      port: typeof stored.port === 'number' ? stored.port : null,
      hasToken: Boolean(stored.token),
      pairedAt: stored.pairedAt ?? null,
      pairError: stored.pairError ?? '',
      discoveryPort: typeof stored.discoveryPort === 'number' ? stored.discoveryPort : null
    }
  }

  self.AriaDmPairing = { DISCOVERY_PORTS, DISCOVERY_HOST, discoverUrl, KEYS, discover, probe, pair, unpair, status }
})()
