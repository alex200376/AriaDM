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

  root.AriaDmUrls = { FEED_PATHS, looksLikeItemPage }
})(typeof self !== 'undefined' ? self : globalThis)
