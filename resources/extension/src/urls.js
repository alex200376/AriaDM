/**
 * What a URL points at, in the terms the popup needs.
 *
 * Kept in its own file so it can be tested without a DOM, and apart from
 * request.js because it has nothing to do with talking to the app.
 */
;(function (root) {
  /**
   * Paths on a media site that are a feed or a list rather than one item.
   *
   * The popup used to promise "you can download this video" on any page of a
   * media host — `x.com/home`, Instagram's reels tab, a YouTube search — where
   * there is nothing to grab, so the click failed for no visible reason.
   *
   * A post has at least two path segments:
   *   /user/status/123   a tweet
   *   /reel/CxYz.../     an Instagram reel
   *   /p/CxYz.../        an Instagram post
   *   /watch             a YouTube video (its id lives in the query)
   * A feed has one, and it is one of these words.
   */
  const FEED_PATHS = new Set([
    'home',
    'explore',
    'notifications',
    'messages',
    'search',
    'results',
    'feed',
    'following',
    'trending',
    'reels',
    'stories',
    'foryou'
  ])

  /** True when the page could be a single video rather than a list of them. */
  function looksLikeItemPage(url) {
    let segments
    try {
      segments = new URL(url).pathname.split('/').filter(Boolean)
    } catch {
      // An unparseable URL is not worth guessing about.
      return true
    }

    if (segments.length === 0) return false
    // X keeps its settings and sign-in flow under /i, which are never posts.
    if (segments[0] === 'i') return false
    if (segments.length === 1 && FEED_PATHS.has(segments[0])) return false
    return true
  }

  /**
   * The address of one video on a site, per host.
   *
   * The panel over a player used to hand the app `location.href`, which is the
   * *page* — and on a timeline that page is `x.com/home` or `instagram.com/`.
   * yt-dlp answers "Unsupported URL: https://x.com/home", so the same button
   * that worked on a watch page failed over every video in a feed.
   *
   * A whitelist where FEED_PATHS above is a blacklist, because the two answers
   * are used for different things: that one decides how the popup *words* its
   * state, this one decides what actually gets downloaded, and there a link to a
   * profile fails exactly as a feed does.
   *
   * Matched against path plus query — YouTube keeps the video id in the query —
   * and by host suffix, so `m.youtube.com` is covered too.
   */
  const ITEM_PATHS = [
    { sites: ['x.com', 'twitter.com'], path: /^\/[^/]+\/status\/\d+/ },
    { sites: ['instagram.com'], path: /^\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+/ },
    { sites: ['youtube.com', 'youtube-nocookie.com'], path: /^\/(watch\b|shorts\/|live\/|embed\/)/ },
    { sites: ['tiktok.com'], path: /^\/@[^/]+\/(video|photo)\/\d+/ },
    { sites: ['vimeo.com'], path: /^\/\d+/ },
    { sites: ['dailymotion.com', 'dai.ly'], path: /^\/video\/[A-Za-z0-9]+/ },
    { sites: ['facebook.com'], path: /^\/(reel\/|watch\b|videos\/)/ },
    { sites: ['threads.net'], path: /^\/@[^/]+\/post\// },
    { sites: ['bsky.app'], path: /^\/profile\/[^/]+\/post\// },
    { sites: ['reddit.com'], path: /^\/r\/[^/]+\/comments\// },
    { sites: ['twitch.tv'], path: /^\/videos\/\d+/ },
    { sites: ['bilibili.com'], path: /^\/video\/[Bb][Vv]/ },
    { sites: ['nicovideo.jp'], path: /^\/watch\// }
  ]

  /** The pattern for a host, or null when this site has no rule. */
  function patternFor(hostname) {
    const host = String(hostname || '').toLowerCase()
    for (const rule of ITEM_PATHS) {
      for (const site of rule.sites) {
        if (host === site || host.endsWith(`.${site}`)) return rule.path
      }
    }
    return null
  }

  /**
   * True when this URL names one video on this host.
   *
   * False for a site with no rule, which leaves the caller on its previous
   * behaviour rather than guessing on a site nobody has looked at.
   */
  function isItemUrl(hostname, url) {
    const pattern = patternFor(hostname)
    if (!pattern) return false

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    return pattern.test(`${parsed.pathname}${parsed.search}`)
  }

  /**
   * Containers a browser plays from a plain address.
   *
   * Mirrors the app's own list (`shared/media-sniff.ts`), because it answers the
   * same question there: is this URL the video, or a page that leads to one. The
   * manifests are here rather than with the pages because the app hands those to
   * yt-dlp, which is the only engine that can fetch the segments.
   *
   * If it ever drifts, the cost is the behaviour that came before it — the page
   * URL — and not a wrong download.
   */
  const MEDIA_FILE_EXTENSIONS = new Set([
    'mp4',
    'm4v',
    'webm',
    'mkv',
    'mov',
    'avi',
    'flv',
    'wmv',
    'mpg',
    'mpeg',
    'ogv',
    'mp3',
    'm4a',
    'aac',
    'flac',
    'opus',
    'ogg',
    'oga',
    'wav',
    'weba',
    'm3u8',
    'mpd'
  ])

  /**
   * The address the browser itself is playing, when that is a plain file.
   *
   * A `<video>` the page's own player script built is the one thing on a page we
   * can be certain about: the browser resolved it, so there is nothing to sniff
   * and no page to read. That is the difference between working and not on a site
   * behind a bot check — a Cloudflare challenge answers every non-browser request
   * with 403, so the app cannot read the page at all, while the browser is playing
   * the very video being asked about. It is also faster: the address is already
   * resolved, so the app skips the fetch and the extraction pass entirely.
   *
   * Deliberately narrow. A Media Source Extension plays from a `blob:`, a live
   * stream from `mediastream:`, and neither is a download; a page URL is not one
   * either. Anything not recognised comes back empty, which leaves the caller on
   * the behaviour it had before.
   */
  /**
   * Containers the markup may declare when the address itself does not name one.
   *
   * A script-built player often serves the file from an extensionless path —
   * `/stream/18992745` — and puts the container in the element instead:
   * `<source src="…/stream/18992745" type="video/mp4">`. Reading `type` is the
   * only way such an address is ever recognised, and the cost of trusting it is
   * one download that fails and is reported, not a page that breaks.
   */
  const MEDIA_MIME_TYPE = /^(?:video|audio)\/[a-z0-9.+-]+$/i

  function playedAddress(video) {
    if (!video) return ''

    /** Every address worth trying, with the container the markup claims for it. */
    const candidates = []
    if (typeof video.currentSrc === 'string') candidates.push({ url: video.currentSrc, type: '' })
    if (typeof video.src === 'string') candidates.push({ url: video.src, type: '' })
    if (typeof video.querySelectorAll === 'function') {
      for (const source of video.querySelectorAll('source[src]')) {
        if (!source || typeof source.src !== 'string') continue
        const declared = source.getAttribute ? source.getAttribute('type') : null
        candidates.push({ url: source.src, type: declared || '' })
      }
    }

    for (const candidate of candidates) {
      if (!candidate.url) continue
      let parsed
      try {
        parsed = new URL(candidate.url)
      } catch {
        continue
      }
      // Checked before either answer is accepted: a Media Source Extension plays
      // from a `blob:` and a live stream from `mediastream:`, and a `type`
      // attribute must never be able to promote one of those into a download.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      if (mediaFileAddress(candidate.url)) return candidate.url
      if (MEDIA_MIME_TYPE.test(candidate.type)) return candidate.url
    }

    return ''
  }

  /** How far above a player its own card can sit; past that it is the page. */
  const MAX_CARD_DEPTH = 10
  /**
   * A card is a few times the size of its player — author, caption, buttons. A
   * feed is tens of times bigger, and searching one finds somebody else's video.
   */
  const MAX_CARD_SCALE = 8

  /**
   * Every link inside an element, plus the element itself when it is one.
   *
   * The subtree search alone misses the commonest shape on a feed: the player is
   * *wrapped in* the link to its post, so the anchor is the player's own parent
   * and `querySelectorAll` on it never returns the anchor itself. That is the
   * reported Instagram case — the same button worked as soon as the post was
   * opened, and only there.
   */
  function linksWithin(element) {
    if (!element || typeof element.querySelectorAll !== 'function') return []

    const links = []
    if (element.href && typeof element.matches === 'function' && element.matches('a[href]')) {
      links.push(element.href)
    }
    for (const link of element.querySelectorAll('a[href]')) links.push(link.href)
    return links
  }

  /** The lowercased extension of a URL's last path segment, or '' when it has none. */
  function extensionOf(href) {
    let parsed
    try {
      parsed = new URL(href)
    } catch {
      return ''
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    const last = parsed.pathname.split('/').filter(Boolean).pop() || ''
    const dot = last.lastIndexOf('.')
    if (dot <= 0) return ''
    return last.slice(dot + 1).toLowerCase()
  }

  /** True when a URL names a media file at a plain address. */
  function mediaFileAddress(href) {
    if (!href) return false
    return MEDIA_FILE_EXTENSIONS.has(extensionOf(href))
  }

  /** Extensions that are a playlist of segments rather than one file. */
  const MANIFEST_EXTENSIONS = new Set(['m3u8', 'mpd'])

  /** True when a URL names an HLS or DASH manifest. */
  function isManifestAddress(href) {
    return MANIFEST_EXTENSIONS.has(extensionOf(href))
  }

  /**
   * True when a player is fed by a Media Source Extension rather than a file.
   *
   * `blob:` and `mediastream:` are the two spellings: the first is MSE appending
   * segments from a script, the second is a camera or a screen share. Neither is
   * a download, which is exactly why they need their own answer — see
   * `observedStreamAddress`.
   */
  function isStreamedAddress(video) {
    if (!video) return false
    for (const value of [video.currentSrc, video.src]) {
      if (typeof value === 'string' && /^(?:blob|mediastream):/i.test(value)) return true
    }
    return false
  }

  /**
   * The site a hostname belongs to, as the last two labels.
   *
   * A player's CDN almost always lives on a sibling subdomain (`cdn.example` next
   * to `www.example`), and a strict hostname comparison would call that a third
   * party and prefer an advert. Deliberately not a public-suffix list: this only
   * decides which of two candidate streams to prefer, and the cost of being wrong
   * is the second-best address rather than a wrong download.
   */
  function siteOf(hostname) {
    const host = String(hostname || '').toLowerCase()
    if (host === '') return ''
    const labels = host.split('.')
    return labels.length <= 2 ? host : labels.slice(-2).join('.')
  }

  /**
   * The stream a Media Source Extension player is being fed.
   *
   * A `blob:` player names nothing: the segments are appended by the page's own
   * script, so there is no element, attribute or link that holds the address —
   * which is why such a page used to look undownloadable. The page's own resource
   * timings do hold it, though: every manifest and every segment it fetched is
   * recorded there, by the browser, and a content script can read that list.
   *
   * Deliberately narrow, because the list also holds adverts and analytics:
   *
   *  - only HLS/DASH manifests and files with a media extension count, so a
   *    tracker beacon or a thumbnail can never be offered as the video;
   *  - a candidate on the page's own host wins over one on somebody else's, and
   *    the most recently requested one wins within that — it is the ladder step
   *    being played right now, which is the thing the button promises;
   *  - a manifest beats a file, because one request can carry the whole video
   *    where a single segment is a few seconds of it.
   *
   * `options.entries` exists so this can be tested without a browser.
   */
  function observedStreamAddress(location, options) {
    const entries =
      (options && options.entries) ||
      (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('resource')
        : [])
    if (!entries || entries.length === 0) return ''

    const pageHost = String((location && location.hostname) || '').toLowerCase()
    const manifests = []
    const files = []

    for (const entry of entries) {
      const name = entry && (entry.name || entry.url)
      if (typeof name !== 'string' || name === '') continue
      let parsed
      try {
        parsed = new URL(name)
      } catch {
        continue
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      const sameHost = siteOf(parsed.hostname) !== '' && siteOf(parsed.hostname) === siteOf(pageHost)

      if (isManifestAddress(name)) manifests.push({ url: name, sameHost })
      else if (mediaFileAddress(name)) files.push({ url: name, sameHost })
    }

    const latest = (candidates) => {
      if (candidates.length === 0) return ''
      const own = candidates.filter((candidate) => candidate.sameHost)
      const preferred = own.length > 0 ? own : candidates
      return preferred[preferred.length - 1].url
    }

    return latest(manifests) || latest(files)
  }

  /**
   * The address of what a player is playing, when that is knowable locally.
   *
   * Three answers, best first: what the browser resolved, the media file the
   * page's own download button points at, and — for the `blob:` players that
   * have neither — the stream the page actually requested. All three are exact
   * where the page URL is a guess, and none of them needs the app to read a page
   * it may not be allowed to read.
   */
  function playableAddress(video, location, options) {
    return (
      playedAddress(video) ||
      linkedMediaAddress(video, location, options) ||
      observedStreamAddress(location, options)
    )
  }

  /**
   * A media file the page's own markup links, found the way a card is found.
   *
   * This is the site's own "download this video" button: an <a href="...mp4">
   * inside the player's card, which nothing here used to read. On a page the app
   * cannot fetch at all — a bot check answers every non-browser request with 403 —
   * the link the site itself offers is the only address on the page that is worth
   * anything, and it is exact where the page URL is useless.
   *
   * The walk and its limits are the same ones that find a video's post: the button
   * sits beside the player inside the card, so a search that starts at the player
   * and stops when its container stops looking like a card cannot wander into
   * somebody else's video.
   */
  function linkedMediaAddress(video, location, options) {
    if (!video) return ''

    const maxDepth = (options && options.maxDepth) || MAX_CARD_DEPTH
    const maxScale = (options && options.maxScale) || MAX_CARD_SCALE
    const document = location.ownerDocument || (typeof globalThis.document !== 'undefined' ? globalThis.document : null)

    const box = video.getBoundingClientRect()
    const area = box.width * box.height
    let node = video

    for (let depth = 0; node && depth < maxDepth; depth += 1) {
      for (const href of linksWithin(node)) {
        if (mediaFileAddress(href)) return href.split('#')[0]
      }

      const parent = node.parentElement
      if (!parent || (document && (parent === document.body || parent === document.documentElement))) break
      const rect = parent.getBoundingClientRect()
      if (area > 0 && rect.width * rect.height > area * maxScale) break
      node = parent
    }

    return ''
  }

  /**
   * The address of the video a player is showing.
   *
   * `location.href` is the page, and on a timeline the page *is* the timeline:
   * handing yt-dlp `https://x.com/home` answers "Unsupported URL: https://x.com/
   * home", so the button over a video in a feed never worked while the very same
   * button on a watch page did. A site's own card carries a link to the post it
   * holds, and the closest ancestor that has one is what names this video.
   *
   * The page wins when it is already a video page, and that check comes first for
   * a reason: walking up from the player on a watch page would reach the sidebar
   * and pick a *recommended* video instead.
   *
   * Two callers, two outcomes when nothing is recognised:
   *
   *  - a site with no rule gets the player's own address when the browser is
   *    playing a plain file or manifest, and the page URL otherwise. Nobody has
   *    looked at that site's markup, so a link found in it would be a guess — but
   *    the player's own address is not a guess, and on a site the app cannot read
   *    (a bot check answers every non-browser request with 403) it is the only
   *    answer that can work. See `playedAddress`;
   *  - a site *with* a rule gets an empty string, because there we do know what a
   *    video's address looks like and the page is not it. That says the page is a
   *    feed, and a feed cannot be downloaded — the caller should ask for the post
   *    instead of sending a request that is certain to fail.
   *
   * The empty string is deliberately *not* an address, so a caller that passes it
   * on unchanged asks the app to download `''` and gets "這個網址沒有 AriaDM 能下載
   * 的影片" for a click that could never have worked. `content.js` turns it into
   * "open the post first".
   */
  function itemUrlNear(video, location, options) {
    const pageUrl = location.href
    if (isItemUrl(location.hostname, pageUrl)) return pageUrl
    if (!patternFor(location.hostname)) {
      /*
       * The exact answers first — what the browser resolved, the page's own
       * download button, and the stream a `blob:` player was fed — and only then
       * the page itself, which is what this always did.
       */
      return playableAddress(video, location, options) || pageUrl
    }
    if (!video) return ''

    const maxDepth = (options && options.maxDepth) || MAX_CARD_DEPTH
    const maxScale = (options && options.maxScale) || MAX_CARD_SCALE
    const document = location.ownerDocument || (typeof globalThis.document !== 'undefined' ? globalThis.document : null)

    const box = video.getBoundingClientRect()
    const area = box.width * box.height
    let node = video

    for (let depth = 0; node && depth < maxDepth; depth += 1) {
      for (const href of linksWithin(node)) {
        if (isItemUrl(location.hostname, href)) {
          // A fragment is decoration on every site with a rule, and the query is
          // not: YouTube keeps the video id in it.
          return href.split('#')[0]
        }
      }

      const parent = node.parentElement
      // The whole document holds every other card too, so the search stops
      // before reaching it — a link found up there belongs to someone else.
      if (!parent || (document && (parent === document.body || parent === document.documentElement))) break
      const rect = parent.getBoundingClientRect()
      if (area > 0 && rect.width * rect.height > area * maxScale) break
      node = parent
    }

    return ''
  }

  root.AriaDmUrls = {
    FEED_PATHS,
    looksLikeItemPage,
    ITEM_PATHS,
    isItemUrl,
    itemUrlNear,
    playedAddress,
    mediaFileAddress,
    linkedMediaAddress,
    isManifestAddress,
    isStreamedAddress,
    observedStreamAddress,
    playableAddress,
    MAX_CARD_DEPTH,
    MAX_CARD_SCALE
  }
})(typeof self !== 'undefined' ? self : globalThis)
