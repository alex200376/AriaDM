import type { ClipboardDetected, DownloadKind } from '@shared/download'
import { detectKindFromList, hasFileExtension, isSupportedUri, parseUriList } from '@shared/uri'

/**
 * Electron exposes no clipboard change event, so watching means polling. 700ms
 * is the smallest interval that reads as instant to a person without burning
 * meaningful CPU on a text compare.
 */
export const CLIPBOARD_POLL_MS = 700

/** Ignore pasted blobs beyond this size; they are documents, not links. */
const MAX_TEXT_LENGTH = 4000
const MAX_LINES = 50

export interface ClipboardWatcherOptions {
  readText(): string
  onDetected(payload: ClipboardDetected): void
  log(line: string): void
  intervalMs?: number
  /** How many recent values to remember, to avoid re-prompting on the same link. */
  historySize?: number
}

/**
 * Extract candidate download URIs from arbitrary clipboard text.
 * Returns null when the text holds nothing we should offer to download.
 */
export function detectClipboardLinks(text: string): { urls: string[]; kind: DownloadKind } | null {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return null

  const candidates = parseUriList(trimmed)
  if (candidates.length === 0 || candidates.length > MAX_LINES) return null

  const urls = candidates.filter(isSupportedUri)
  if (urls.length === 0) return null

  const kind: DownloadKind = detectKindFromList(urls) === 'bittorrent' ? 'bittorrent' : detectKindFromList(urls)
  return { urls, kind }
}

/**
 * A conservative "this is definitely a file" test, used to decide whether an
 * auto-add is appropriate. Prompts still fire for anything; auto-add does not,
 * because silently downloading every copied link would be worse than useless.
 */
export function looksLikeDirectFile(url: string, contentTypes?: string[]): boolean {
  if (hasFileExtension(url)) return true
  if (contentTypes?.some((type) => /application\/(octet-stream|zip|x-|pdf)/.test(type))) return true
  return false
}

/**
 * Polls the clipboard and reports newly copied download links.
 *
 * De-duplication matters more than it sounds: without it, every poll would
 * re-offer the same link, and the user would be fighting the UI.
 */
export class ClipboardWatcher {
  private readonly options: ClipboardWatcherOptions
  private timer: NodeJS.Timeout | null = null
  private readonly seen: string[] = []
  private readonly historySize: number
  private readonly ownCopies = new Set<string>()
  private lastText = ''

  constructor(options: ClipboardWatcherOptions) {
    this.options = options
    this.historySize = options.historySize ?? 40
  }

  get running(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    // Seed with whatever is already on the clipboard so enabling the feature does
    // not immediately fire on stale content.
    this.lastText = this.options.readText()
    this.timer = setInterval(() => this.poll(), this.options.intervalMs ?? CLIPBOARD_POLL_MS)
    this.timer.unref?.()
    this.options.log('clipboard watcher started')
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.options.log('clipboard watcher stopped')
  }

  /** Register text this app put on the clipboard, so we do not react to it. */
  markOwnCopy(text: string): void {
    if (!text) return
    this.ownCopies.add(text.trim())
    if (this.ownCopies.size > 100) {
      const [oldest] = this.ownCopies
      if (oldest !== undefined) this.ownCopies.delete(oldest)
    }
  }

  private poll(): void {
    let text: string
    try {
      text = this.options.readText()
    } catch (error) {
      this.options.log(`clipboard read failed: ${(error as Error).message}`)
      return
    }

    if (text === this.lastText) return
    this.lastText = text

    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (this.ownCopies.has(trimmed)) return
    if (this.seen.includes(trimmed)) return

    const detected = detectClipboardLinks(trimmed)
    if (!detected) return

    this.remember(trimmed)
    this.options.onDetected({
      text: trimmed,
      urls: detected.urls,
      kind: detected.kind,
      seenBefore: false
    })
  }

  private remember(text: string): void {
    this.seen.push(text)
    if (this.seen.length > this.historySize) this.seen.splice(0, this.seen.length - this.historySize)
  }
}
