import { describe, expect, it } from 'vitest'

import { hasRoutableIpv6, resolveDisableIpv6, type NetworkInterfaces } from '../../src/main/aria2/ipv6'

/**
 * The bug this guards against: aria2 picks an AAAA address and fails with
 * `WSAENETUNREACH` on machines that own an IPv6 address but no IPv6 route.
 * Tailscale's `fd7a::/48` unique-local address is the canonical false positive.
 */

function ifaces(entries: Array<{ address: string; family?: 'IPv4' | 'IPv6' }>): NetworkInterfaces {
  return {
    eth0: entries.map((entry) => ({
      address: entry.address,
      family: entry.family ?? (entry.address.includes(':') ? 'IPv6' : 'IPv4'),
      internal: false
    }))
  }
}

describe('hasRoutableIpv6', () => {
  it('is false for an IPv4-only machine', () => {
    expect(hasRoutableIpv6(ifaces([{ address: '192.168.1.10' }]))).toBe(false)
  })

  it('is false when the only IPv6 addresses are link-local and loopback', () => {
    const interfaces = {
      lo: [{ address: '::1', family: 'IPv6', internal: true }],
      eth0: [{ address: 'fe80::1%eth0', family: 'IPv6', internal: false }]
    }
    expect(hasRoutableIpv6(interfaces)).toBe(false)
  })

  it('ignores a Tailscale unique-local address', () => {
    expect(hasRoutableIpv6(ifaces([{ address: 'fd7a:115c:a1e0::7a37:c964' }]))).toBe(false)
  })

  it('ignores IPv4-mapped addresses', () => {
    expect(hasRoutableIpv6(ifaces([{ address: '::ffff:203.0.113.1' }]))).toBe(false)
  })

  it('is true for a globally routable address', () => {
    expect(hasRoutableIpv6(ifaces([{ address: '2606:4700:3108::ac42:2914' }]))).toBe(true)
  })

  it('accepts the numeric family value from older Node versions', () => {
    const interfaces = {
      eth0: [{ address: '2606:4700:3108::ac42:2914', family: 6, internal: false }]
    }
    expect(hasRoutableIpv6(interfaces)).toBe(true)
  })
})

describe('resolveDisableIpv6', () => {
  const noIpv6 = ifaces([{ address: '192.168.1.10' }])
  const dualStack = ifaces([
    { address: '192.168.1.10' },
    { address: '2606:4700:3108::ac42:2914' }
  ])

  it('disables IPv6 under auto only when no route exists', () => {
    expect(resolveDisableIpv6('auto', noIpv6)).toBe(true)
    expect(resolveDisableIpv6('auto', dualStack)).toBe(false)
  })

  it('honours the explicit on and off modes regardless of the interfaces', () => {
    expect(resolveDisableIpv6('on', dualStack)).toBe(true)
    expect(resolveDisableIpv6('off', noIpv6)).toBe(false)
  })
})
