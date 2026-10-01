/**
 * The toolbar popup.
 *
 * Deliberately has almost no configuration: the extension pairs itself
 * (pairing.js), so this is a status readout, the two things the user came for
 * ("download this video" and "hand over my login"), and a single settings switch.
 * The port and token fields only exist for the rare case where the discovery
 * port is taken by something else, and they hide behind a disclosure.
 */

const dot = document.getElementById('dot')
const status = document.getElementById('status')
const currentUrl = document.getElementById('currentUrl')
const pageState = document.getElementById('pageState')
const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const autoIntercept = document.getElementById('autoIntercept')
const result = document.getElementById('result')
const formats = document.getElementById('formats')
const formatsTitle = document.getElementById('formatsTitle')
const sendVideoButton = document.getElementById('sendVideo')
const sendLinksButton = document.getElementById('sendLinks')
const sendCookiesButton = document.getElementById('sendCookies')

let activeTab = null
let busy = false

const send = (message) => chrome.runtime.sendMessage(message)

function setStatus(state, text) {
  dot.className = `dot ${state}`
  status.textContent = text
}

function setBusy(next) {
  busy = next
  sendVideoButton.disabled = next || !downloadableTab()
  sendLinksButton.disabled = next || !downloadableTab()
  sendCookiesButton.disabled = next || !downloadableTab()
  if (next) hideFormats()
}

function downloadableTab() {
  return Boolean(activeTab?.url) && /^https?:/i.test(activeTab.url ?? '')
}

/**
 * How a failure reads in the result line.
 *
 * The extension's transport failures now arrive as whole sentences ("無法連線到
 * AriaDM：…"), so they are shown as they are rather than behind a second label;
 * a bare code or an identifier still gets one, so it is clear what the line is.
 */
function failureText(error) {
  const message = error || '未知錯誤'
  return /^[A-Za-z]/.test(message) ? `失敗：${message}` : message
}

/**
 * Read (and if necessary repair) the pairing.
 *
 * `status` re-pairs on its own, so opening the popup is enough to fix the
 * ordinary cases: the app was started after the browser, or it rotated its
 * token.
 */
async function refreshStatus() {
  setStatus('', '檢查中…')
  const response = await send({ type: 'status' })
  if (response?.ok) {
    const via = response.discoveryPort ? ` · 自動配對 :${response.discoveryPort}` : ''
    setStatus('ok', `已連線 · ${response.active ?? 0} 進行中${via}`)
    return response
  }

  setStatus('bad', '未連線')
  return response
}

async function loadConfig() {
  const config = (await send({ type: 'config' })) ?? {}
  portInput.value = config.port ?? ''
  tokenInput.value = config.token ?? ''
  autoIntercept.checked = Boolean(config.autoIntercept)
  return config
}

/**
 * Show the current page and say what can be done with it.
 *
 * The state line exists because the two buttons look equally applicable on every
 * page, and only one of them usually is.
 */
async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTab = tab ?? null
  currentUrl.textContent = tab?.url ?? '—'

  if (!downloadableTab()) {
    pageState.textContent = '這個頁面無法下載（僅支援 http/https）。'
    pageState.className = 'page-state blocked'
    setBusy(false)
    return
  }

  const { sites } = (await send({ type: 'mediaSites' })) ?? {}
  const host = (() => {
    try {
      return new URL(activeTab.url).hostname.toLowerCase()
    } catch {
      return ''
    }
  })()
  const isMedia = (sites ?? []).some((site) => host === site || host.endsWith(`.${site}`))
  const isItem = self.AriaDmUrls.looksLikeItemPage(activeTab.url)

  pageState.textContent = !isMedia
    ? '沒偵測到影音網站；仍可嘗試下載，或傳送頁面連結。'
    : isItem
      ? '偵測到影音網站，可直接下載這部影片。'
      : '這是列表頁，沒有可直接下載的影片；請先開啟那則貼文或影片頁面。'
  pageState.className = `page-state ${isMedia && isItem ? 'ready' : ''}`
  setBusy(false)
}

function hideFormats() {
  formats.hidden = true
  formats.textContent = ''
  formats.appendChild(formatsTitle)
}

/**
 * Offer the qualities the app says this page has.
 *
 * The list is the app's, not ours: only it knows whether ffmpeg is installed and
 * what this session can fetch, and only it can spend a yt-dlp run working it out.
 */
function renderFormats(response) {
  formats.textContent = ''
  formatsTitle.textContent = response.title || '選擇畫質'
  formats.appendChild(formatsTitle)

  for (const option of self.AriaDmFormats.menuFor(response)) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'format'

    const name = document.createElement('span')
    name.className = 'format-name'
    name.textContent = option.label
    item.appendChild(name)

    if (option.note) {
      const note = document.createElement('span')
      note.className = 'format-note'
      note.textContent = option.note
      item.appendChild(note)
    }

    item.addEventListener('click', () => void downloadVideo(option.formatId))
    formats.appendChild(item)
  }

  formats.hidden = false
}

