import { describe, expect, it } from 'vitest'

import type { MediaFormatInfo } from '../../src/shared/settings'
import { cleanIpcError, classifyMediaError } from '../../src/shared/media-errors'
import { defaultFormatId } from '../../src/shared/media-formats'
import { resolveCookieArgs } from '../../src/main/media/browser-cookies'

/**
 * These cover the three things that made "download this video" fail on a machine
 * where everything looked installed: an error nobody can read, no login session
 * for the site, and a default quality that cannot be produced without ffmpeg.
 */

describe('media error reporting', () => {
  it('strips the IPC wrapper Electron adds to a rejected handler, and `ERROR:`', () => {
    const wrapped =
      "Error invoking remote method 'integrations:getMediaFormats': Error: ERROR: [twitter] 1234: Video #1 is unavailable"
    expect(cleanIpcError(wrapped)).toBe('[twitter] 1234: Video #1 is unavailable')
  })

  it('explains an unavailable video instead of repeating yt-dlp', () => {
    const info = classifyMediaError(
      "Error invoking remote method 'integrations:getMediaFormats': Error: ERROR: [twitter] 2104816801968509100: Video #1 is unavailable"
    )
    expect(info.kind).toBe('unavailable')
    expect(info.message).toContain('已被刪除')
    expect(info.message).not.toContain('remote method')
  })

  it('turns a bot check into the setting that fixes it', () => {
    const info = classifyMediaError("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot")
    expect(info.kind).toBe('bot-check')
    expect(info.action).toBe('enable-cookies')
    expect(info.actionLabel).toBeTruthy()
  })

  it('suggests updating yt-dlp when the extractor breaks, and names the version', () => {
    const info = classifyMediaError('ERROR: [youtube] Unable to extract player response', {
      ytdlpVersion: '2024.08.06'
    })
    expect(info.kind).toBe('extractor')
    expect(info.action).toBe('update-ytdlp')
    expect(info.message).toContain('2024.08.06')
  })

  it('routes a merge failure to the ffmpeg install', () => {
    const info = classifyMediaError('這個格式需要合併音訊與視訊，請先安裝 ffmpeg 媒體包，或改選單檔畫質。')
    expect(info.kind).toBe('ffmpeg')
    expect(info.action).toBe('install-ffmpeg')
  })

  it('offers a re-probe when the chosen format is gone', () => {
    const info = classifyMediaError('ERROR: [youtube] Requested format is not available')
    expect(info.kind).toBe('format')
    expect(info.action).toBe('retry')
  })

  it('keeps yt-dlp’s own words for an unrecognised failure, minus the site prefix', () => {
    const info = classifyMediaError('ERROR: [vimeo] something entirely new went wrong')
    expect(info.kind).toBe('unknown')
    expect(info.message).toBe('something entirely new went wrong')
  })

  it('always returns something to show', () => {
    expect(classifyMediaError('').message.length).toBeGreaterThan(0)
  })

  it('sends an Instagram login wall to the cookie setting', () => {
    const info = classifyMediaError(
      'ERROR: [Instagram] CxYzAbCdEf: Login required to view this content'
    )
    expect(info.kind).toBe('auth')
    expect(info.action).toBe('enable-cookies')
  })

  it('explains a post that has no video instead of blaming the quality', () => {
    // Instagram photo posts and image-only tweets reach yt-dlp the same way a
    // broken format does, and the old message told the user their chosen quality
    // no longer existed.
    const post = classifyMediaError('ERROR: [Instagram] CxYzAbCdEf: There is no video in this post')
    expect(post.kind).toBe('unsupported')
    expect(post.message).toContain('圖片')
    expect(post.message).not.toContain('畫質')

    expect(classifyMediaError('ERROR: [Instagram] CxYzAbCdEf: No video formats found').kind).toBe(
      'unsupported'
    )
    // A genuinely missing *format* still reads as one.
    expect(classifyMediaError('ERROR: Requested format is not available').kind).toBe('format')
  })

  it('tells the user to wait when the site is throttling, not to check the network', () => {
    const info = classifyMediaError(
      'ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests'
    )
    expect(info.kind).toBe('rate-limit')
    expect(info.action).toBe('retry')
  })
})

