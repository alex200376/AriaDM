/**
 * AriaDM browser handoff.
 *
 * Talks to the desktop app's loopback handoff API, which authenticates every
 * request with a shared token. Pairing is automatic (see pairing.js) so the user
 * never types a port or a token; the token still never leaves local storage, and
 * the API only accepts requests whose Origin is an extension, so a web page
 * cannot drive a download on the user's behalf.
 */

// Chrome runs this as a service worker; Firefox lists pairing.js first in the
// manifest's background.scripts instead.
if (typeof importScripts === 'function') importScripts('pairing.js')

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

function endpoint(config, path) {
  return `http://127.0.0.1:${config.port}${path}`
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
    const response = await fetch(endpoint(config, '/ping'), {
      headers: { 'x-ariadm-token': config.token }
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, ...(await response.json()) }
  } catch (error) {
    return { ok: false, error: error.message }
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

function notify(title, message) {
  if (!chrome.notifications) return
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message
  })
}

async function post(payload) {
  const config = await getConfig()
  const response = await fetch(endpoint(config, '/add'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ariadm-token': config.token },
    body: JSON.stringify(payload)
  })
  const body = await response.json().catch(() => ({}))
  return { response, body }
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
    let { response, body } = await post(payload)

    // A 401 means the app rotated its token, which is exactly what auto-pairing
    // exists to absorb.
    if (response.status === 401) {
      await self.AriaDmPairing.pair()
      ;({ response, body } = await post(payload))
    }

    if (!response.ok || body.ok === false) {
      const message = body.error || `HTTP ${response.status}`
      notify('AriaDM 無法接收', message)
      return { ok: false, error: message }
    }

    const count = Array.isArray(body.gids) ? body.gids.length : 0
    if (count > 0) {
      notify('已送到 AriaDM', `已加入 ${count} 個下載項目。`)
    } else if (body.duplicates && body.duplicates.length > 0) {
      notify('已在下載中', '此連結已在 AriaDM 的佇列中。')
    }
    for (const warning of body.warnings ?? []) notify('AriaDM 提示', warning)
    void updateBadge()
    return { ok: true, ...body }
  } catch (error) {
    notify('AriaDM 沒有回應', `${error.message}（請確認應用程式正在執行）`)
    return { ok: false, error: error.message }
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
  if (alarm.name === PAIR_ALARM) void ensurePaired()
})

chrome.runtime.onInstalled.addListener(() => {
  createMenus()
  chrome.storage.local.get(Object.keys(DEFAULTS)).then((stored) => {
    const missing = {}
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (stored[key] === undefined) missing[key] = value
    }
    if (Object.keys(missing).length > 0) chrome.storage.local.set(missing)
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
chrome.downloads.onCreated.addListener(async (item) => {
  if (!item.url || item.url.startsWith('blob:') || item.url.startsWith('data:')) return
  const config = await getConfig()
  if (!config.autoIntercept) return

  try {
    await chrome.downloads.cancel(item.id)
    await chrome.downloads.erase({ id: item.id })
  } catch {
    // Already gone; the handoff below is still worth attempting.
  }

  const payload = await payloadFor(item.url, undefined, false)
  if (item.filename) payload.filename = item.filename.split(/[/\\]/).pop()
  await handoff(payload)
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
