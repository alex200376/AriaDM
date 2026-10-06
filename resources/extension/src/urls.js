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
  function playedAddress(video) {
    if (!video) return ''

    const candidates = []
    if (typeof video.currentSrc === 'string') candidates.push(video.currentSrc)
    if (typeof video.src === 'string') candidates.push(video.src)
    if (typeof video.querySelectorAll === 'function') {
      for (const source of video.querySelectorAll('source[src]')) {
        if (source && typeof source.src === 'string') candidates.push(source.src)
      }
    }

    for (const candidate of candidates) {
      if (!candidate) continue
      let parsed
      try {
        parsed = new URL(candidate)
      } catch {
        continue
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue

      const last = parsed.pathname.split('/').filter(Boolean).pop() || ''
      const dot = last.lastIndexOf('.')
      if (dot <= 0) continue
      if (MEDIA_FILE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase())) return candidate
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
    if (!patternFor(location.hostname)) return playedAddress(video) || pageUrl
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
    MAX_CARD_DEPTH,
    MAX_CARD_SCALE
  }
})(typeof self !== 'undefined' ? self : globalThis)
