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
 *
 * Only `kind` here is data. The wording lives in the dictionaries, resolved by
 * `t()` against the locale `setLocale` last selected, so an English interface
 * does not show Chinese sentences in its download dialog.
 */
import { t } from './i18n'

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
    message: t('media.err.botCheck'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.cookies')
  },
  {
    kind: 'age',
    patterns: [/age[- ]restricted/i, /confirm your age/i, /inappropriate for some users/i],
    message: t('media.err.age'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.cookies')
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
      t('media.err.cookiesLocked'),
    action: 'retry',
    actionLabel: t('common.retry')
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
      t('media.err.cookiesUndecryptable'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.otherBrowser')
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
      t('media.err.cookiesMissing'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.switchBrowser')
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
      t('media.err.session'),
    action: 'update-ytdlp',
    actionLabel: t('media.err.action.updateYtdlp')
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
      t('media.err.emptyResponse'),
    action: 'retry',
    actionLabel: t('common.retry')
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
      t('media.err.fs')
  },
  {
    /**
     * An X post that exists and holds a video, but is marked sensitive.
     *
     * X answers an anonymous client with a TweetTombstone rather than the tweet,
     * so yt-dlp sees no media and reports `No video could be found in this tweet`
     * — which reads like "this post has no video" when in fact the post is simply
     * invisible to a signed-out visitor. A session is what reveals it, and the
     * extension is the source that works when the browser store will not read.
     */
    kind: 'auth',
    patterns: [
      /no video could be found in this tweet/i,
      /tweet is unavailable/i,
      /possibly[_ ]sensitive/i,
      /tombstone/i
    ],
    message:
      t('media.err.tweetHidden'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.cookies')
  },
  {
    kind: 'auth',
    patterns: [
      /login required/i,
      /requires authentication/i,
      /not authorized/i,
      /private (video|tweet)/i,
      /only available to/i,
      /*
       * Instagram's own wording when it will not serve media to a visitor it
       * considers signed out — measured from its extractor, which raises these
       * instead of a generic auth error.
       */
      /locked behind the login page/i,
      /redirected to the login page/i
    ],
    message: t('media.err.authRequired'),
    action: 'enable-cookies',
    actionLabel: t('media.err.action.cookies')
  },
  {
    /**
     * Throttling, which Instagram applies quickly to a signed-out client. Listed
     * before the network rules because a 429 arrives wrapped in "Unable to
     * download webpage", and waiting is the fix rather than checking the network.
     */
    kind: 'rate-limit',
    patterns: [/rate[- ]limit/i, /too many requests/i, /http error 429/i],
    message: t('media.err.rateLimit'),
    action: 'retry',
    actionLabel: t('common.retry')
  },
  {
    kind: 'geo',
    patterns: [/not available in your country/i, /geo[- ]?restrict/i, /blocked in your/i],
    message: t('media.err.geo')
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
    message: t('media.err.unavailable')
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
    message: t('media.err.noVideoInPost')
  },
  {
    kind: 'format',
    patterns: [/requested format is not available/i, /requested format not available/i],
    message: t('media.err.formatGone'),
    action: 'retry',
    actionLabel: t('media.err.action.reprobe')
  },
  {
    /**
     * The app's own ffmpeg requirement for subtitles and audio conversion.
     *
     * Listed ahead of the merge rule so these two name what the user was trying
     * to do — embedding a subtitle track, converting to mp3 — rather than
     * talking about muxing a video, which is a different operation.
     */
    kind: 'ffmpeg',
    // The Chinese entries match the messages this app throws itself; the English
    // one covers the same messages once the interface is English, which is the
    // whole point of moving them into the dictionaries.
    patterns: [/嵌入字幕/, /轉換音訊格式/, /需要 ffmpeg/, /needs ffmpeg/i],
    message: t('media.err.ffmpegNeeded'),
    action: 'install-ffmpeg',
    actionLabel: t('media.err.action.installFfmpeg')
  },
  {
    kind: 'ffmpeg',
    patterns: [
      /ffmpeg (is )?not (installed|found)/i,
      /you have requested merging/i,
      /ffprobe/i,
      // Our own message for the same situation, thrown before yt-dlp ever runs.
      /需要合併音訊與視訊/,
      /needs its audio and video muxed/i
    ],
    message: t('media.err.ffmpegMerge'),
    action: 'install-ffmpeg',
    actionLabel: t('media.err.action.installFfmpeg')
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
    message: t('media.err.extractor'),
    action: 'update-ytdlp',
    actionLabel: t('media.err.action.updateYtdlp')
  },
  {
    kind: 'unsupported',
    patterns: [/unsupported url/i, /not a valid url/i, /no video found/i],
    message: t('media.err.noVideoHere')
  },
  {
    kind: 'timeout',
    patterns: [/timed out/i, /timeout/i, /讀取影片資訊逾時/],
    message: t('media.err.timeout'),
    action: 'retry',
    actionLabel: t('common.retry')
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
    message: t('media.err.network'),
    action: 'retry',
    actionLabel: t('common.retry')
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
  if (!message) {
    return { kind: 'unknown', message: t('media.err.generic'), action: 'retry', actionLabel: t('common.retry') }
  }

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(message))) {
      const suffix =
        rule.kind === 'extractor' && options.ytdlpVersion
          ? t('media.err.versionSuffix', { version: options.ytdlpVersion })
          : ''
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
  return {
    kind: 'unknown',
    message: condensed || t('media.err.generic'),
    action: 'retry',
    actionLabel: t('common.retry')
  }
}
