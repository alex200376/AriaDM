import { describe, expect, it } from 'vitest'

import {
  checkForUpdate,
  compareVersions,
  parseRelease,
  type UpdateFetch,
  type UpdateResponse
} from '../../src/main/update/update-checker'

function response(status: number, body: unknown): UpdateResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

describe('compareVersions', () => {
  it('orders numeric segments, not strings', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
  })

  it('ignores a leading v and any pre-release or build suffix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.4-rc1+build7', '1.2.3')).toBe(1)
  })
})

describe('parseRelease', () => {
  it('offers the release when its tag is newer than the running build', () => {
    const info = parseRelease(
      {
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/alex200376/AriaDM/releases/tag/v0.2.0',
        assets: [{ name: 'AriaDM-0.2.0-setup.exe', browser_download_url: 'https://example.test/setup.exe' }]
      },
      '0.1.0'
    )

    expect(info.available).toBe(true)
    expect(info.latest).toBe('0.2.0')
    expect(info.downloadUrl).toBe('https://example.test/setup.exe')
    expect(info.error).toBe('')
  })

  it('does not offer an equal or older release', () => {
    expect(parseRelease({ tag_name: 'v0.1.0' }, '0.1.0').available).toBe(false)
    expect(parseRelease({ tag_name: 'v0.0.9' }, '0.1.0').available).toBe(false)
  })

  it('prefers the NSIS installer, falling back to the portable build', () => {
    const both = parseRelease(
      {
        tag_name: 'v0.2.0',
        assets: [
          { name: 'AriaDM-0.2.0-portable.exe', browser_download_url: 'https://example.test/portable.exe' },
          { name: 'AriaDM-0.2.0-setup.exe', browser_download_url: 'https://example.test/setup.exe' }
        ]
      },
      '0.1.0'
    )
    expect(both.downloadUrl).toBe('https://example.test/setup.exe')

    const portableOnly = parseRelease(
      { tag_name: 'v0.2.0', assets: [{ name: 'AriaDM-0.2.0-portable.exe', browser_download_url: 'u' }] },
      '0.1.0'
    )
    expect(portableOnly.downloadUrl).toBe('u')
  })

  it('ignores drafts and pre-releases', () => {
    expect(parseRelease({ tag_name: 'v9.0.0', draft: true }, '0.1.0').available).toBe(false)
    expect(parseRelease({ tag_name: 'v9.0.0', prerelease: true }, '0.1.0').available).toBe(false)
  })
})

describe('checkForUpdate', () => {
  it('treats a 404 as "no release yet" rather than an error', async () => {
    const fetchImpl: UpdateFetch = async () => response(404, {})
    const info = await checkForUpdate('0.1.0', fetchImpl)

    expect(info.latest).toBeNull()
    expect(info.available).toBe(false)
    expect(info.error).toBe('')
  })

  it('reports a network failure in error without throwing', async () => {
    const fetchImpl: UpdateFetch = async () => {
      throw new Error('offline')
    }
    const info = await checkForUpdate('0.1.0', fetchImpl)

    expect(info.available).toBe(false)
    expect(info.error).toBe('offline')
  })

  it('reports a non-404 HTTP failure', async () => {
    const fetchImpl: UpdateFetch = async () => response(500, {})
    const info = await checkForUpdate('0.1.0', fetchImpl)

    expect(info.error).toBe('HTTP 500')
  })

  it('parses a successful response', async () => {
    const fetchImpl: UpdateFetch = async () => response(200, { tag_name: 'v0.3.0', html_url: 'u' })
    const info = await checkForUpdate('0.1.0', fetchImpl)

    expect(info.available).toBe(true)
    expect(info.latest).toBe('0.3.0')
    expect(info.releaseUrl).toBe('u')
  })
})
