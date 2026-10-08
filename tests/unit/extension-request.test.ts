import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

/**
 * The extension's loopback request policy.
 *
 * It is a plain script that assigns to `AriaDmRequest`, so it is loaded the way
 * the extension loads it — as a script, with its own global — and handed fake
 * dependencies. That is the whole reason it lives in its own file: this is the
 * behaviour that decides whether a click on "傳送" dies with a raw "Failed to
 * fetch", and a service worker is not a place you can test it from.
 */

interface Strings {
  t(key: string, substitutions?: Record<string, unknown>): string
}

interface Policy {
  describeError(error: unknown): string
  requestWithRepair(
    deps: Record<string, unknown>,
    config: Record<string, unknown>,
    path: string,
    init?: Record<string, unknown>
  ): Promise<{ status: number }>
}

/**
 * The shared string table, loaded the way the browser loads it.
 *
 * `describeError` reads its sentences from it, so the test supplies what the
 * browser supplies and asserts against the table rather than one language.
 */
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

function loadPolicy(): Policy {
  const source = readFileSync(
    new URL('../../resources/extension/src/request.js', import.meta.url),
    'utf8'
  )
  const target: { AriaDmRequest?: Policy; AriaDmStrings?: Strings } = { AriaDmStrings: strings }
  // `self` is supplied, so the script does not boot into the test's global.
  new Function('self', source)(target)
  if (!target.AriaDmRequest) throw new Error('request.js did not define AriaDmRequest')
  return target.AriaDmRequest
}

const policy = loadPolicy()

function deps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoint: (config: { port: number }, path: string) => `http://127.0.0.1:${config.port}${path}`,
    getConfig: vi.fn(async () => ({ port: 7071, token: 'new' })),
    pair: vi.fn(async () => ({ ok: true })),
    fetch: vi.fn(),
    ...overrides
  }
}

/** The URL and headers of one recorded fetch call. */
function call(fetch: ReturnType<typeof vi.fn>, index: number): { url: string; token: string } {
  const [url, init] = fetch.mock.calls[index] as [string, { headers: Record<string, string> }]
  return { url, token: init.headers['x-ariadm-token'] ?? '' }
}

describe('extension request policy', () => {
  it('turns a transport failure into something a person can act on', () => {
    const advice = strings.t('error.connect')
    expect(policy.describeError(new TypeError('Failed to fetch'))).toBe(advice)
    expect(policy.describeError(new Error('Load failed'))).toBe(advice)
    expect(policy.describeError(new Error('NetworkError when attempting to fetch resource.'))).toBe(advice)
    // The raw DOM sentence is what this replaced, so it must not survive.
    expect(advice).not.toMatch(/failed to fetch/i)
  })

  it('keeps an unrecognised message rather than inventing one', () => {
    expect(policy.describeError(new Error('HTTP 404'))).toBe('HTTP 404')
    expect(policy.describeError(undefined)).toBe(strings.t('error.unknown'))
  })

  it('passes a healthy request straight through, with the stored token', async () => {
    const fetch = vi.fn(async () => ({ status: 200 }))
    const pair = vi.fn()

    const response = await policy.requestWithRepair(
      deps({ fetch, pair }),
      { port: 6801, token: 'stored' },
      '/ping'
    )

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    expect(call(fetch, 0)).toEqual({ url: 'http://127.0.0.1:6801/ping', token: 'stored' })
    expect(pair).not.toHaveBeenCalled()
  })

  it('re-pairs and retries once when the stored port stops answering', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ status: 200 })
    const config: Record<string, unknown> = { port: 6801, token: 'stale' }

    const response = await policy.requestWithRepair(deps({ fetch }), config, '/cookies', {
      method: 'POST'
    })

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    // The retry goes to the endpoint the app just advertised, with its token.
    expect(call(fetch, 1)).toEqual({ url: 'http://127.0.0.1:7071/cookies', token: 'new' })
    expect(config).toEqual({ port: 7071, token: 'new' })
  })

  it('re-pairs on a rotated token as well', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200 })
    const config: Record<string, unknown> = { port: 6801, token: 'old' }

    const response = await policy.requestWithRepair(deps({ fetch }), config, '/add', {
      method: 'POST'
    })

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(call(fetch, 1).token).toBe('new')
  })

  it('gives up after one repair, so a closed app reports promptly', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const pair = vi.fn(async () => ({ ok: false }))

    await expect(
      policy.requestWithRepair(deps({ fetch, pair }), { port: 6801, token: 'x' }, '/ping')
    ).rejects.toThrow(/Failed to fetch/)

    // One attempt and one sweep of the discovery ports — never an endless loop.
    expect(fetch).toHaveBeenCalledOnce()
    expect(pair).toHaveBeenCalledOnce()
  })
})