/**
 * Hand the current page to the media engine, at a chosen quality.
 *
 * With no `formatId` the background worker asks the app what the page offers and
 * answers either "sent" or with a menu — "media: true" on the payload is what
 * tells the app to resolve the URL as a video rather than download the page
 * itself, which is why "grab this video" used to save an HTML file.
 */
async function downloadVideo(formatId = '') {
  if (!activeTab?.url) return
  setBusy(true)
  result.textContent = formatId ? '正在加入下載…' : '正在取得影片…'

  const response = await send({
    type: 'downloadVideo',
    url: activeTab.url,
    referer: activeTab.url,
    formatId
  })

  if (response?.ok && response.mode === 'choose') {
    result.textContent = '選擇要下載的畫質：'
    setBusy(false)
    renderFormats(response)
    return
  }

  result.textContent = response?.ok ? '已加入影片下載' : failureText(response?.error)
  setBusy(false)
  await refreshStatus()
}

sendVideoButton.addEventListener('click', () => void downloadVideo())

sendLinksButton.addEventListener('click', async () => {
  if (!activeTab?.id) return
  setBusy(true)
  result.textContent = '收集連結中…'

  let urls = []
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () =>
        Array.from(document.querySelectorAll('a[href]'))
          .map((anchor) => anchor.href)
          .filter((href) => /^(https?|ftp):\/\//i.test(href))
    })
    urls = [...new Set(injection?.result ?? [])]
  } catch (error) {
    result.textContent = `無法讀取頁面連結：${error.message}`
    setBusy(false)
    return
  }

  if (urls.length === 0) {
    result.textContent = '此頁面沒有可下載的連結'
    setBusy(false)
    return
  }

  const response = await send({ type: 'handoff', payload: { urls, referer: activeTab.url } })
  result.textContent = response?.ok ? `已送出 ${response.gids?.length ?? 0} 個項目` : failureText(response?.error)
  setBusy(false)
  await refreshStatus()
})

/**
 * Hand this site's login to AriaDM by hand.
 *
 * Automatic where it can be (the background worker answers AriaDM's requests on
 * its own), but a browser whose cookie store yt-dlp cannot read — Perplexity's
 * Comet, for instance — needs this to be one click away from the page itself.
 */
sendCookiesButton.addEventListener('click', async () => {
  if (!activeTab?.url) return
  setBusy(true)
  result.textContent = '正在傳送登入狀態…'
  const response = await send({ type: 'offerCookies', url: activeTab.url })
  result.textContent = response?.ok
    ? response.accepted
      ? '已把登入狀態傳給 AriaDM'
      : 'AriaDM 目前不接受登入狀態（請在設定中開啟）'
    : failureText(response?.error)
  setBusy(false)
})

autoIntercept.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoIntercept: autoIntercept.checked })
})

document.getElementById('reconnect').addEventListener('click', async () => {
  result.textContent = '正在尋找 AriaDM…'
  await send({ type: 'unpair' })
  const paired = await send({ type: 'pair' })
  result.textContent = paired?.ok
    ? `已連線到連接埠 ${paired.port}（自動配對 :${paired.discoveryPort ?? '?'}）`
    : `找不到 AriaDM。已嘗試自動配對連接埠 ${(paired?.ports ?? []).join('、') || '—'}；請先啟動桌面應用程式，並確認「設定 → 整合與工具」中的瀏覽器整合已開啟。`
  await loadConfig()
  await refreshStatus()
})

document.getElementById('openApp').addEventListener('click', async () => {
  // Nothing to configure in the app for the extension to work; the settings
  // window is opened only so the user can see the pairing state.
  await send({ type: 'ping' })
  result.textContent = 'AriaDM：設定 → 整合與工具'
})

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value)
  const token = tokenInput.value.trim()
  if (!port || !token) {
    result.textContent = '請同時填寫連接埠與權杖'
    return
  }
  await chrome.storage.local.set({ port, token, manual: true, pairError: '' })
  result.textContent = '已儲存手動設定'
  await refreshStatus()
})

async function start() {
  hideFormats()
  await loadConfig()
  await activeTabUrl()
  const response = await refreshStatus()

  // Opening the popup is also the fastest way to answer a download that is stuck
  // waiting for a login, so ask and serve before the user has to.
  if (response?.ok) {
    const served = await send({ type: 'serveCookieRequest' })
    if (served?.sent) {
      result.textContent = `已把 ${served.url ? new URL(served.url).host : '這個網站'} 的登入狀態傳給 AriaDM。`
    }
  }

  if (response?.ok === false) {
    result.textContent = response.pairError
      ? `未連線：${response.pairError}`
      : '未連線：請啟動 AriaDM 桌面應用程式，連線後會自動完成設定。'
  }
}

void start()