describe('browser cookie resolution', () => {
  const windowsEnv = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }

  it('uses whichever browser is installed when set to automatic', () => {
    const cookies = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies'
    const result = resolveCookieArgs('auto', {
      platform: 'win32',
      env: windowsEnv,
      exists: (file) => file === cookies,
      stat: (file) => (file === cookies ? { mtimeMs: 1000 } : null),
      readdir: () => ['Default']
    })
    // The profile is named explicitly, so the store that was checked is the one
    // yt-dlp reads — see browser-cookies.test.ts for the detection cases.
    expect(result.args).toEqual([
      '--cookies-from-browser',
      'edge:C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default'
    ])
    expect(result.browser).toBe('Edge')
  })

  it('returns nothing when no browser is found and none was chosen', () => {
    const result = resolveCookieArgs('auto', { platform: 'win32', env: windowsEnv, exists: () => false })
    expect(result.args).toEqual([])
  })

  it('sends nothing at all when cookies are switched off', () => {
    const result = resolveCookieArgs('none', { platform: 'win32', env: windowsEnv, exists: () => true })
    expect(result.args).toEqual([])
  })

  it('honours an explicit browser even when it cannot be found', () => {
    // The user may keep a profile somewhere unconventional, and yt-dlp's own
    // "could not find cookies" message is translated into a hint.
    const result = resolveCookieArgs('firefox', { platform: 'win32', env: windowsEnv, exists: () => false })
    expect(result.args).toEqual(['--cookies-from-browser', 'firefox'])
  })

  it('picks the newest cookie store, not merely the first browser in the list', () => {
    const chrome = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies'
    const opera = 'C:\\Users\\me\\AppData\\Roaming\\Opera Software\\Opera Stable\\Network\\Cookies'
    const times: Record<string, number> = { [chrome]: 2000, [opera]: 1000 }

    const result = resolveCookieArgs('auto', {
      platform: 'win32',
      env: windowsEnv,
      exists: (file) => file in times,
      stat: (file) => ({ mtimeMs: times[file]! }),
      readdir: () => ['Default']
    })

    expect(result.args[1]).toBe(
      `chrome:${chrome.slice(0, chrome.indexOf('\\Network'))}`
    )
    expect(result.browser).toBe('Chrome')
  })
})

function format(overrides: Partial<MediaFormatInfo>): MediaFormatInfo {
  return {
    formatId: 'x',
    label: 'x',
    ext: 'mp4',
    resolution: '720p',
    filesize: null,
    vcodec: 'avc1',
    acodec: 'mp4a',
    note: '',
    needsFfmpeg: false,
    ...overrides
  }
}

describe('default format choice', () => {
  const best = format({ formatId: 'bestvideo+bestaudio/best', vcodec: 'auto', acodec: 'auto', needsFfmpeg: true })
  const single = format({ formatId: '22', resolution: '720p' })
  const videoOnly = format({ formatId: '137', vcodec: 'avc1', acodec: 'none', needsFfmpeg: true })
  const audio = format({ formatId: '140', resolution: 'audio', vcodec: 'none' })
  const list = [best, videoOnly, single, audio]

  it('takes the best entry when ffmpeg can merge the streams', () => {
    expect(defaultFormatId(list, true)).toBe(best.formatId)
  })

  it('falls back to a single-file format when ffmpeg is missing', () => {
    // Otherwise the download fails on the very entry the picker preselects,
    // which is what "I can't download YouTube videos" looks like.
    expect(defaultFormatId(list, false)).toBe(single.formatId)
  })

  it('never picks a video-only or ffmpeg-dependent entry without ffmpeg', () => {
    const chosen = list.find((entry) => entry.formatId === defaultFormatId(list, false))
    expect(chosen?.needsFfmpeg).toBe(false)
    expect(chosen?.acodec).not.toBe('none')
  })

  it('still returns something usable for an empty or muxed-only list', () => {
    expect(defaultFormatId([], false)).toBe('bestvideo+bestaudio/best')
    expect(defaultFormatId([audio], false)).toBe(audio.formatId)
  })
})
