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
