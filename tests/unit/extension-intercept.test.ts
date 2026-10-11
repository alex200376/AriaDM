import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

/**
 * The extension's download-interception policy.
 *
 * It is loaded the way a browser loads it — as a plain script with its own
 * global — and handed fake dependencies, because the bug it exists to prevent is
 * a timing one: a service worker that chrome has just re-evaluated answers
 * `chrome.downloads.onCreated` before it has read the stored config, so the
 * first download after the worker went idle used to be left to the browser.
 */

interface Strings {
  t(key: string, substitutions?: Record<string, unknown>): string
}

interface Intercept {
  handleCreated(item: Record<string, unknown>, deps: Record<string, unknown>): Promise<{
    ok: boolean
    action: string
  }>
  usable(item: Record<string, unknown>): boolean
}

function loadStrings(): Strings {
  const source = readFileSync(
    new URL('../../resources/extension/src/strings.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmStrings?: Strings } = {}
  new Function('self', source)(target)
  if (!target.AriaDmStrings) throw new Error('strings.js did not define AriaDmStrings')
  return target.AriaDmStrings
}

const strings = loadStrings()

function loadIntercept(): Intercept {
  const source = readFileSync(
    new URL('../../resources/extension/src/intercept.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmIntercept?: Intercept } = {}
  new Function('self', source)(target)
  if (!target.AriaDmIntercept) throw new Error('intercept.js did not define AriaDmIntercept')
  return target.AriaDmIntercept
}

const intercept = loadIntercept()

const ITEM = { id: 7, url: 'https://example.com/big.iso', filename: '/tmp/downloads/big.iso' }

/**
 * A browser and an app, with only the parts a test needs to vary.
 *
 * `hydrated` starts false so the default is the case that used to be broken: a
 * worker that has not read its stored config yet.
 */
function deps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isIgnored: vi.fn(() => false),
    isHydrated: vi.fn(() => false),
    hydration: Promise.resolve(),
    isEnabled: vi.fn(() => true),
    cleanup: vi.fn(async () => {}),
    payloadFor: vi.fn(async (url: string) => ({ urls: [url] })),
    handoff: vi.fn(async () => ({ ok: true })),
    restore: vi.fn(async () => true),
    unknownError: () => 'unknown error',
    basename: (file: string) => file.split(/[/\\]/).pop() ?? file,
    delay: async () => {},
    notify: vi.fn(async () => {}),
    ...overrides
  }
}

describe('extension download interception', () => {
  it('decides from the stored config, not from the defaults a cold worker starts with', async () => {
    // The regression: the worker was just re-evaluated, so its in-memory config
    // still says "off" while storage says "on". Refusing to decide until the
    // read has landed is the whole fix.
    let enabled = false
    const hydration = Promise.resolve().then(() => {
      enabled = true
    })
    const d = deps({ isEnabled: () => enabled, hydration })

    const result = await intercept.handleCreated(ITEM, d)

    expect(result).toEqual({ ok: true, action: 'handed-off' })
    expect(d.cleanup).toHaveBeenCalledOnce()
    expect(d.handoff).toHaveBeenCalledOnce()
  })

  it('leaves a download untouched when the stored config says interception is off', async () => {
    const d = deps({ isHydrated: () => true, isEnabled: () => false })

    const result = await intercept.handleCreated(ITEM, d)

    expect(result.action).toBe('idle')
    expect(d.cleanup).not.toHaveBeenCalled()
    expect(d.handoff).not.toHaveBeenCalled()
  })

  it('skips a URL the app could never fetch', async () => {
    const d = deps()

    expect((await intercept.handleCreated({ id: 1, url: 'blob:https://x/1' }, d)).action).toBe('skipped')
    expect((await intercept.handleCreated({ id: 2, url: 'data:text/plain,hi' }, d)).action).toBe('skipped')
    expect((await intercept.handleCreated({ id: 3 }, d)).action).toBe('skipped')
    expect(d.handoff).not.toHaveBeenCalled()
  })

  it('ignores the download it re-created itself', async () => {
    // `restore` goes through the browser's own API, which fires this event
    // again; without the guard the two would cancel each other forever.
    const d = deps({ isIgnored: vi.fn(() => true) })

    expect((await intercept.handleCreated(ITEM, d)).action).toBe('ignored')
    expect(d.cleanup).not.toHaveBeenCalled()
  })

  it('cancels the browser copy and starts the handoff without waiting for the cancel to finish', async () => {
    // A cancel that never resolves on its own: if the handoff were sequenced
    // behind it, this test would time out instead of passing. Awaiting the
    // cancel first is what left a small file time to finish and survive next to
    // AriaDM's copy.
    let release: (() => void) | undefined
    const cleanup = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const handoff = vi.fn(async () => ({ ok: true }))

    const pending = intercept.handleCreated(ITEM, deps({ cleanup, handoff }))
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce())

    expect(cleanup).toHaveBeenCalledOnce()
    release?.()
    await expect(pending).resolves.toEqual({ ok: true, action: 'handed-off' })
  })

  it('keeps only the file name from the browser, not the absolute path', async () => {
    const d = deps()

    await intercept.handleCreated(ITEM, d)

    expect(d.payloadFor).toHaveBeenCalledWith(ITEM.url, undefined, false)
    expect(d.handoff).toHaveBeenCalledWith({ urls: [ITEM.url], filename: 'big.iso' })
  })

  it('retries a failed handoff once before giving up', async () => {
    const handoff = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'not-paired' })
      .mockResolvedValueOnce({ ok: true })
    const d = deps({ handoff })

    const result = await intercept.handleCreated(ITEM, d)

    expect(result.action).toBe('handed-off')
    expect(handoff).toHaveBeenCalledTimes(2)
    expect(d.restore).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('hands the download back to the browser instead of losing it', async () => {
    const handoff = vi.fn(async () => ({ ok: false, error: 'not-paired' }))
    const notify = vi.fn(async () => {})
    const d = deps({ handoff, notify })

    const result = await intercept.handleCreated(ITEM, d)

    expect(result).toEqual({ ok: false, action: 'restored', error: 'not-paired' })
    expect(handoff).toHaveBeenCalledTimes(2)
    expect(d.restore).toHaveBeenCalledOnce()
    // The user has to be told where the download went; it is no longer where
    // they were told AriaDM would put it.
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0]).toEqual(['not-paired', true])
  })

  it('says so when the download could not be restored either', async () => {
    const d = deps({
      handoff: vi.fn(async () => ({ ok: false, error: 'not-paired' })),
      restore: vi.fn(async () => false)
    })

    await intercept.handleCreated(ITEM, d)

    expect(d.notify).toHaveBeenCalledWith('not-paired', false)
  })

  it('names the reason even when the app gave none', async () => {
    const d = deps({ handoff: vi.fn(async () => ({ ok: false })) })

    await intercept.handleCreated(ITEM, d)

    expect(d.notify).toHaveBeenCalledWith('unknown error', true)
  })

  it('says nothing when the app took the download', async () => {
    const d = deps()

    await intercept.handleCreated(ITEM, d)

    expect(d.notify).not.toHaveBeenCalled()
    expect(d.restore).not.toHaveBeenCalled()
  })

  it('advertises the two URL shapes it can act on', () => {
    expect(intercept.usable({ url: 'https://example.com/a.zip' })).toBe(true)
    expect(intercept.usable({ url: 'blob:https://example.com/1' })).toBe(false)
    expect(intercept.usable({ url: 'data:application/octet-stream;base64,AA' })).toBe(false)
    expect(intercept.usable({})).toBe(false)
  })

  it('translates the strings it tells the user about a failed handoff', () => {
    for (const key of ['notify.interceptTitle', 'notify.interceptRestored', 'notify.interceptLost']) {
      expect(strings.t(key)).not.toBe(key)
    }
    expect(strings.t('notify.interceptRestored', { reason: 'not-paired' })).toContain('not-paired')
  })
})
