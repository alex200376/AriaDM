import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  cookieDomainFor,
  netscapeCookieFile,
  parseCookieHeader,
  removeCookieFile,
  writeCookieFile
} from '../../src/main/media/cookie-file'

/**
 * A live session has to reach yt-dlp's cookie *jar*, not its request headers.
 *
 * yt-dlp's extractors ask their jar whether the visitor is logged in
 * (`self._get_cookies(...)`), and a `Cookie:` header never fills it — so the
 * extension's session was silently ignored and X answered sensitive posts with a
 * TweetTombstone while Instagram served its login page. Turning the header into a
 * Netscape cookies file is what makes the session real.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'ariadm-cookie-test-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseCookieHeader', () => {
  it('reads name/value pairs out of a header', () => {
    expect(parseCookieHeader('auth_token=abc; ct0=def')).toEqual([
      { name: 'auth_token', value: 'abc' },
      { name: 'ct0', value: 'def' }
    ])
  })

  it('keeps the value whole when it contains an equals sign', () => {
    expect(parseCookieHeader('sessionid=abc==')).toEqual([{ name: 'sessionid', value: 'abc==' }])
  })

  it('drops a pair with no separator rather than guessing at it', () => {
    // A misread cookie is a different, wrong session sent to the site.
    expect(parseCookieHeader('garbage; good=1')).toEqual([{ name: 'good', value: '1' }])
  })

  it('strips the whitespace and newlines that would break the file format', () => {
    expect(parseCookieHeader(' a = 1 \r\n')).toEqual([{ name: 'a', value: '1' }])
  })

  it('handles an empty header', () => {
    expect(parseCookieHeader('')).toEqual([])
  })
})

describe('cookieDomainFor', () => {
  it('strips a site prefix so the API host shares the session', () => {
    expect(cookieDomainFor('www.x.com')).toBe('x.com')
    expect(cookieDomainFor('m.instagram.com')).toBe('instagram.com')
  })

  it('leaves a bare domain alone', () => {
    expect(cookieDomainFor('example.com')).toBe('example.com')
  })

  it('leaves an address alone', () => {
    expect(cookieDomainFor('127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('netscapeCookieFile', () => {
  it('writes one tab-separated line per cookie under a comment', () => {
    const content = netscapeCookieFile('https://x.com/a', 'auth_token=abc; ct0=def', 0)
    const lines = content.trimEnd().split('\n')

    expect(lines[0]).toBe('# Netscape HTTP Cookie File')
    expect(lines[1]!.startsWith('#')).toBe(true)
    expect(lines[2]!.split('\t')).toEqual([
      '.x.com',
      'TRUE',
      '/',
      'TRUE',
      String(365 * 24 * 60 * 60),
      'auth_token',
      'abc'
    ])
    expect(lines[3]!.split('\t')[5]).toBe('ct0')
  })

  it('marks a plain-http session insecure', () => {
    const line = netscapeCookieFile('http://example.com/', 'a=1', 0).trimEnd().split('\n')[2]!
    expect(line.split('\t')[3]).toBe('FALSE')
  })

  it('is empty when there is no session to write', () => {
    expect(netscapeCookieFile('https://x.com/', '', 0)).toBe('')
  })

  it('is empty when the URL cannot be parsed', () => {
    expect(netscapeCookieFile('not a url', 'a=1', 0)).toBe('')
  })
})

describe('writeCookieFile', () => {
  it('writes the session and returns a path that can be read back', async () => {
    const file = await writeCookieFile('https://x.com/a', 'auth_token=abc', dir)
    expect(file).not.toBe('')

    const content = readFileSync(file, 'utf8')
    expect(content).toContain('\tauth_token\tabc\n')

    await removeCookieFile(file)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('returns an empty path when there is nothing to write', async () => {
    expect(await writeCookieFile('https://x.com/a', '', dir)).toBe('')
  })

  it('removing a file that is already gone is not an error', async () => {
    await expect(removeCookieFile(path.join(dir, 'nope.txt'))).resolves.toBeUndefined()
    await expect(removeCookieFile('')).resolves.toBeUndefined()
  })
})
