/**
 * Turning yt-dlp's failure output into something a person can act on.
 *
 * The raw text is written for the person debugging an extractor: it leads with a
 * bracketed site key and names internal concepts ("Video #1 is unavailable",
 * "Sign in to confirm you're not a bot"). That is exactly the wrong thing to show
 * in a download dialog, and it is what the user saw. Each known failure maps to a
 * plain sentence plus, where there is one, the action that actually fixes it.
 *
 * The classifier is shared: the main process uses it to throw a readable message,
 * and the renderer uses the `action` to offer the right button.
 */

export type MediaErrorKind =
  | 'unavailable'
  | 'auth'
  | 'bot-check'
  | 'age'
  | 'geo'
  | 'ffmpeg'
  | 'cookies-missing'
  | 'extractor'
  | 'format'
  | 'unsupported'
  | 'network'
  | 'timeout'
  | 'unknown'

/** What the UI can offer to do about it. */
export type MediaErrorAction = 'enable-cookies' | 'install-ffmpeg' | 'update-ytdlp' | 'retry' | 'open-browser'

export interface MediaErrorInfo {
  kind: MediaErrorKind
  /** A sentence to show the user, in the app's language. */
  message: string
  action?: MediaErrorAction
  /** Label for the button offering `action`. */
  actionLabel?: string
}

/**
 * Strip Electron's IPC wrapper.
 *
 * A rejection from `ipcMain.handle` reaches the renderer as
 * `Error invoking remote method 'integrations:getMediaFormats': Error: <text>`,
 * which is machinery, not information.
 */
export function cleanIpcError(message: string): string {
  let text = (message ?? '').trim()
  // The wrapper can nest when a handler rethrows an inner failure, and yt-dlp
  // prefixes every one of its own errors with `ERROR:`.
  for (let index = 0; index < 4; index += 1) {
    const next = text
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error invoking remote method "[^"]*":\s*/, '')
      .replace(/^Error:\s*/, '')
      .replace(/^ERROR:\s*/, '')
    if (next === text) break
    text = next
  }
  return text.trim()
}

/** The `[site]` prefix yt-dlp puts on extractor errors, if present. */
export function extractorKey(message: string): string {
  const match = /^\[([a-z0-9_:.-]+)\]/i.exec(message.trim())
  return match ? match[1]! : ''
}

interface Rule {
  kind: MediaErrorKind
  /** Matched case-insensitively against the raw message. */
  patterns: RegExp[]
  message: string
  action?: MediaErrorAction
  actionLabel?: string
}

/**
 * Order matters: the first rule that matches wins, so the specific cases are
 * listed before the general ones.
 */
