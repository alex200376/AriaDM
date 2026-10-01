/**
 * AriaDM browser handoff.
 *
 * Talks to the desktop app's loopback handoff API, which authenticates every
 * request with a shared token. Pairing is automatic (see pairing.js) so the user
 * never types a port or a token; the token still never leaves local storage, and
 * the API only accepts requests whose Origin is an extension, so a web page
 * cannot drive a download on the user's behalf.
 */

// Chrome runs this as a service worker; Firefox lists request.js and pairing.js
// first in the manifest's background.scripts instead.
if (typeof importScripts === 'function') importScripts('request.js', 'pairing.js')

const DEFAULTS = {
  port: null,
  token: '',
  autoIntercept: false,
  notify: true,
  /** True when the user pinned an endpoint by hand in the popup's advanced section. */
  manual: false
}

const MENU_LINK = 'ariadm-download-link'
const MENU_MEDIA = 'ariadm-download-media'
const MENU_PAGE = 'ariadm-download-page'

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS))
  return { ...DEFAULTS, ...stored }
}

/**
 * The last known config, kept in memory so download interception can decide
 * without awaiting.
 *
 * This is what fixes "it downloads twice". `getConfig()` is async, and the
 * browser starts writing the file the moment the download is created; awaiting
 * storage before cancelling gave a small file time to finish, leaving the
 * browser's copy next to the one AriaDM was asked to make.
 */
let cachedConfig = { ...DEFAULTS }

async function refreshConfig() {
  cachedConfig = await getConfig()
  return cachedConfig
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  for (const [key, change] of Object.entries(changes)) {
    if (key in DEFAULTS) cachedConfig[key] = change.newValue
  }
})

// Warm the cache as soon as the worker wakes, so the first intercepted download
// is not a special case.
void refreshConfig()

function endpoint(config, path) {
  return `http://127.0.0.1:${config.port}${path}`
}

/**
 * What the shared request policy needs from this file.
 *
 * Passed in rather than reached for, so the retry behaviour can be exercised
 * without a browser or a running app (see tests/unit/extension-request.test.ts).
 */
function requestDeps() {
  return {
    endpoint,
    getConfig,
    fetch: (...args) => fetch(...args),
    pair: () => self.AriaDmPairing.pair()
  }
}

/** Cached because every handoff asks, and it never changes at runtime. */
let mediaSitesPromise = null

function mediaSites() {
  if (!mediaSitesPromise) {
    mediaSitesPromise = fetch(chrome.runtime.getURL('media-sites.json'))
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])
  }
  return mediaSitesPromise
}

/** The media-site suffix this URL belongs to, or null. */
function matchMediaHost(url, sites) {
  if (!url) return null
  let host
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    host = parsed.hostname.toLowerCase()
  } catch {
    return null
  }
  return sites.find((site) => host === site || host.endsWith(`.${site}`)) ?? null
}

async function ping() {
  const config = await getConfig()
  if (!config.port || !config.token) return { ok: false, error: '尚未配對' }
  try {
    // Through the shared policy, so a stale stored port is repaired here too and
    // the badge tells the truth rather than staying OFF until the user notices.
    const response = await self.AriaDmRequest.requestWithRepair(requestDeps(), config, '/ping')
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, ...(await response.json()) }
  } catch (error) {
    return { ok: false, error: self.AriaDmRequest.describeError(error) }
  }
}

/**
 * The toolbar badge is how the user knows the extension set itself up.
 *
 * Without it, a correctly paired extension and a broken one look identical — a
 * grey icon — and the failure only shows up later, as a download that never
 * arrives.
 */
async function updateBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) return
  const status = await ping()
  const paired = Boolean(status.ok)

  // Naming the port that answered turns "it doesn't detect" into something the
  // user can act on, and makes it obvious when the app fell back off 7070
  // because another program (AnyDesk, typically) already owns it.
  const pairing = await self.AriaDmPairing.status()

  chrome.action.setBadgeBackgroundColor({ color: paired ? '#2f9e6b' : '#c0453a' })
  chrome.action.setBadgeText({ text: paired ? 'ON' : 'OFF' })
  chrome.action.setTitle({
    title: paired
      ? `AriaDM：已連線${pairing.discoveryPort ? `（自動配對 :${pairing.discoveryPort}）` : ''}`
      : 'AriaDM：未連線（請啟動 AriaDM 桌面程式）'
  })
  return { ...status, discoveryPort: pairing.discoveryPort, pairError: pairing.pairError }
}

