import { describe, expect, it } from 'vitest'

import { CookieVault, hostOf } from '../../src/main/media/cookie-vault'

/**
 * The vault exists because a session cookie is a credential: it is held for a
 * short while, matched by host, and never written anywhere. Both halves of that
 * are worth pinning down — the matching, and the expiry.
 */
function makeVault(start = 0): { vault: CookieVault; tick: (ms: number) => void } {
  let now = start
  const vault = new CookieVault({ ttlMs: 1_000, needTtlMs: 500, now: () => now })
  return { vault, tick: (ms) => (now += ms) }
}

describe('hostOf', () => {
  it('reads the host, lowercased', () => {
    expect(hostOf('https://X.com/Noir_x/status/1')).toBe('x.com')
  })

  it('is empty for something that is not a URL', () => {
    expect(hostOf('not a url')).toBe('')
  })
})

describe('CookieVault', () => {
  it('remembers a session for one host only', () => {
    const { vault } = makeVault()
    expect(vault.remember('https://x.com/a', 'auth_token=abc')).toBe(true)

    expect(vault.forUrl('https://x.com/another')).toBe('auth_token=abc')
    // A session belongs to the site that issued it.
    expect(vault.forUrl('https://example.com/')).toBe('')
  })

  it('keeps only the newest session for a host', () => {
    const { vault } = makeVault()
    vault.remember('https://x.com/a', 'auth_token=old')
    vault.remember('https://x.com/b', 'auth_token=new')

    expect(vault.forUrl('https://x.com/a')).toBe('auth_token=new')
  })

  it('drops a session once its window has passed', () => {
    const { vault, tick } = makeVault()
    vault.remember('https://x.com/a', 'auth_token=abc')

    tick(1_001)
    expect(vault.forUrl('https://x.com/a')).toBe('')
  })

  it('refuses an empty session or an unreadable URL', () => {
    const { vault } = makeVault()
    expect(vault.remember('https://x.com/a', '   ')).toBe(false)
    expect(vault.remember('nonsense', 'auth_token=abc')).toBe(false)
    expect(vault.size).toBe(0)
  })

  it('advertises a host that needs a session, and stops once it has one', () => {
    const { vault, tick } = makeVault()
    vault.noteNeed('https://x.com/Noir_x/status/1')
    expect(vault.nextNeed()).toBe('https://x.com/')

    // The extension answered, so there is nothing left to ask for.
    vault.remember('https://x.com/anything', 'auth_token=abc')
    expect(vault.nextNeed()).toBe('')
  })

  it('does not keep asking for a host once a session arrived', () => {
    const { vault } = makeVault()
    vault.remember('https://x.com/a', 'auth_token=abc')
    vault.noteNeed('https://x.com/b')

    expect(vault.nextNeed()).toBe('')
  })

  it('gives up on a request nobody answered', () => {
    const { vault, tick } = makeVault()
    vault.noteNeed('https://x.com/a')

    tick(501)
    expect(vault.nextNeed()).toBe('')
  })

  it('answers the oldest request first', () => {
    const { vault, tick } = makeVault()
    vault.noteNeed('https://x.com/a')
    tick(10)
    vault.noteNeed('https://youtube.com/b')

    expect(vault.nextNeed()).toBe('https://x.com/')
  })

  it('forgets everything when switched off', () => {
    const { vault } = makeVault()
    vault.remember('https://x.com/a', 'auth_token=abc')
    vault.noteNeed('https://youtube.com/b')

    vault.clear()
    expect(vault.forUrl('https://x.com/a')).toBe('')
    expect(vault.nextNeed()).toBe('')
  })
})
