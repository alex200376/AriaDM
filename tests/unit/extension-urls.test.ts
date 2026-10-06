import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * The popup promises "you can download this video" based on this, so getting it
 * wrong means offering a video download on a page that has no video — which is
 * what happened on `x.com/home`: the click failed for no visible reason.
 *
 * It is loaded the way the popup loads it, as a script with its own global, so
 * the test exercises the shipped file rather than a copy of its rules.
 */

interface Urls {
  looksLikeItemPage(url: string): boolean
  isItemUrl(hostname: string, url: string): boolean
  playedAddress(video: unknown): string
  itemUrlNear(video: unknown, location: unknown, options?: unknown): string
}

function loadUrls(): Urls {
  const source = readFileSync(
    new URL('../../resources/extension/src/urls.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmUrls?: Urls } = {}
  new Function('self', source)(target)
  if (!target.AriaDmUrls) throw new Error('urls.js did not define AriaDmUrls')
  return target.AriaDmUrls
}

const urls = loadUrls()

describe('looksLikeItemPage', () => {
  it('recognises an Instagram reel, post or IGTV entry', () => {
    expect(urls.looksLikeItemPage('https://www.instagram.com/reel/CxYzAbCdEf/')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.instagram.com/p/CxYzAbCdEf/')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.instagram.com/tv/CxYzAbCdEf/')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.instagram.com/stories/someone/123456/')).toBe(true)
  })

  it('does not call Instagram\u2019s feeds a video', () => {
    expect(urls.looksLikeItemPage('https://www.instagram.com/')).toBe(false)
    expect(urls.looksLikeItemPage('https://www.instagram.com/explore/')).toBe(false)
    expect(urls.looksLikeItemPage('https://www.instagram.com/reels/')).toBe(false)
    expect(urls.looksLikeItemPage('https://www.instagram.com/stories/')).toBe(false)
  })

  it('handles the case that was reported: X\u2019s home timeline', () => {
    expect(urls.looksLikeItemPage('https://x.com/home')).toBe(false)
    expect(urls.looksLikeItemPage('https://x.com/explore')).toBe(false)
    // X keeps sign-in and settings under /i, which are never posts.
    expect(urls.looksLikeItemPage('https://x.com/i/flow/login')).toBe(false)
    // An actual tweet has the account and the status.
    expect(urls.looksLikeItemPage('https://x.com/someone/status/1234567890')).toBe(true)
  })

  it('keeps YouTube\u2019s watch page, which carries its id in the query', () => {
    expect(urls.looksLikeItemPage('https://www.youtube.com/watch?v=A14Q0fej6Hg')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.youtube.com/shorts/A14Q0fej6Hg')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.youtube.com/')).toBe(false)
    expect(urls.looksLikeItemPage('https://www.youtube.com/results?search_query=x')).toBe(false)
  })

  it('recognises TikTok videos but not its feed', () => {
    expect(urls.looksLikeItemPage('https://www.tiktok.com/@someone/video/7123456789')).toBe(true)
    expect(urls.looksLikeItemPage('https://www.tiktok.com/foryou')).toBe(false)
  })

  it('assumes an item when the URL cannot be parsed', () => {
    // Nothing to be gained by blocking a page we cannot read.
    expect(urls.looksLikeItemPage('not a url')).toBe(true)
  })
})

/**
 * The panel over a video sends the app the video's own address, so this is what
 * stands between "the button works" and yt-dlp's "Unsupported URL".
 */
describe('isItemUrl', () => {
  it('separates the reported page from the video on it', () => {
    // The button over a video in X's timeline was handed `x.com/home`, which
    // yt-dlp cannot resolve, so it failed where the same button on a tweet page
    // worked.
    expect(urls.isItemUrl('x.com', 'https://x.com/home')).toBe(false)
    expect(urls.isItemUrl('x.com', 'https://x.com/home?foo=1')).toBe(false)
    expect(urls.isItemUrl('x.com', 'https://x.com/someone/status/1234567890')).toBe(true)
    expect(urls.isItemUrl('x.com', 'https://x.com/someone/status/1234567890/video/1')).toBe(true)
    expect(urls.isItemUrl('twitter.com', 'https://twitter.com/someone/status/1234567890')).toBe(true)
  })

  it('never mistakes a profile for a video', () => {
    // A profile link is what a feed card holds besides its post, and it fails at
    // yt-dlp just as a feed does.
    expect(urls.isItemUrl('x.com', 'https://x.com/someone')).toBe(false)
    expect(urls.isItemUrl('x.com', 'https://x.com/someone/photo')).toBe(false)
    expect(urls.isItemUrl('instagram.com', 'https://www.instagram.com/someone/')).toBe(false)
  })

  it('finds the same case on Instagram', () => {
    expect(urls.isItemUrl('instagram.com', 'https://www.instagram.com/')).toBe(false)
    expect(urls.isItemUrl('instagram.com', 'https://www.instagram.com/explore/')).toBe(false)
    expect(urls.isItemUrl('instagram.com', 'https://www.instagram.com/reel/CxYzAbCdEf/')).toBe(true)
    expect(urls.isItemUrl('instagram.com', 'https://www.instagram.com/p/CxYzAbCdEf/')).toBe(true)
  })

  it('keeps YouTube\u2019s id in the query, and its feeds out', () => {
    expect(urls.isItemUrl('www.youtube.com', 'https://www.youtube.com/watch?v=A14Q0fej6Hg')).toBe(true)
    expect(urls.isItemUrl('www.youtube.com', 'https://www.youtube.com/shorts/A14Q0fej6Hg')).toBe(true)
    expect(urls.isItemUrl('youtube.com', 'https://www.youtube.com/')).toBe(false)
    expect(urls.isItemUrl('youtube.com', 'https://www.youtube.com/results?search_query=x')).toBe(false)
  })

  it('matches subdomains and the other sites with a rule', () => {
    expect(urls.isItemUrl('m.youtube.com', 'https://m.youtube.com/watch?v=x')).toBe(true)
    expect(urls.isItemUrl('mobile.x.com', 'https://mobile.x.com/someone/status/1')).toBe(true)
    expect(urls.isItemUrl('tiktok.com', 'https://www.tiktok.com/@someone/video/7123456789')).toBe(true)
    expect(urls.isItemUrl('tiktok.com', 'https://www.tiktok.com/foryou')).toBe(false)
    expect(urls.isItemUrl('bsky.app', 'https://bsky.app/profile/someone.bsky.social/post/abc')).toBe(true)
  })

  it('says nothing about a site it has no rule for', () => {
    // The caller falls back to the page URL, which is what it always did, rather
    // than trusting a guess about markup nobody has looked at.
    expect(urls.isItemUrl('example.com', 'https://example.com/some/video')).toBe(false)
    expect(urls.isItemUrl('', 'not a url')).toBe(false)
  })
})

/**
 * The address the browser itself is playing.
 *
 * This is what makes the panel work on a site the app cannot read at all: a
 * Cloudflare challenge answers every non-browser request with 403, so the page is
 * unreadable, while the browser has already resolved the video. The address it
 * resolved is not a guess and needs no sniff — it is the file itself.
 */
describe('playedAddress', () => {
  it('answers the file the browser is already playing', () => {
    expect(urls.playedAddress({ currentSrc: 'https://cdn.example/v/clip.mp4?t=1' })).toBe(
      'https://cdn.example/v/clip.mp4?t=1'
    )
    expect(urls.playedAddress({ src: 'https://cdn.example/v/clip.webm' })).toBe(
      'https://cdn.example/v/clip.webm'
    )
    // A manifest player has no src until it has chosen one; the <source> child is
    // where the address is declared.
    expect(
      urls.playedAddress({ querySelectorAll: () => [{ src: 'https://cdn.example/hls/index.m3u8' }] })
    ).toBe('https://cdn.example/hls/index.m3u8')
  })

  it('prefers the source the browser actually resolved', () => {
    // currentSrc is what it settled on; src is what the markup offered.
    expect(
      urls.playedAddress({
        currentSrc: 'https://cdn.example/1080.mp4',
        src: 'https://cdn.example/360.mp4'
      })
    ).toBe('https://cdn.example/1080.mp4')
  })

  it('refuses anything that is not a media file at a plain address', () => {
    // A Media Source Extension plays from a blob:, a live stream from
    // mediastream:, and neither is a download. A page URL is not one either.
    expect(urls.playedAddress({ currentSrc: 'blob:https://x.com/1234' })).toBe('')
    expect(urls.playedAddress({ src: 'mediastream:1234' })).toBe('')
    expect(urls.playedAddress({ src: 'data:video/mp4;base64,AAAA' })).toBe('')
    expect(urls.playedAddress({ src: 'https://example.test/watch/123' })).toBe('')
    expect(urls.playedAddress({ src: 'https://example.test/watch/123.html' })).toBe('')
    expect(urls.playedAddress(null)).toBe('')
    expect(urls.playedAddress({})).toBe('')
  })
})

/**
 * Which video the button over a player downloads.
 *
 * Built out of fake elements rather than a browser because this is what decides
 * the *subject* of the download: the wrong answer fetches somebody else's video,
 * and the reported failure was this exact choice landing on the timeline instead
 * of the video in it.
 */
interface FakeNode {
  parentElement: FakeNode | null
  children: FakeNode[]
  anchors: string[]
  href: string
  side: number
  src?: string
  currentSrc?: string
  matches(selector: string): boolean
  querySelectorAll(selector: string): { href: string; src?: string }[]
  getBoundingClientRect(): { width: number; height: number }
}

function collectLinks(target: FakeNode): { href: string }[] {
  return [...target.anchors.map((href) => ({ href })), ...target.children.flatMap(collectLinks)]
}

/**
 * An element whose `querySelectorAll` really does search its subtree.
 *
 * `href` makes the element itself an anchor, which is the shape a feed uses: the
 * player sits *inside* the link to its post, so the link is the player's parent
 * and a subtree search on it can never return the link itself.
 */
function node(
  options: {
    anchors?: string[]
    href?: string
    side?: number
    src?: string
    currentSrc?: string
    sources?: string[]
  } = {},
  children: FakeNode[] = []
): FakeNode {
  const target = {} as FakeNode
  Object.assign(target, {
    parentElement: null,
    children,
    anchors: options.anchors ?? [],
    href: options.href ?? '',
    side: options.side ?? 100,
    src: options.src,
    currentSrc: options.currentSrc,
    matches: (selector: string) => selector === 'a[href]' && Boolean(target.href),
    // A real subtree search, so a `<source>` child is found where a real one
    // would be — and the anchors, which are the other thing this is asked for.
    querySelectorAll: () => [
      ...collectLinks(target),
      ...(options.sources ?? []).map((src) => ({ src }))
    ],
    getBoundingClientRect: () => ({ width: target.side, height: target.side })
  })
  for (const child of children) child.parentElement = target
  return target
}

function page(href: string, body: FakeNode, documentElement: FakeNode) {
  return { href, hostname: new URL(href).hostname, ownerDocument: { body, documentElement } }
}

describe('itemUrlNear', () => {
  it('still sends the page when the page is a post on a ruled site', () => {
    const video = node({ side: 400 })
    const body = node({ side: 2000 }, [video])

    expect(urls.itemUrlNear(video, page('https://www.instagram.com/reel/CxYzAbCdEf/', body, body))).toBe(
      'https://www.instagram.com/reel/CxYzAbCdEf/'
    )
  })

  it('finds the post a video in X\u2019s timeline belongs to', () => {
    const video = node({ side: 100 })
    const card = node({ anchors: ['https://x.com/someone/status/1234567890'], side: 200 }, [video])
    const timeline = node({ side: 1000 }, [card])
    const body = node({ side: 2000 }, [timeline])

    expect(urls.itemUrlNear(video, page('https://x.com/home', body, body))).toBe(
      'https://x.com/someone/status/1234567890'
    )
  })

  it('takes the nearest card rather than one further out', () => {
    const video = node({ side: 100 })
    const card = node({ anchors: ['https://x.com/me/status/2'], side: 200 }, [video])
    // A parent holding several posts must not win over the card that has this one.
    const thread = node({ anchors: ['https://x.com/other/status/999'], side: 400 }, [card])
    const body = node({ side: 2000 }, [thread])

    expect(urls.itemUrlNear(video, page('https://x.com/home', body, body))).toBe(
      'https://x.com/me/status/2'
    )
  })

  it('keeps the page when the page is already the video', () => {
    // Walking up on a watch page reaches the sidebar, whose links are a
    // *recommended* video — the one thing worse than failing.
    const video = node({ side: 400 })
    const player = node({ side: 600 }, [video])
    const body = node(
      { anchors: ['https://www.youtube.com/watch?v=SOMETHING_ELSE'], side: 2000 },
      [player]
    )

    expect(
      urls.itemUrlNear(video, page('https://www.youtube.com/watch?v=A14Q0fej6Hg', body, body))
    ).toBe('https://www.youtube.com/watch?v=A14Q0fej6Hg')
  })

  it('keeps YouTube\u2019s id, and drops the timestamp fragment', () => {
    const video = node({ side: 100 })
    const card = node(
      { anchors: ['https://www.youtube.com/watch?v=A14Q0fej6Hg#t=42'], side: 200 },
      [video]
    )
    const feed = node({ side: 400 }, [card])
    const body = node({ side: 2000 }, [feed])

    expect(urls.itemUrlNear(video, page('https://www.youtube.com/', body, body))).toBe(
      'https://www.youtube.com/watch?v=A14Q0fej6Hg'
    )
  })

  it('finds the post a player is wrapped in', () => {
    // The reported Instagram case: the player sits inside the link to its own
    // post, so there is no link *under* it to find. The button only worked once
    // the post was opened, because only then was the page itself the post.
    const player = node({ href: 'https://www.instagram.com/reel/CxYzAbCdEf/', side: 220 })
    const video = node({ side: 100 })
    player.children.push(video)
    video.parentElement = player
    const body = node({ side: 2000 }, [player])

    expect(urls.itemUrlNear(video, page('https://www.instagram.com/', body, body))).toBe(
      'https://www.instagram.com/reel/CxYzAbCdEf/'
    )
  })

  it('stops at the point where the container is no longer a card', () => {
    // Past that point the links belong to other posts, and a link found up there
    // would download a video the user never pointed at. Nothing is better than
    // somebody else's video, so the answer is "no video here" rather than the
    // timeline, which the app could only fail on.
    const video = node({ side: 100 })
    const cardWithoutLink = node({ side: 200 }, [video])
    const feed = node({ anchors: ['https://x.com/someone/status/999'], side: 1000 }, [
      cardWithoutLink
    ])
    const body = node({ side: 2000 }, [feed])

    expect(urls.itemUrlNear(video, page('https://x.com/home', body, body))).toBe('')
  })

  it('never reads a link out of the document itself', () => {
    const video = node({ side: 100 })
    const card = node({ side: 200 }, [video])
    const body = node({ anchors: ['https://x.com/someone/status/999'], side: 2000 }, [card])

    expect(urls.itemUrlNear(video, page('https://x.com/home', body, body))).toBe('')
  })

  it('answers "no video here" rather than the page on a feed', () => {
    // The panel is over a video in a feed, and the feed is not a video. An empty
    // answer is what tells the panel to say "open the post" instead of sending a
    // request for `instagram.com/` that is certain to fail.
    const video = node({ side: 100 })
    const card = node({ side: 200 }, [video])
    const body = node({ side: 2000 }, [card])

    expect(urls.itemUrlNear(video, page('https://www.instagram.com/', body, body))).toBe('')
    expect(urls.itemUrlNear(video, page('https://x.com/home', body, body))).toBe('')
    expect(urls.itemUrlNear(video, page('https://www.instagram.com/reels/', body, body))).toBe('')
  })

  it('falls back to the page on a site with no rules', () => {
    // Nobody has looked at this markup, so the app is left to try and report its
    // own reason rather than the extension refusing on a guess.
    const video = node({ side: 100 })
    const card = node({ anchors: ['https://example.com/watch/1'], side: 200 }, [video])
    const body = node({ side: 2000 }, [card])

    expect(urls.itemUrlNear(video, page('https://example.com/feed', body, body))).toBe(
      'https://example.com/feed'
    )
  })

  it('hands over the video the browser is playing on a site the app cannot read', () => {
    // The reported case: a post page behind a bot check. The app's own fetch gets
    // a 403 challenge, so the page is unreadable and no player in it can ever be
    // found — while the browser has already built the player and resolved this
    // exact address. Sending it skips the unreadable page and the extractor pass.
    const video = node({ side: 100, currentSrc: 'https://cdn.example/v/clip.mp4' })
    const body = node({ side: 2000 }, [video])
    const location = page(
      'https://rule34.xxx/index.php?page=post&s=view&id=18961415&tags=video',
      body,
      body
    )

    expect(urls.itemUrlNear(video, location)).toBe('https://cdn.example/v/clip.mp4')
  })

  it('still sends the page when the player has no address of its own', () => {
    // A Media Source Extension plays from a blob, which is not downloadable, so
    // there is nothing better to send than the page.
    const video = node({ side: 100, currentSrc: 'blob:https://example.com/abcd' })
    const body = node({ side: 2000 }, [video])

    expect(urls.itemUrlNear(video, page('https://example.com/feed', body, body))).toBe(
      'https://example.com/feed'
    )
  })

  it('reads a manifest out of the player on a site with no rules', () => {
    const video = node({ side: 100, sources: ['https://cdn.example/hls/index.m3u8'] })
    const body = node({ side: 2000 }, [video])

    expect(urls.itemUrlNear(video, page('https://example.com/feed', body, body))).toBe(
      'https://cdn.example/hls/index.m3u8'
    )
  })

  it('says nothing on a site with no rules and no player either', () => {
    const body = node({ side: 2000 })
    expect(urls.itemUrlNear(null, page('https://example.com/feed', body, body))).toBe(
      'https://example.com/feed'
    )
  })

  it('answers "no video here" when a ruled site has no player', () => {
    const body = node({ side: 2000 })
    expect(urls.itemUrlNear(null, page('https://x.com/home', body, body))).toBe('')
  })
})