/**
 * Keep trying to pair, quietly.
 *
 * The app may be started after the browser, or installed later, so a single
 * attempt at browser start would leave the extension dead until the user
 * reloaded it. A one-minute alarm is the cheapest way to self-heal.
 */
async function ensurePaired() {
  const config = await getConfig()
  if (config.manual) return updateBadge()

  const status = await updateBadge()
  if (status.ok) return status

  await self.AriaDmPairing.pair()
  return updateBadge()
}

/** Cookies are collected here rather than in the app because only the browser has them. */
async function cookieHeaderFor(url) {
  if (!chrome.cookies || !url || !/^https?:/i.test(url)) return ''
  try {
    const cookies = await chrome.cookies.getAll({ url })
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  } catch {
    return ''
  }
}

/**
 * Offer this browser's session for a URL to the app.
 *
 * `chrome.cookies.getAll` answers for any URL, not just the tab that happens to
 * be open, so this works for a link the user pasted into AriaDM as well as for a
 * page they are looking at.
 */
async function offerCookies(url) {
  const config = await getConfig()
  if (!config.port || !config.token) return { ok: false, error: '尚未配對' }

  const cookies = await cookieHeaderFor(url)
  if (!cookies) return { ok: false, error: '這個網址沒有可用的 Cookie' }

  try {
    // The shared policy re-pairs and retries once on either a rotated token or a
    // port that stopped answering, which is what makes this button work after the
    // app has restarted.
    const response = await self.AriaDmRequest.requestWithRepair(requestDeps(), config, '/cookies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, cookies })
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const body = await response.json().catch(() => ({}))
    return { ok: true, accepted: body.accepted === true }
  } catch (error) {
    return { ok: false, error: self.AriaDmRequest.describeError(error) }
  }
}

/**
 * Answer the app when it is waiting for a login.
 *
 * The app records the host whenever a download fails for cookie reasons (see its
 * `withExtensionCookies`), and this is what turns that into a working download:
 * one loopback request says "x.com is waiting", and the session follows. It runs
 * on the same one-minute alarm as pairing, and immediately when the popup opens.
 */
async function serveCookieRequest() {
  const config = await getConfig()
  if (!config.port || !config.token) return { ok: false, error: '尚未配對' }

  try {
    const response = await self.AriaDmRequest.requestWithRepair(requestDeps(), config, '/cookie-request', {
      cache: 'no-store'
    })
    // 204 means nothing is waiting, which is the common case.
    if (response.status !== 200) return { ok: true, url: '' }

    const { url } = await response.json()
    if (!url) return { ok: true, url: '' }

    const offered = await offerCookies(url)
    if (offered.ok && offered.accepted) notify('AriaDM 已取得登入狀態', `已把 ${new URL(url).host} 的 Cookie 傳給 AriaDM。`)
    return { ok: true, url, sent: Boolean(offered.ok && offered.accepted), error: offered.error ?? '' }
  } catch (error) {
    return { ok: false, error: self.AriaDmRequest.describeError(error) }
  }
}

function notify(title, message) {
  if (!chrome.notifications) return
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message
  })
}

/**
 * Ask the app what a page can be downloaded as.
 *
 * The extension cannot answer this itself: only the app knows whether ffmpeg is
 * installed, and only it can spend a yt-dlp run on resolving the page. So the
 * menu it renders is always the app's answer for this exact page and session.
 */
async function probeFormats(url) {
  const config = await getConfig()
  if (!config.port || !config.token) return { ok: false, error: 'not-paired' }

  const cookies = await cookieHeaderFor(url)
  try {
    const response = await self.AriaDmRequest.requestWithRepair(requestDeps(), config, '/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, ...(cookies ? { cookies } : {}) })
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      return { ok: false, error: body.error || `HTTP ${response.status}` }
    }
    const body = await response.json().catch(() => ({}))
    return {
      ok: true,
      title: body.title ?? '',
      defaultFormatId: body.defaultFormatId ?? '',
      formats: Array.isArray(body.formats) ? body.formats : []
    }
  } catch (error) {
    return { ok: false, error: self.AriaDmRequest.describeError(error) }
  }
}

