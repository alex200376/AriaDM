/**
 * The download panel that appears over the player, in the spirit of IDM's
 * "download this video" bar.
 *
 * Only runs on media hosts (the manifest's match patterns come from
 * media-sites.json), and it hands the app a *page* URL rather than the element's
 * `src`. That distinction is the whole reason this works on X: the src of a video
 * element there is a short-lived `.m3u8` fragment that only the page's own
 * session can fetch, whereas yt-dlp given the tweet URL resolves the real formats
 * itself. The URL has to be the *video's* page though, not the timeline's — see
 * `currentVideoUrl`.
 *
 * Behaviour that matters:
 *  - it is *hover* driven, so it is out of the way until the pointer is over the
 *    player, and it stays put while the pointer is on the panel itself;
 *  - clicking it asks the app what the page offers and opens a quality menu when
 *    there is a choice to make, rather than always taking the app's default;
 *  - it survives single-page navigation, where the player element is replaced;
 *  - it runs in every frame, because a great many sites embed their player in
 *    an iframe.
 */
;(function () {
  const PANEL_ID = 'ariadm-download-panel'
  const LABEL = '下載此影片'

  /** Below this the element is an avatar loop or an ad, not the content. */
  const MIN_VIDEO_AREA = 200 * 112
  /** Recomputing on every pointer event would be wasteful; one frame is plenty. */
  const FRAME_MS = 16
  /** Keep the panel up briefly after the pointer leaves, so it can be reached. */
  const HIDE_DELAY_MS = 450

  const ICONS = {
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
    busy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>'
  }

  const TEXT = {
    idle: LABEL,
    busy: '正在取得畫質…',
    done: '已加入 AriaDM',
    error: '無法加入，請見通知',
    choose: '選擇畫質'
  }

  let panel = null
  let mainButton = null
  let label = null
  let glyph = null
  let menu = null
  let state = 'idle'
  let resetTimer = 0
  let hideTimer = 0
  let frame = 0
  let visible = false
  /** The element the panel is currently anchored to. */
  let anchor = null

  /** Host list, supplied by the background worker so it lives in one place. */
  let allowedHosts = null

  function isAllowedHost(hostname) {
    if (!allowedHosts) return false
    const host = hostname.toLowerCase()
    return allowedHosts.some((site) => host === site || host.endsWith(`.${site}`))
  }

  /**
   * The main player on this page: the largest video that is actually on screen.
   *
   * Sized rather than queried by selector because the markup differs on every
   * site, and "the big one" is the only definition that holds across all of them.
   */
  function findMainVideo() {
    let best = null
    let bestArea = 0

    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area < MIN_VIDEO_AREA) continue
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue
      if (rect.right < 0 || rect.left > window.innerWidth) continue
      if (area > bestArea) {
        best = video
        bestArea = area
      }
    }
    return best
  }

  /**
   * The address of the video the panel is over.
   *
   * The rule itself lives in `urls.js`, where it can be tested: it decides which
   * video gets downloaded, and on a timeline the page URL it used to send is a
   * timeline (see `itemUrlNear`).
   */
  function currentVideoUrl() {
    const video = anchor && anchor.isConnected ? anchor : findMainVideo()
    return self.AriaDmUrls.itemUrlNear(video, location)
  }

  function ensurePanel() {
    if (panel && panel.isConnected) return panel

    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.dataset.state = 'idle'
    panel.dataset.visible = 'false'

    mainButton = document.createElement('button')
    mainButton.type = 'button'
    mainButton.className = 'ariadm-main'
    mainButton.setAttribute('aria-label', `${LABEL} — 送到 AriaDM`)

    glyph = document.createElement('span')
    glyph.className = 'ariadm-glyph'
    glyph.innerHTML = ICONS.download

    label = document.createElement('span')
    label.className = 'ariadm-label'
    label.textContent = LABEL

    mainButton.append(glyph, label)

    menu = document.createElement('div')
    menu.className = 'ariadm-menu'
    menu.hidden = true

    panel.append(mainButton, menu)
    mainButton.addEventListener('click', onMainClick, true)
    document.documentElement.appendChild(panel)
    return panel
  }

  function setState(next) {
    state = next
    if (!panel) return
    panel.dataset.state = next
    glyph.innerHTML = next === 'idle' || next === 'choose' ? ICONS.download : ICONS[next]
    label.textContent = TEXT[next] ?? LABEL
    if (next !== 'choose') closeMenu()
    window.clearTimeout(resetTimer)
    if (next === 'done' || next === 'error') {
      resetTimer = window.setTimeout(() => setState('idle'), 2600)
    }
  }

  function closeMenu() {
    if (menu) menu.hidden = true
    window.clearTimeout(resetTimer)
  }

  /**
   * Build the quality menu from the app's answer.
   *
   * The first entry is the download the button would have made on its own, so
   * opening the menu never costs the user the one-click path they had before.
   */
  function openMenu(result) {
    const element = ensurePanel()
    menu.textContent = ''

    const caption = document.createElement('div')
    caption.className = 'ariadm-menu-title'
    caption.textContent = result.title || '選擇畫質'
    menu.appendChild(caption)

    for (const option of self.AriaDmFormats.menuFor(result)) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'ariadm-option'
      item.dataset.formatId = option.formatId

      const name = document.createElement('span')
      name.className = 'ariadm-option-label'
      name.textContent = option.label
      item.appendChild(name)

      if (option.note) {
        const note = document.createElement('span')
        note.className = 'ariadm-option-note'
        note.textContent = option.note
        item.appendChild(note)
      }

      item.addEventListener('click', onOptionClick, true)
      menu.appendChild(item)
    }

    menu.hidden = false
    setState('choose')
    show(true)
    element.dataset.open = 'true'
  }

  /** Sends the handoff for one chosen quality (or for the app's default). */
  async function send(formatId) {
    setState('busy')
    show(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'downloadVideo',
        url: currentVideoUrl(),
        // The page is the right referer even when it is not the right address:
        // it is what the site's own player would send.
        referer: location.href,
        formatId: formatId || ''
      })
      setState(response && response.ok ? 'done' : 'error')
      panel.title = response && !response.ok && response.error ? `AriaDM：${response.error}` : ''
    } catch {
      setState('error')
    }
  }

  async function onMainClick(event) {
    event.preventDefault()
    event.stopPropagation()
    if (state === 'busy') return
    if (state === 'choose') {
      // Second click on the pill closes the menu again.
      closeMenu()
      setState('idle')
      return
    }

    setState('busy')
    show(true)
    panel.title = ''

    let response = null
    try {
      response = await chrome.runtime.sendMessage({
        type: 'downloadVideo',
        url: currentVideoUrl(),
        referer: location.href
      })
    } catch {
      response = null
    }

    if (response?.ok && response.mode === 'choose') {
      openMenu(response)
      return
    }
    setState(response && response.ok ? 'done' : 'error')
    if (response && !response.ok && response.error) panel.title = `AriaDM：${response.error}`
  }

  function onOptionClick(event) {
    event.preventDefault()
    event.stopPropagation()
    const formatId = event.currentTarget?.dataset?.formatId ?? ''
    closeMenu()
    void send(formatId)
  }

  /** A click anywhere else puts the menu away, like any other menu. */
  function onDocumentPointerDown(event) {
    if (!menu || menu.hidden) return
    if (inside(panel, event)) return
    closeMenu()
    setState('idle')
  }

  function show(force) {
    const element = ensurePanel()
    if (force || !visible) {
      visible = true
      element.dataset.visible = 'true'
    }
    window.clearTimeout(hideTimer)
  }

  function hideSoon() {
    // A finished handoff or an open menu keeps its message on screen.
    if (state !== 'idle') return
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      visible = false
      if (panel) panel.dataset.visible = 'false'
    }, HIDE_DELAY_MS)
  }

  function place() {
    const video = findMainVideo()
    anchor = video

    const element = ensurePanel()
    if (!video) {
      element.dataset.visible = 'false'
      visible = false
      return
    }

    const rect = video.getBoundingClientRect()
    // Compact variant when the player is too small for a label: the panel would
    // otherwise cover most of it.
    element.dataset.compact = rect.width < 420 ? 'true' : 'false'

    const width = element.offsetWidth || 132
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, rect.right - width - 10))
    element.style.top = `${Math.max(4, rect.top + 10)}px`
    element.style.left = `${left}px`

    if (visible) element.dataset.visible = 'true'
  }

  function schedule() {
    if (frame) return
    frame = window.setTimeout(() => {
      frame = 0
      place()
    }, FRAME_MS)
  }

  function inside(element, event) {
    if (!element || !element.isConnected) return false
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    )
  }

  /**
   * Hover tracking at the document level.
   *
   * Deliberately not `mouseenter` on the video: the player is replaced on every
   * single-page navigation, and most sites put their own overlay controls on top
   * of it, which swallow the event. Hit-testing the pointer against the current
   * player's box is immune to both.
   */
  function onPointerMove(event) {
    if (!anchor || !anchor.isConnected) anchor = findMainVideo()
    if (!anchor) {
      hideSoon()
      return
    }
    if (inside(anchor, event) || inside(panel, event)) show(false)
    else hideSoon()
  }

  /**
   * Watch for the player being replaced.
   *
   * Single-page sites tear the video out and build a new one on every
   * navigation, and the new element needs the panel anchored to it.
   */
  function observe() {
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  async function start() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'mediaSites' })
      allowedHosts = Array.isArray(response && response.sites) ? response.sites : []
    } catch {
      allowedHosts = []
    }

    if (!isAllowedHost(location.hostname)) return

    place()
    observe()
    document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
    document.addEventListener('pointerdown', onDocumentPointerDown, { passive: true, capture: true })
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule, { passive: true })
    // Sites that resize the player without touching the DOM (theatre mode,
    // picture-in-picture) are only caught by polling.
    window.setInterval(schedule, 1000)
  }

  void start()
})()
