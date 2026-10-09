/**
 * The download panel that appears over the player, in the spirit of IDM's
 * "download this video" bar.
 *
 * Arms on the hosts in media-sites.json, and on any other host the app confirms
 * holds media (it reads the page rather than spending a yt-dlp run — see
 * `watchUnknownHost`). It hands the app a *page* URL rather than the element's
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
 *    an iframe;
 *  - it recognises `<audio>` as well as `<video>`, so a page that only plays
 *    music gets an audio download rather than the worst available video;
 *  - when the app has confirmed a page holds media but nothing measurable is on
 *    it — a canvas player, a script-built widget — the panel appears anyway,
 *    pinned to a corner, instead of the page looking undownloadable.
 */
;(function () {
  const PANEL_ID = 'ariadm-download-panel'

  /** Translate through the shared table (see strings.js). */
  const s = (key, substitutions) => self.AriaDmStrings.t(key, substitutions)

  /** Below this the element is an avatar loop or an ad, not the content. */
  const MIN_VIDEO_AREA = 200 * 112
  /**
   * Audio players are a strip rather than a stage: a music page's element is
   * often little more than a play button and a scrubber, so the video threshold
   * would reject every legitimate one.
   */
  const MIN_AUDIO_AREA = 120 * 32
  /** Recomputing on every pointer event would be wasteful; one frame is plenty. */
  const FRAME_MS = 16
  /** Keep the panel up briefly after the pointer leaves, so it can be reached. */
  const HIDE_DELAY_MS = 450
  /** How long a plain result (加入成功 / 失敗) holds the label. */
  const RESULT_MS = 2600
  /** Advice is longer than a result, because it has to be read and acted on. */
  const ADVICE_MS = 4000
  /** Distance the pinned panel keeps from the viewport's corner. */
  const PINNED_INSET = 16
  /**
   * At most this often does a DOM change trigger a fresh sweep for players.
   *
   * The sweep walks shadow roots, which cannot be reached with one selector, so
   * it is a tree walk rather than a query — and a busy single-page site mutates
   * its DOM constantly. Reactions are coalesced into one traversal every quarter
   * second, which is far below the rate a person can notice and far above the
   * rate the pointer produces.
   */
  const REFRESH_THROTTLE_MS = 250

  const ICONS = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 10v7"/><path d="M12 7h.01"/></svg>',
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>',
    audio:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
    busy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>'
  }

  /** The transient labels; the resting one depends on what is anchored. */
  const TEXT = {
    busy: () => s('panel.busy'),
    done: () => s('panel.done'),
    error: () => s('panel.error'),
    choose: () => s('panel.choose'),
    /** A feed page, so there is no post to name: the user has to open one. */
    noItem: () => s('panel.noItem')
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
  let refreshTimer = 0
  let visible = false
  /** The element the panel is currently anchored to. */
  let anchor = null
  /** 'video' or 'audio' for the current anchor; decides the label and the intent. */
  let anchorKind = null
  /**
   * True once the app has answered that this page holds media.
   *
   * Only the app's own answer sets this. A curated host relies on its player
   * element being found, which is how it has always worked — pinning a
   * permanent button to the corner of a site's feed page would be intrusive.
   */
  let pageMedia = false
  /** Media elements found by the last sweep, including ones inside shadow roots. */
  let candidates = []

  /** Host list, supplied by the background worker so it lives in one place. */
  let allowedHosts = null

  function isAllowedHost(hostname) {
    if (!allowedHosts) return false
    const host = hostname.toLowerCase()
    return allowedHosts.some((site) => host === site || host.endsWith(`.${site}`))
  }

  /**
   * Every media element in a tree, shadow roots included.
   *
   * `querySelectorAll` does not pierce a shadow root, and a growing number of
   * players render their `<video>` inside one. To a plain selector such a page
   * simply has no player, which is the difference between the panel appearing and
   * the page looking undownloadable.
   */
  function collectMedia(root, found) {
    for (const element of root.querySelectorAll('video, audio')) found.push(element)
    for (const element of root.querySelectorAll('*')) {
      const shadow = element.shadowRoot
      if (shadow) collectMedia(shadow, found)
    }
  }

  /** Rebuild the candidate list. Deliberately not called per frame. */
  function refreshCandidates() {
    const found = []
    collectMedia(document, found)
    candidates = found
  }

  /**
   * Sweep again, coalesced.
   *
   * The observer fires on every DOM change, and this list only needs to be right
   * by the time the pointer moves over the player — not instantly.
   */
  function refreshSoon() {
    if (refreshTimer) return
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0
      refreshCandidates()
      schedule()
    }, REFRESH_THROTTLE_MS)
  }

  /** The rest of the label for a state, in the current language. */
  function idleLabel() {
    return s(anchorKind === 'audio' ? 'panel.audio' : 'panel.video')
  }

  function idleIcon() {
    return anchorKind === 'audio' ? ICONS.audio : ICONS.download
  }

  /**
   * The main player on this page: the largest media element that is actually on
   * screen. Sized rather than queried by selector because the markup differs on
   * every site, and "the big one" is the only definition that holds across all of
   * them.
   */
  function findMediaElement() {
    let best = null
    let bestArea = 0
    let bestKind = null

    for (const element of candidates) {
      if (!element.isConnected) continue
      const kind = element.tagName === 'AUDIO' ? 'audio' : 'video'
      const rect = element.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area < (kind === 'audio' ? MIN_AUDIO_AREA : MIN_VIDEO_AREA)) continue
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue
      if (rect.right < 0 || rect.left > window.innerWidth) continue
      if (area > bestArea) {
        best = element
        bestArea = area
        bestKind = kind
      }
    }
    return { element: best, kind: bestKind }
  }

  /**
   * Whether the page advertises media of its own accord.
   *
   * A hand-rolled player — a canvas, a script-built widget, a `<video>` inside a
   * closed shadow root — leaves nothing measurable behind, but the page almost
   * always says what it plays in its own metadata, because that is what social
   * previews and embedders read. Checking for it here is local and synchronous,
   * which matters: the alternative (ask the app about every page) costs the app a
   * full page fetch on every site the user visits.
   */
  function pageDeclaresMedia() {
    return (
      document.querySelector(
        'meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"], meta[name="twitter:player"], meta[name="twitter:player:stream"]'
      ) !== null
    )
  }

  /**
   * Whether the video the panel belongs to is in picture-in-picture.
   *
   * Once a video is in PiP it is a floating system window with its own controls,
   * and the panel — positioned over the element's box — landed on top of that
   * window's close button. There is nothing to annotate in that state either, so
   * the panel keeps away until the video comes back to the page.
   */
  function inPictureInPicture() {
    const pip = document.pictureInPictureElement
    if (!pip) return false
    // The anchor is what the panel follows, so it decides on its own; the scan is
    // only a fallback for a pointer event that lands before the first `place`.
    if (anchor && anchor.isConnected) return pip === anchor
    return pip === findMediaElement().element
  }

  /**
   * The address of the video the panel is over, or '' when there is none.
   *
   * The rule itself lives in `urls.js`, where it can be tested: it decides which
   * video gets downloaded, and on a timeline the page URL it used to send is a
   * timeline (see `itemUrlNear`).
   *
   * An empty answer is not an address. On a site whose video addresses we know,
   * it means this page is a feed — `instagram.com/`, the reels tab, X's timeline —
   * and a feed cannot be downloaded. Handing the app that empty string produced
   * "這個網址沒有 AriaDM 能下載的影片" for a click that was never going to work, so
   * the panel now says what to do instead of asking.
   */
  function currentVideoUrl() {
    const element = anchor && anchor.isConnected ? anchor : findMediaElement().element
    /*
     * With no element to read, the page itself is the answer.
     *
     * The feed guard above exists because a timeline URL downloads the wrong
     * thing; that judgement has already been made here, by the app, before
     * `pageMedia` was set. A player we cannot measure is the only way to reach
     * this branch, and refusing to send anything would leave exactly the pages
     * the panel was widened for with no way to download them.
     */
    if (!element) return pageMedia ? location.href : ''
    return self.AriaDmUrls.itemUrlNear(element, location)
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

    glyph = document.createElement('span')
    glyph.className = 'ariadm-glyph'

    label = document.createElement('span')
    label.className = 'ariadm-label'

    mainButton.append(glyph, label)

    menu = document.createElement('div')
    menu.className = 'ariadm-menu'
    menu.hidden = true

    panel.append(mainButton, menu)
    mainButton.addEventListener('click', onMainClick, true)
    document.documentElement.appendChild(panel)

    // Paint it once so the resting label is right before anything is hovered.
    setState('idle')
    return panel
  }

  function setState(next) {
    state = next
    if (!panel) return
    panel.dataset.state = next
    glyph.innerHTML = next === 'idle' ? idleIcon() : (ICONS[next] ?? idleIcon())
    label.textContent = next === 'idle' ? idleLabel() : (TEXT[next] ?? idleLabel())()
    mainButton.setAttribute('aria-label', s('panel.send', { label: label.textContent }))
    if (next !== 'choose') closeMenu()
    window.clearTimeout(resetTimer)
    if (next === 'done' || next === 'error' || next === 'noItem') {
      resetTimer = window.setTimeout(() => setState('idle'), next === 'noItem' ? ADVICE_MS : RESULT_MS)
    }
  }

  /**
   * Tells the user to open the post, and answers whether anything was sent.
   *
   * The app is not asked at all here. It has no way to know that the page is a
   * feed rather than a broken video, and its answer was the same unhelpful
   * sentence every time.
   */
  function cannotTellWhichVideo() {
    setState('noItem')
    show(true)
    panel.title = s('panel.title')
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
    caption.textContent = result.title || s('panel.choose')
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
    const url = currentVideoUrl()
    if (!url) return cannotTellWhichVideo()

    setState('busy')
    show(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'downloadVideo',
        url,
        // The page is the right referer even when it is not the right address:
        // it is what the site's own player would send.
        referer: location.href,
        formatId: formatId || '',
        // Only the page knows the panel was sitting on an <audio> element, and a
        // music page has no other way to be recognised as one.
        audioOnly: anchorKind === 'audio'
      })
      setState(response && response.ok ? 'done' : 'error')
      panel.title = response && !response.ok && response.error ? `${s('panel.prefix')}${response.error}` : ''
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

    // Asked before the panel goes busy, so a feed never even reaches the app.
    const url = currentVideoUrl()
    if (!url) return cannotTellWhichVideo()

    setState('busy')
    show(true)
    panel.title = ''

    let response = null
    try {
      response = await chrome.runtime.sendMessage({
        type: 'downloadVideo',
        url,
        referer: location.href,
        audioOnly: anchorKind === 'audio'
      })
    } catch {
      response = null
    }

    if (response?.ok && response.mode === 'choose') {
      openMenu(response)
      return
    }
    setState(response && response.ok ? 'done' : 'error')
    if (response && !response.ok && response.error) panel.title = `${s('panel.prefix')}${response.error}`
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
    const found = findMediaElement()
    anchor = found.element
    anchorKind = found.kind

    const element = ensurePanel()
    if (inPictureInPicture()) {
      element.dataset.visible = 'false'
      visible = false
      return
    }

    /*
     * No player to sit on.
     *
     * The app has confirmed this page holds media but nothing measurable is on
     * it, so the panel is pinned to a corner of the viewport instead of hiding:
     * a custom player with no media element is exactly the case this exists for,
     * and the only way to download such a page is the button.
     */
    if (!anchor) {
      if (!pageMedia) {
        element.dataset.visible = 'false'
        visible = false
        return
      }
      element.dataset.compact = 'false'
      element.style.left = 'auto'
      element.style.right = `${PINNED_INSET}px`
      element.style.top = `${PINNED_INSET}px`
      visible = true
      element.dataset.visible = 'true'
      return
    }

    // Anchored again after being pinned: give the inline `right` back.
    element.style.right = 'auto'

    const rect = anchor.getBoundingClientRect()
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
    // A player in picture-in-picture has its controls in a floating window the
    // panel must not cover, so hovering the page never brings it back.
    if (inPictureInPicture()) {
      // Only pay for this once: `place` also parks the panel, after which there
      // is nothing on screen for a pointer event to restore.
      if (visible || state !== 'idle') {
        closeMenu()
        setState('idle')
        if (panel) panel.dataset.visible = 'false'
        visible = false
      }
      return
    }
    if (!anchor || !anchor.isConnected) anchor = findMediaElement().element
    if (!anchor) {
      // A pinned panel has no box to hover, so it stays put. Its own bounds are
      // still honoured, which is what lets the pointer rest on it.
      if (pageMedia) {
        show(true)
        return
      }
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
   * navigation, and the new element needs the panel anchored to it. Reactions are
   * coalesced through `refreshSoon`, because this fires on every mutation in the
   * document and a sweep for players is a tree walk, not a selector.
   */
  function observe() {
    const observer = new MutationObserver(refreshSoon)
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }

  /** Wire the panel up for good. Idempotent, because detection can approve late. */
  let activated = false
  function activate() {
    if (activated) return
    activated = true
    refreshCandidates()
    place()
    observe()
    document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
    document.addEventListener('pointerdown', onDocumentPointerDown, { passive: true, capture: true })
    window.addEventListener('scroll', schedule, { passive: true, capture: true })
    window.addEventListener('resize', schedule, { passive: true })
    // Sites that resize the player without touching the DOM (theatre mode,
    // picture-in-picture) are only caught by polling. The sweep is repeated here
    // only while no player has been found, so the expensive part happens on the
    // pages that need it and not on the ones watching a video.
    window.setInterval(() => {
      if (candidates.length === 0) refreshCandidates()
      schedule()
    }, 1000)
  }

  /** How often an unknown host is re-checked for a player, and for how long. */
  const DETECT_POLL_MS = 1200
  const DETECT_MAX_POLLS = 25

  /**
   * Ask the app whether this page holds media, and arm the panel if it does.
   *
   * This is how the panel reaches a site that is not on the curated host list:
   * the extension cannot answer for a host nobody has looked at, but the app can,
   * by reading the page.
   *
   * What triggers the question is deliberately not "a `<video>` exists". Waiting
   * for one meant a page whose player is a canvas or a script-built widget — or
   * whose `<video>` lives in a shadow root — was never checked, and got no panel
   * at all. A media element or the page's own `og:video` metadata is enough to
   * ask, which covers those pages without asking the app about every site the
   * user visits (an answer that is not media costs the app a page fetch). A
   * player that is not in the document yet is still the common case on
   * script-built sites, so this waits rather than giving up on the first look.
   */
  function watchUnknownHost() {
    let polls = 0
    const timer = window.setInterval(async () => {
      polls += 1
      // Nothing has armed the observer yet on this host, so a player that appears
      // after load is only visible to a fresh sweep.
      refreshCandidates()
      const anchor = findMediaElement().element

      /*
       * A player whose file can be named locally needs no opinion from the app.
       *
       * `playableAddress` answers that in three ways, all exact: the address the
       * browser resolved (`<video><source src="…clip.mp4">`), the media file the
       * page's own download button points at, and — for a `blob:` player, which
       * names nothing at all in the DOM — the stream the page actually requested,
       * read from its own resource timings.
       *
       * On a host that answers every non-browser request with 403 (rule34, and
       * every other Cloudflare-fronted site) these are the *only* answers that
       * exist: asking the app made it fetch a page it cannot read, answer
       * "unknown", and leave the panel off a page the user was demonstrably
       * watching a video on. That question also costs the app a real page fetch,
       * so this is both more reliable and cheaper.
       */
      if (anchor && self.AriaDmUrls.playableAddress(anchor, location) !== '') {
        window.clearInterval(timer)
        activate()
        return
      }

      const looksLikeMedia = anchor !== null || pageDeclaresMedia()
      if (!looksLikeMedia) {
        if (polls >= DETECT_MAX_POLLS) window.clearInterval(timer)
        return
      }
      window.clearInterval(timer)

      let response = null
      try {
        response = await chrome.runtime.sendMessage({ type: 'detectPage', url: location.href })
      } catch {
        response = null
      }
      if (response && response.ok && response.media) {
        pageMedia = true
        activate()
      }
    }, DETECT_POLL_MS)
  }

  async function start() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'mediaSites' })
      allowedHosts = Array.isArray(response && response.sites) ? response.sites : []
    } catch {
      allowedHosts = []
    }
    // A first sweep before anything can ask for one: both the detection gate and
    // the panel read the candidate list.
    refreshCandidates()

    // A known site is armed straight away; anywhere else needs the app to agree
    // that there is media on the page before the panel appears.
    if (isAllowedHost(location.hostname)) activate()
    else watchUnknownHost()
  }

  void start()
})()