/** Long enough for a slow site, short enough that a busy button is not a hang. */
const PROBE_BUDGET_MS = 20_000

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ])
}

/**
 * The single "download this video" path, shared by the toolbar popup and the
 * on-page panel.
 *
 * With no `formatId` it asks the app what the page offers and returns either the
 * finished handoff or a menu for the caller to render. Anything that gets in the
 * way of that — a page yt-dlp cannot enumerate, an app that is not answering, a
 * probe that is taking too long — falls through to the plain handoff, so the
 * button behaves exactly as it did before the menu existed rather than refusing.
 */
async function downloadVideo(message) {
  const url = message.url
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: '這個頁面無法下載' }

  if (!message.formatId) {
    const probe = await withTimeout(probeFormats(url), PROBE_BUDGET_MS)
    // One choice is not a choice — but anything else gets a menu.
    if (probe?.ok && probe.formats.length > 1) {
      return {
        ok: true,
        mode: 'choose',
        title: probe.title,
        defaultFormatId: probe.defaultFormatId,
        formats: probe.formats
      }
    }
  }

  const payload = { urls: [url], media: true }
  if (message.referer) payload.referer = message.referer
  if (message.formatId) payload.formatId = message.formatId
  payload.userAgent = navigator.userAgent
  const cookies = await cookieHeaderFor(url)
  if (cookies) payload.cookies = cookies

  const result = await handoff(payload)
  return result.ok ? { ...result, mode: 'sent' } : result
}

async function handoff(payload) {
  let config = await getConfig()
  if (!config.port || !config.token) {
    // First run, or the user cleared storage: pair on demand rather than telling
    // them to go and find a token.
    const paired = await self.AriaDmPairing.pair()
    config = await getConfig()
    if (!config.port || !config.token) {
      notify(
        'AriaDM 未連線',
        paired.ok
          ? '請先啟動 AriaDM 桌面應用程式。'
          : `找不到 AriaDM。請啟動桌面應用程式，並確認「設定 → 整合與工具」中的瀏覽器整合已啟用。`
      )
      return { ok: false, error: 'not-paired' }
    }
  }

  try {
    // The shared policy absorbs both a rotated token and a stored port that has
    // stopped answering, so a handoff survives the app being reopened.
    const response = await self.AriaDmRequest.requestWithRepair(requestDeps(), config, '/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const body = await response.json().catch(() => ({}))

    if (!response.ok || body.ok === false) {
      const message = body.error || `HTTP ${response.status}`
      notify('AriaDM 無法接收', message)
      return { ok: false, error: message }
    }

    /*
     * Success is deliberately silent. The on-page panel and the popup both show
     * the result inline, and a toast for every handoff turned "send this page's
     * 30 links" into 30 notifications. Only things the user cannot see there —
     * warnings and failures — are worth a toast.
     */
    for (const warning of body.warnings ?? []) notify('AriaDM 提示', warning)
    void updateBadge()
    return { ok: true, ...body }
  } catch (error) {
    const message = self.AriaDmRequest.describeError(error)
    notify('AriaDM 沒有回應', message)
    return { ok: false, error: message }
  }
}

/** Fill in the details a browser knows and a naked URL does not. */
async function payloadFor(url, tabId, media) {
  const payload = { urls: [url] }
  if (media) payload.media = true

  let tab = null
  if (tabId !== undefined) {
    tab = await chrome.tabs.get(tabId).catch(() => null)
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = active || null
  }

  if (tab?.url) payload.referer = tab.url
  payload.userAgent = navigator.userAgent

  const cookies = await cookieHeaderFor(url)
  if (cookies) payload.cookies = cookies
  return payload
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_LINK, title: '用 AriaDM 下載連結', contexts: ['link'] })
    chrome.contextMenus.create({ id: MENU_MEDIA, title: '用 AriaDM 下載媒體', contexts: ['image', 'video', 'audio'] })
    chrome.contextMenus.create({ id: MENU_PAGE, title: '用 AriaDM 下載此頁面', contexts: ['page'] })
  })
}

const PAIR_ALARM = 'ariadm-keep-paired'

async function autoPair() {
  const config = await getConfig()
  // Never overwrite an endpoint the user pinned by hand.
  if (config.manual) return updateBadge()
  await self.AriaDmPairing.pair()
  return updateBadge()
}