const RULES: Rule[] = [
  {
    kind: 'bot-check',
    patterns: [/confirm you'?re not a bot/i, /sign in to confirm/i, /please sign in/i, /bot check/i],
    message: '網站要求登入驗證。請在設定中啟用「使用瀏覽器 Cookie」，AriaDM 就會沿用你已登入的瀏覽器工作階段。',
    action: 'enable-cookies',
    actionLabel: '啟用瀏覽器 Cookie'
  },
  {
    kind: 'age',
    patterns: [/age[- ]restricted/i, /confirm your age/i, /inappropriate for some users/i],
    message: '這段影片有年齡限制，需要登入才能下載。請啟用「使用瀏覽器 Cookie」。',
    action: 'enable-cookies',
    actionLabel: '啟用瀏覽器 Cookie'
  },
  {
    kind: 'cookies-missing',
    patterns: [/could not find .*cookies/i, /cookies database/i, /failed to decrypt/i, /could not copy .*cookie/i],
    message:
      '讀不到瀏覽器的 Cookie 資料庫。請在「設定 → 整合與工具 → 影音下載」改用你平常登入這個網站的那個瀏覽器；Chromium 系（Chrome、Edge）必須完全關閉，Cookie 才讀得到。',
    action: 'enable-cookies',
    actionLabel: '更換瀏覽器'
  },
  {
    kind: 'auth',
    patterns: [/login required/i, /requires authentication/i, /not authorized/i, /private (video|tweet)/i, /only available to/i],
    message: '這個內容需要登入才能取得。請啟用「使用瀏覽器 Cookie」，或確認你在瀏覽器中已登入。',
    action: 'enable-cookies',
    actionLabel: '啟用瀏覽器 Cookie'
  },
  {
    kind: 'geo',
    patterns: [/not available in your country/i, /geo[- ]?restrict/i, /blocked in your/i],
    message: '這段影片在你所在的地區被封鎖。'
  },
  {
    kind: 'unavailable',
    patterns: [
      /video #\d+ is unavailable/i,
      /this (video|content) is unavailable/i,
      /video unavailable/i,
      /has been removed/i,
      /has been deleted/i,
      /no longer available/i,
      /account has been suspended/i,
      /is not available any ?more/i
    ],
    message: '這段影片已被刪除、設為私人，或作者關閉了存取。'
  },
  {
    kind: 'format',
    patterns: [/requested format is not available/i, /no video formats found/i, /requested format not available/i],
    message: '這個畫質格式已不存在，請重新偵測可用格式。',
    action: 'retry',
    actionLabel: '重新偵測'
  },
  {
    kind: 'ffmpeg',
    patterns: [
      /ffmpeg (is )?not (installed|found)/i,
      /you have requested merging/i,
      /ffprobe/i,
      // Our own message for the same situation, thrown before yt-dlp ever runs.
      /需要合併音訊與視訊/
    ],
    message: '這個格式需要合併音訊與視訊，請先安裝 ffmpeg 媒體包，或改選「單檔」畫質。',
    action: 'install-ffmpeg',
    actionLabel: '安裝 ffmpeg'
  },
  {
    kind: 'extractor',
    patterns: [
      /unable to extract/i,
      /no suitable (js )?runtime/i,
      /nsig extraction failed/i,
      /player response/i,
      /unable to (find|parse)/i,
      /extractor .* (is )?(broken|outdated)/i
    ],
    message: 'yt-dlp 目前無法解析這個網站（網站改版了）。更新 yt-dlp 後再試一次通常就能解決。',
    action: 'update-ytdlp',
    actionLabel: '更新 yt-dlp'
  },
  {
    kind: 'unsupported',
    patterns: [/unsupported url/i, /not a valid url/i, /no video found/i],
    message: '這個網址沒有 AriaDM 能下載的影片。若是直接連結，請改用一般下載。'
  },
  {
    kind: 'timeout',
    patterns: [/timed out/i, /timeout/i, /讀取影片資訊逾時/],
    message: '連線逾時，請檢查網路後再試一次。',
    action: 'retry',
    actionLabel: '重試'
  },
  {
    kind: 'network',
    patterns: [
      /unable to download webpage/i,
      /getaddrinfo/i,
      /enotfound/i,
      /econnrefused/i,
      /connection reset/i,
      /ssl/i,
      /temporary failure in name resolution/i,
      /http error 5\d\d/i
    ],
    message: '連線到網站時失敗，請檢查網路或代理伺服器設定。',
    action: 'retry',
    actionLabel: '重試'
  }
]

/**
 * Describe a yt-dlp (or toolchain) failure.
 *
 * `version` is appended for extractor breakage because "yt-dlp is outdated" is
 * only actionable if you can see how old it is.
 */
export function classifyMediaError(rawMessage: string, options: { ytdlpVersion?: string } = {}): MediaErrorInfo {
  const message = cleanIpcError(rawMessage)
  if (!message) return { kind: 'unknown', message: '影音下載失敗。', action: 'retry', actionLabel: '重試' }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      const suffix =
        rule.kind === 'extractor' && options.ytdlpVersion ? `（目前版本 ${options.ytdlpVersion}）` : ''
      return {
        kind: rule.kind,
        message: `${rule.message}${suffix}`,
        action: rule.action,
        actionLabel: rule.actionLabel
      }
    }
  }

  // Unrecognised: keep yt-dlp's own words, minus its bracketed site prefix and
  // the boilerplate trailer, rather than inventing a vaguer message.
  const condensed = message
    .replace(/^\[[a-z0-9_:.-]+\]\s*/i, '')
    .replace(/\s*; please report this issue on.*$/i, '')
    .replace(/\s*Copying full debug output.*$/i, '')
    .trim()
  return { kind: 'unknown', message: condensed || '影音下載失敗。', action: 'retry', actionLabel: '重試' }
}
