/**
 * The toolbar popup.
 *
 * Deliberately has almost no configuration: the extension pairs itself
 * (pairing.js), so this is a status readout, the two things the user came for
 * ("download this video" and "send all links"), and a single settings switch.
 * The port and token fields only exist for the rare case where the discovery
 * port is taken by something else, and they hide behind a disclosure.
 *
 * Every label comes from strings.js, which picks Traditional Chinese or English
 * from the browser's own locale — the strings used to be hardcoded Chinese, so
 * an English user got a Chinese popup.
 */

const t = (key, substitutions) => self.AriaDmStrings.t(key, substitutions)

document.documentElement.lang = /^zh/.test(self.AriaDmStrings.language) ? 'zh-TW' : 'en'

const dot = document.getElementById('dot')
const status = document.getElementById('status')
const currentPage = document.getElementById('currentPage')
const pageState = document.getElementById('pageState')
const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const autoIntercept = document.getElementById('autoIntercept')
const interceptLabel = document.getElementById('interceptLabel')
const formats = document.getElementById('formats')
const formatsTitle = document.getElementById('formatsTitle')
const sendVideoButton = document.getElementById('sendVideo')
const sendLinksButton = document.getElementById('sendLinks')
const sendCookiesButton = document.getElementById('sendCookies')
const advancedSummary = document.getElementById('advancedSummary')
const advancedHint = document.getElementById('advancedHint')

let activeTab = null
let busy = false

const send = (message) => chrome.runtime.sendMessage(message)

/**
 * One line for both "what this page is" and "what just happened".
 *
 * Those used to be two separate lines sitting next to each other, which read as
 * two answers to the same question. `state` colours the line; '' leaves it
 * neutral.
 */
function setPageState(state, text) {
  pageState.className = `page-state ${state}`
  pageState.textContent = text
}

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
 * The page as one line: the host, then as much of the path as fits.
 *
 * Printing the whole URL made a 320px popup spend three lines on a query string.
 * Only the host tells the user where they are.
 */
function describeUrl(raw) {
  if (!raw) return '—'
  try {
    const url = new URL(raw)
    const rest = `${url.pathname}${url.search}`
    const path = rest === '/' ? '' : rest
    return `${url.host}${path.length > 44 ? `${path.slice(0, 44)}…` : path}`
  } catch {
    // chrome:// and about: pages are not URLs, but they still need showing.
    return raw.length > 52 ? `${raw.slice(0, 52)}…` : raw
  }
}

/**
 * How a failure reads in the status line.
 *
 * The extension's transport failures now arrive as whole sentences (「無法連線到
 * AriaDM：…」), so they are shown as they are rather than behind a second label;
 * a bare code or an identifier still gets one, so it is clear what the line is.
 */
function failureText(error) {
  const message = error || t('popup.unknownError')
  return /^[A-Za-z]/.test(message) ? t('popup.failed', { message }) : message
}

/**
 * Read (and if necessary repair) the pairing.
 *
 * `status` re-pairs on its own, so opening the popup is enough to fix the
 * ordinary cases: the app was started after the browser, or it rotated its
 * token.
 */
async function refreshStatus() {
  setStatus('', t('popup.checking'))
  const response = await send({ type: 'status' })
  if (response?.ok) {
    // The discovery port is deliberately not shown: it is an internal detail,
    // and the app's own status bar dropped its port readout for the same reason.
    setStatus('ok', t('popup.connected', { count: response.active ?? 0 }))
    return response
  }

  setStatus('bad', t('popup.disconnected'))
  return response
}

async function loadConfig() {
  const config = (await send({ type: 'config' })) ?? {}
  portInput.value = config.port ?? ''
  tokenInput.value = config.token ?? ''
  autoIntercept.checked = Boolean(config.autoIntercept)
  return config
}