function watchConnection() {
  if (!chrome.alarms) return
  chrome.alarms.create(PAIR_ALARM, { periodInMinutes: 1 })
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === PAIR_ALARM) {
    // Pair first: asking an app that is not running would log a connection error
    // on every single tick.
    void ensurePaired().then((status) => {
      if (status?.ok) void serveCookieRequest()
    })
  }
})

chrome.runtime.onInstalled.addListener(() => {
  createMenus()
  chrome.storage.local.get(Object.keys(DEFAULTS)).then((stored) => {
    const missing = {}
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (stored[key] === undefined) missing[key] = value
    }
    if (Object.keys(missing).length > 0) chrome.storage.local.set(missing)
    cachedConfig = { ...DEFAULTS, ...stored, ...missing }
  })
  watchConnection()
  void autoPair()
})

chrome.runtime.onStartup.addListener(() => {
  createMenus()
  watchConnection()
  void autoPair()
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const sites = await mediaSites()

  if (info.menuItemId === MENU_LINK) {
    const url = info.linkUrl
    if (!url) return
    await handoff(await payloadFor(url, tab?.id, false))
    return
  }

  // Right-clicking the player or the page on a media site means "this video",
  // and the element's own src is usually a stream fragment only the page can
  // fetch — so send the page and let yt-dlp resolve it.
  const onMediaPage = matchMediaHost(tab?.url, sites) !== null
  const url = info.menuItemId === MENU_MEDIA && !onMediaPage ? info.srcUrl : info.pageUrl
  if (!url) return
  await handoff(await payloadFor(url, tab?.id, onMediaPage))
})

/**
 * Download interception.
 *
 * The browser starts the download before we can speak, so the only way to hand
 * it over is to cancel it and re-issue it in AriaDM. That is exactly what IDM
 * does, and it is why this is opt-in: cancelling a download the browser was
 * already handling is a visible side effect.
 */
chrome.downloads.onCreated.addListener((item) => {
  // Nothing is awaited before the cancel: see the note on `cachedConfig`.
  if (!cachedConfig.autoIntercept) return
  if (!item.url || item.url.startsWith('blob:') || item.url.startsWith('data:')) return

  /*
   * Cancel first, then delete whatever the browser already wrote, then forget
   * the record. `erase` on its own only removes the download *entry* and leaves
   * the file on disk, which is the other half of the duplicate: the browser's
   * copy stayed behind even when the handoff succeeded.
   *
   * `cancel` fails on a download that already finished and `removeFile` fails on
   * one still in progress, so both are best-effort — between them every state is
   * covered.
   */
  void chrome.downloads
    .cancel(item.id)
    .catch(() => {})
    .then(() => chrome.downloads.removeFile(item.id).catch(() => {}))
    .then(() => chrome.downloads.erase({ id: item.id }).catch(() => {}))
    .then(async () => {
      const payload = await payloadFor(item.url, undefined, false)
      if (item.filename) payload.filename = item.filename.split(/[/\\]/).pop()
      await handoff(payload)
    })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') {
    ping().then(sendResponse)
    return true
  }
  if (message?.type === 'status') {
    ensurePaired().then(sendResponse)
    return true
  }
  if (message?.type === 'handoff') {
    handoff(message.payload).then(sendResponse)
    return true
  }
  if (message?.type === 'downloadVideo') {
    downloadVideo(message).then(sendResponse)
    return true
  }
  if (message?.type === 'offerCookies') {
    offerCookies(message.url).then(sendResponse)
    return true
  }
  if (message?.type === 'serveCookieRequest') {
    serveCookieRequest().then(sendResponse)
    return true
  }
  if (message?.type === 'config') {
    getConfig().then(sendResponse)
    return true
  }
  if (message?.type === 'mediaSites') {
    mediaSites().then((sites) => sendResponse({ sites }))
    return true
  }
  if (message?.type === 'pair') {
    self.AriaDmPairing.pair().then(() => updateBadge()).then(sendResponse)
    return true
  }
  if (message?.type === 'unpair') {
    self.AriaDmPairing.unpair().then(async () => {
      await updateBadge()
      sendResponse({ ok: true })
    })
    return true
  }
  if (message?.type === 'saveConfig') {
    chrome.storage.local.set(message.config).then(async () => {
      await updateBadge()
      sendResponse({ ok: true })
    })
    return true
  }
  return false
})
