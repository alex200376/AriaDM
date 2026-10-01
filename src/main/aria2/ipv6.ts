import type { Ipv6Mode } from '@shared/settings'

/**
 * Deciding whether aria2 should be told to ignore IPv6.
 *
 * aria2 resolves both A and AAAA records and will happily pick an IPv6 address on
 * a machine that has no IPv6 route. The connection then fails immediately with
 * `WSAENETUNREACH` ("a socket operation was attempted to an unreachable network")
 * even though the same host answers on IPv4 — which reaches the user as "this
 * download will not start" with no hint that IPv6 is involved.
 *
 * The trap is that "has an IPv6 address" is not the same as "has IPv6". A VPN
 * adapter's unique-local address (Tailscale's `fd7a:115c:a1e0::/48` is the usual
 * culprit) is a perfectly valid IPv6 address that routes nothing, and link-local
 * addresses are always present. So the check is deliberately narrow: only a
 * globally routable address counts.
 */

/** The smallest shape we need from `os.networkInterfaces()`. */
export interface NetworkInterfaceEntry {
  family: string | number
  address: string
  internal?: boolean
}

export type NetworkInterfaces = Record<string, NetworkInterfaceEntry[] | undefined>

function isIpv6(family: string | number): boolean {
  // Node reports 'IPv6' since v18; older builds used the numeric 6.
  return family === 'IPv6' || family === 6
}

/** True for an address that could actually reach the public internet. */
function isGloballyRoutable(address: string): boolean {
  // Interface-scoped addresses arrive as `fe80::1%eth0`.
  const value = address.toLowerCase().split('%')[0] ?? ''
  if (value.length === 0) return false

  // Loopback.
  if (value === '::1' || value === '::') return false

  // Link-local, fe80::/10. Always present, never routes off-machine.
  if (/^fe[89ab]/.test(value)) return false

  // Unique-local, fc00::/7. VPN overlays and private ranges live here.
  if (/^f[cd]/.test(value)) return false

  // IPv4-mapped (::ffff:203.0.113.1) is an IPv4 route wearing an IPv6 costume.
  if (value.startsWith('::ffff:')) return false

  return true
}

/** True when at least one interface holds a globally routable IPv6 address. */
export function hasRoutableIpv6(interfaces: NetworkInterfaces): boolean {
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.internal) continue
      if (!isIpv6(entry.family)) continue
      if (isGloballyRoutable(entry.address)) return true
    }
  }
  return false
}

/**
 * Turn the setting plus the machine's interfaces into the `--disable-ipv6` flag.
 *
 * `'auto'` is the default and only disables IPv6 when there is provably no route
 * for it, so a dual-stack machine keeps full IPv6 support. `'on'` exists for the
 * remaining case that detection cannot see: an address that looks routable but
 * does not actually work.
 */
export function resolveDisableIpv6(mode: Ipv6Mode, interfaces: NetworkInterfaces): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return !hasRoutableIpv6(interfaces)
}
