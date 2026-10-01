/**
 * The toolbar popup.
 *
 * Deliberately has almost no configuration: the extension pairs itself
 * (pairing.js), so this is a status readout plus two manual actions. The port
 * and token fields only exist for the rare case where the discovery port is
 * taken by something else.
 */

const dot = document.getElementById('dot')
const status = document.getElementById('status')
const currentUrl = document.getElementById('currentUrl')
const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const autoIntercept = document.getElementById('autoIntercept')
const result = document.getElementById('result')
const sendVideoButton = document.getElementById('sendVideo')
const sendLinksButton = document.getElementById('sendLinks')

let activeTab = null
let busy = false

const send = (message) => chrome.runtime.sendMessage(message)

function setStatus(state, text) {
  dot.className = `dot ${state}`
  status.textContent = text
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
    if (!result.textContent) result.textContent = '已自動設定完成，不需要填寫任何連線資訊。'
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

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTab = tab ?? null
  currentUrl.textContent = tab?.url ?? '—'
  const downloadable = Boolean(tab?.url) && /^https?:/i.test(tab.url)
  sendVideoButton.disabled = !downloadable || busy
  sendLinksButton.disabled = !downloadable || busy
}

/**
 * Hand the current page to the media engine.
 *
 * `media: true` is the whole point: without it the app treats the URL as an
 * ordinary file and downloads the page itself, which is why "grab this video"
 * kept saving an HTML file. The flag means "resolve this as a video with
 * yt-dlp", and it works on any site yt-dlp supports, not just the ones the
 * on-page panel recognises.
 */
sendVideoButton.addEventListener('click', async () => {
  if (!activeTab?.url) return
  busy = true
  await activeTabUrl()
  result.textContent = '正在取得影片…'
  const response = await send({
    type: 'handoff',
    payload: { urls: [activeTab.url], referer: activeTab.url, media: true }
  })
  result.textContent = response?.ok ? '已加入影片下載' : `失敗：${response?.error ?? '未知錯誤'}`
  busy = false
  await activeTabUrl()
  await refreshStatus()
})

sendLinksButton.addEventListener('click', async () => {
  if (!activeTab?.id) return
  busy = true
  await activeTabUrl()
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
    busy = false
    await activeTabUrl()
    return
  }

  if (urls.length === 0) {
    result.textContent = '此頁面沒有可下載的連結'
    busy = false
    await activeTabUrl()
    return
  }

  const response = await send({ type: 'handoff', payload: { urls, referer: activeTab.url } })
  result.textContent = response?.ok ? `已送出 ${response.gids?.length ?? 0} 個項目` : `失敗：${response?.error ?? '未知錯誤'}`
  busy = false
  await activeTabUrl()
  await refreshStatus()
})

autoIntercept.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoIntercept: autoIntercept.checked })
})

document.getElementById('pair').addEventListener('click', async () => {
  result.textContent = '正在尋找 AriaDM…'
  const response = await send({ type: 'unpair' })
  void response
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
  await loadConfig()
  await activeTabUrl()
  const response = await refreshStatus()
  if (response?.ok === false) {
    result.textContent = response.pairError
      ? `未連線：${response.pairError}`
      : '未連線：請啟動 AriaDM 桌面應用程式，連線後會自動完成設定。'
  }
}

void start()