/** Apply the static labels once, from the string table. */
function applyLabels() {
  sendVideoButton.textContent = t('popup.downloadVideo')
  sendLinksButton.textContent = t('popup.sendLinks')
  interceptLabel.textContent = t('popup.intercept')
  // The row is one line now, so the consequence of the switch — it cancels a
  // download the browser already started — is kept as a tooltip rather than lost.
  interceptLabel.title = t('popup.interceptHint')
  formatsTitle.textContent = t('popup.chooseQuality')
  advancedSummary.textContent = t('popup.advanced')
  advancedHint.textContent = t('popup.advancedHint')
  sendCookiesButton.textContent = t('popup.sendCookies')
  document.getElementById('reconnect').textContent = t('popup.reconnect')
  document.getElementById('save').textContent = t('popup.save')
  portInput.placeholder = t('popup.port')
  tokenInput.placeholder = t('popup.token')
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
  currentPage.textContent = describeUrl(tab?.url)
  currentPage.title = tab?.url ?? ''

  if (!downloadableTab()) {
    setPageState('blocked', t('popup.pageBlocked'))
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

  setPageState(
    isMedia && isItem ? 'ready' : '',
    !isMedia ? t('popup.pageUnknown') : isItem ? t('popup.pageItem') : t('popup.pageFeed')
  )
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
  formatsTitle.textContent = response.title || t('popup.chooseQuality')
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
  setPageState('', formatId ? t('popup.adding') : t('popup.gettingFormats'))

  const response = await send({
    type: 'downloadVideo',
    url: activeTab.url,
    referer: activeTab.url,
    formatId
  })

  if (response?.ok && response.mode === 'choose') {
    setPageState('', t('popup.chooseQuality'))
    setBusy(false)
    renderFormats(response)
    return
  }

  setPageState(response?.ok ? 'ready' : 'blocked', response?.ok ? t('popup.added') : failureText(response?.error))
  setBusy(false)
  await refreshStatus()
}

sendVideoButton.addEventListener('click', () => void downloadVideo())

sendLinksButton.addEventListener('click', async () => {
  if (!activeTab?.id) return
  setBusy(true)
  setPageState('', t('popup.collecting'))

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
    setPageState('blocked', t('popup.readLinksFailed', { message: error.message }))
    setBusy(false)
    return
  }

  if (urls.length === 0) {
    setPageState('', t('popup.noLinks'))
    setBusy(false)
    return
  }

  const response = await send({ type: 'handoff', payload: { urls, referer: activeTab.url } })
  setPageState(
    response?.ok ? 'ready' : 'blocked',
    response?.ok ? t('popup.sentCount', { count: response.gids?.length ?? 0 }) : failureText(response?.error)
  )
  setBusy(false)
  await refreshStatus()
})

/**
 * Hand this site's login to AriaDM by hand.
 *
 * Automatic where it can be (the background worker answers AriaDM's requests on
 * its own), but a browser whose cookie store yt-dlp cannot read — Perplexity's
 * Comet, for instance — needs this to be one click away. It sits in the advanced
 * disclosure because the automatic path covers everything else.
 */
sendCookiesButton.addEventListener('click', async () => {
  if (!activeTab?.url) return
  setBusy(true)
  setPageState('', t('popup.sendingLogin'))
  const response = await send({ type: 'offerCookies', url: activeTab.url })
  setPageState(
    response?.ok && response.accepted ? 'ready' : '',
    response?.ok
      ? response.accepted
        ? t('popup.loginSent')
        : t('popup.loginRejected')
      : failureText(response?.error)
  )
  setBusy(false)
})

autoIntercept.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoIntercept: autoIntercept.checked })
})

document.getElementById('reconnect').addEventListener('click', async () => {
  setPageState('', t('popup.searching'))
  await send({ type: 'unpair' })
  const paired = await send({ type: 'pair' })
  setPageState(
    paired?.ok ? 'ready' : 'blocked',
    paired?.ok ? t('popup.foundPort', { port: paired.port }) : t('popup.notFound')
  )
  await loadConfig()
  await refreshStatus()
})

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value)
  const token = tokenInput.value.trim()
  if (!port || !token) {
    setPageState('blocked', t('popup.needBoth'))
    return
  }
  await chrome.storage.local.set({ port, token, manual: true, pairError: '' })
  setPageState('ready', t('popup.saved'))
  await refreshStatus()
})

async function start() {
  applyLabels()
  hideFormats()
  await loadConfig()
  await activeTabUrl()
  const response = await refreshStatus()

  // Opening the popup is also the fastest way to answer a download that is stuck
  // waiting for a login, so ask and serve before the user has to.
  if (response?.ok) {
    const served = await send({ type: 'serveCookieRequest' })
    if (served?.sent) {
      setPageState(
        'ready',
        t('popup.cookieServed', {
          host: served.url ? new URL(served.url).host : t('popup.thisSite')
        })
      )
    }
  }

  if (response?.ok === false) {
    setPageState('blocked', response.pairError || t('popup.notConnectedHint'))
  }
}

void start()
