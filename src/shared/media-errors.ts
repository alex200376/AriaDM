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
  /** The site is throttling this client; Instagram does it quickly when signed out. */
  | 'rate-limit'
  | 'ffmpeg'
  | 'cookies-missing'
  /** The cookie database exists but the browser is holding it open. */
  | 'cookies-locked'
  /** The cookies are encrypted with a scheme yt-dlp cannot read. */
  | 'cookies-undecryptable'
  /**
   * The site answered with a page it will not let this session play.
   *
   * YouTube's "The page needs to be reloaded" is the usual spelling, and a
   * logged-in cookie jar is a known trigger — the same video downloads fine
   * signed out. Worth one retry without credentials rather than a dead end.
   */
  | 'session'
  /**
   * The site returned an empty body for a request that carried a session.
   *
   * Measured, not guessed: yt-dlp given Instagram's `sessionid` in a Cookie
   * header fails with `Failed to parse JSON (…Expecting value in '': line 1
   * column 1 (char 0))`, and the very same URL resolves perfectly with no
   * cookies at all. Like `session` above, the answer is to give up the
   * credential and try once more — so it belongs in the same retry set.
   */
  | 'empty-response'
  | 'extractor'
  /** The file could not be written: a read-only folder, or a full disk. */
  | 'fs'
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
    /**
     * yt-dlp's "Could not copy Chrome cookie database" (issue 7271).
     *
     * Chromium keeps the cookie database open with a sharing mode that denies
     * readers, so this is almost always "the browser is still running" — and the
     * advice that actually works is to close it, not to change browsers.
     */
    kind: 'cookies-locked',
    patterns: [/could not copy .*cookie/i, /permissionerror/i, /issues\/7271/i],
    message:
      '瀏覽器正在執行，Cookie 資料庫被鎖住而讀不到。請完全結束該瀏覽器（含背景常駐、系統匣）後再試一次。',
    action: 'retry',
    actionLabel: '重試'
  },
  {
    /**
     * "Failed to decrypt with DPAPI" (issue 10927): Chromium 127 and later can
     * encrypt cookies with an app-bound key that belongs to that browser's own
     * executable, which yt-dlp has no way to use for a browser it does not know
     * (Perplexity Comet, for instance).
     */
    kind: 'cookies-undecryptable',
    patterns: [/failed to decrypt/i, /issues\/10927/i, /app[- ]bound/i, /possibly the key is wrong/i],
    message:
      '這個瀏覽器的 Cookie 使用應用程式綁定加密（Chromium 127 以上），yt-dlp 無法解密。請改用 Chrome、Edge 或 Firefox，或從擴充功能傳送連結，讓 AriaDM 直接取得登入狀態。',
    action: 'enable-cookies',
    actionLabel: '改用其他瀏覽器'
  },
  {
    kind: 'cookies-missing',
    patterns: [
      /could not find .*cookies/i,
      /cookies database/i,
      /no encrypted key/i,
      /could not find local state/i
    ],
    message:
      '偵測不到這個瀏覽器的 Cookie 資料庫。請確認該瀏覽器已安裝，或在「設定 → 整合與工具 → 影音下載」手動指定要用哪一個。',
    action: 'enable-cookies',
    actionLabel: '更換瀏覽器'
  },
  {
    /**
     * The site served a page this session cannot play — "The page needs to be
     * reloaded" on YouTube, most often because a logged-in cookie jar makes
     * YouTube hand back an unplayable player response. The advice is therefore
     * not "log in": it is the opposite, and AriaDM already tries that
     * automatically, so this text is what remains when that also failed.
     */
    kind: 'session',
    patterns: [/page needs to be reloaded/i, /precondition check failed/i, /tv_downgraded/i],
    message:
      '網站不接受目前的登入狀態，回傳了無法播放的頁面（YouTube 對已登入的 Cookie 常見此狀況）。已改用未登入身分重試仍失敗，請更新 yt-dlp 或在設定中改用其他瀏覽器的 Cookie。',
    action: 'update-ytdlp',
    actionLabel: '更新 yt-dlp'
  },
  {
    /**
     * An empty body where JSON was expected.
     *
     * yt-dlp reports this as `Failed to parse JSON (caused by
     * JSONDecodeError("Expecting value in '': line 1 column 1 (char 0)"))`, which
     * says nothing to anybody. Listed next to the session rule because the cause
     * is the same kind of thing: a site that will not answer a *logged-in*
     * request. The wording deliberately does not claim a retry already happened —
     * a signed-out user with no credentials to drop never gets one.
     */
    kind: 'empty-response',
    patterns: [/failed to parse json/i, /jsondecodeerror/i],
    message:
      '網站對這次要求沒有回傳內容（常見於帶著登入狀態連 Instagram）。請稍後再試；若持續失敗請更新 yt-dlp。',
    action: 'retry',
    actionLabel: '重試'
  },
  {
    /**
     * The download could not be written. Listed after the cookie rules on
     * purpose: yt-dlp reports an unreadable Chrome cookie database as a
     * PermissionError too, and that one has its own better answer.
     *
     * This is what a handoff used to produce — an installed AriaDM has no output
     * directory to fall back on, so yt-dlp wrote beside its own executable, in
     * Program Files, and reported it as `[Errno 13] Permission denied` on a
     * `.part` file with no explanation.
     */
    kind: 'fs',
    patterns: [
      /unable to open for writing/i,
      /\[errno 13\] permission denied/i,
      /\[errno 28\]/i,
      /no space left on device/i,
      /is not writable/i,
      /access is denied/i
    ],
    message:
      '無法寫入儲存資料夾（權限不足或磁碟已滿）。請在設定中更換儲存位置，或確認該資料夾可以寫入。'
  },
  {
    kind: 'auth',
    patterns: [/login required/i, /requires authentication/i, /not authorized/i, /private (video|tweet)/i, /only available to/i],
    message: '這個內容需要登入才能取得。請啟用「使用瀏覽器 Cookie」，或確認你在瀏覽器中已登入。',
    action: 'enable-cookies',
    actionLabel: '啟用瀏覽器 Cookie'
  },
  {
    /**
     * Throttling, which Instagram applies quickly to a signed-out client. Listed
     * before the network rules because a 429 arrives wrapped in "Unable to
     * download webpage", and waiting is the fix rather than checking the network.
     */
    kind: 'rate-limit',
    patterns: [/rate[- ]limit/i, /too many requests/i, /http error 429/i],
    message: '網站暫時限制了要求（次數過於頻繁）。請等幾分鐘再試，或啟用「使用瀏覽器 Cookie」以登入身分下載。',
    action: 'retry',
    actionLabel: '重試'
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
    /**
     * A post with no video in it: an Instagram photo or carousel, an X post of
     * only images. yt-dlp phrases this like a broken format, so without its own
     * rule the user was told their chosen quality no longer existed.
     */
    kind: 'unsupported',
    patterns: [
      /no video formats found/i,
      /no video in this post/i,
      /there is no video/i,
      /does not contain a video/i
    ],
    message: '這則貼文裡沒有影片（可能是圖片或輪播），所以沒有可下載的影音。'
  },
  {
    kind: 'format',
    patterns: [/requested format is not available/i, /requested format not available/i],
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
 * yt-dlp notices that are not the failure, removed before anything is matched.
 *
 * Passing a Cookie header makes yt-dlp print a deprecation notice *ahead of* the
 * real error, and both arrived as one sentence: the user's failure was reported
 * as "Deprecated Feature: Passing cookies as a header is a potential security
 * risk…". The notice is yt-dlp's business with whoever built the command line,
 * not the download's problem.
 */
const TOOL_NOTICES = [
  /Deprecated Feature: Passing cookies as a header.*?instead\./gi,
  /WARNING: Falling back on generic information extractor\.?/gi
]

export function stripToolNotices(message: string): string {
  let text = message
  for (const notice of TOOL_NOTICES) text = text.replace(notice, '')
  return text.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Describe a yt-dlp (or toolchain) failure.
 *
 * `version` is appended for extractor breakage because "yt-dlp is outdated" is
 * only actionable if you can see how old it is.
 */
export function classifyMediaError(rawMessage: string, options: { ytdlpVersion?: string } = {}): MediaErrorInfo {
  // Removing a notice from the front can expose the `ERROR:` that the wrapper
  // stripping would otherwise have taken, so the cleanup runs around it.
  const message = cleanIpcError(stripToolNotices(cleanIpcError(rawMessage)))
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
