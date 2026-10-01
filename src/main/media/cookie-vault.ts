/**
 * Cookies the browser extension just handed over.
 *
 * The extension runs *inside* the browser, so `chrome.cookies` gives it the live
 * session for the page the user is looking at — including for browsers whose
 * on-disk store yt-dlp cannot read at all (a Chromium fork it has never heard
 * of, a database the running browser is holding open, app-bound encryption it
 * cannot decrypt). That is what makes "download this video" work in Perplexity's
 * Comet.
 *
 * The paste path needs the same thing: when the link is typed into AriaDM rather
 * than clicked through the extension, there is no capture to carry a session
 * along, so the cookies the extension offered recently are kept here for a short
 * while and matched by host.
 *
 * Deliberately in memory only, and deliberately small: never written to disk,
 * never logged, never included in history or diagnostics, and dropped after a
 * short window. A session cookie is a credential, and this app has no business
 * keeping one longer than the download needs it.
 */

export interface CookieVaultOptions {
  /** How long an offered session stays usable. */
  ttlMs?: number
  /** How long a recorded need keeps being advertised to the extension. */
  needTtlMs?: number
  /** Injectable clock, so expiry is testable. */
  now?: () => number
}

const DEFAULT_TTL_MS = 30 * 60 * 1_000
const DEFAULT_NEED_TTL_MS = 10 * 60 * 1_000

/** The host a URL belongs to, or '' when it cannot be read. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

interface Entry {
  header: string
  storedAt: number
}

export class CookieVault {
  private readonly entries = new Map<string, Entry>()
  private readonly needs = new Map<string, number>()
  private readonly ttlMs: number
  private readonly needTtlMs: number
  private readonly now: () => number

  constructor(options: CookieVaultOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.needTtlMs = options.needTtlMs ?? DEFAULT_NEED_TTL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Store a session for a host. Returns false when there is nothing worth
   * keeping, which the caller reports back to the extension.
   */
  remember(url: string, header: string): boolean {
    const host = hostOf(url)
    const value = (header ?? '').trim()
    if (!host || !value) return false

    this.entries.set(host, { header: value, storedAt: this.now() })
    // An offered session answers any outstanding request for that host.
    this.needs.delete(host)
    return true
  }

  /** A cookie header for this URL's host, or '' when none is known. */
  forUrl(url: string): string {
    const host = hostOf(url)
    if (!host) return ''
    const entry = this.entries.get(host)
    if (!entry) return ''
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(host)
      return ''
    }
    return entry.header
  }

  /** Record that a host needs a session, so the extension is asked for one. */
  noteNeed(url: string): void {
    const host = hostOf(url)
    if (!host) return
    if (this.forUrl(url)) return
    this.needs.set(host, this.now())
  }

  /**
   * A URL the extension should supply cookies for, or '' when there is nothing
   * pending. The oldest request wins, so one is never starved by later ones.
   */
  nextNeed(): string {
    let oldestUrl = ''
    let oldestAt = Number.POSITIVE_INFINITY

    for (const [host, at] of this.needs) {
      if (this.now() - at > this.needTtlMs) {
        this.needs.delete(host)
        continue
      }
      if (at < oldestAt) {
        oldestAt = at
        oldestUrl = `https://${host}/`
      }
    }

    return oldestUrl
  }

  /** Forget everything: used when the setting is switched off. */
  clear(): void {
    this.entries.clear()
    this.needs.clear()
  }

  /** How many sessions are held, for diagnostics that never include the values. */
  get size(): number {
    return this.entries.size
  }
}
