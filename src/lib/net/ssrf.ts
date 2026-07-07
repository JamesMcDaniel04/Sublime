/**
 * SSRF guard for user-provided outbound URLs (custom MCP server/token URLs).
 *
 * Requires https and resolves the host, rejecting any URL that points at a
 * loopback/private/link-local/reserved address — including the cloud metadata
 * endpoint (169.254.169.254). Applied both when a URL is saved and again before
 * each fetch, so a host that later resolves to a private IP is still blocked.
 *
 * Note: this re-resolves at fetch time (narrowing, not fully closing, the DNS
 * rebinding window). Pinning the validated IP into the connection would close it
 * entirely — a follow-up if the threat model warrants it.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    n = n * 256 + octet
  }
  return n >>> 0
}

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToLong(ip)
  if (n === null) return true
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToLong(base)
    if (b === null) return false
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (b & mask)
  }
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // RFC1918 private
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||    // RFC1918 private
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.168.0.0', 16) ||   // RFC1918 private
    inRange('198.18.0.0', 15) ||    // benchmarking
    n >= (ipv4ToLong('224.0.0.0') as number) // multicast + reserved
  )
}

// Extract the embedded IPv4 from an IPv4-mapped/compatible IPv6, in EITHER the
// dotted form (::ffff:1.2.3.4) or the hex form the WHATWG URL parser produces
// (::ffff:7f00:1). Without the hex case, mapped literals for loopback/metadata
// slip past the guard.
function mappedIPv4(a: string): string | null {
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const hex = a.match(/^::(?:ffff:)?(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

function isBlockedIPv6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '::') return true
  if (/^fe[89ab]/.test(a)) return true // link-local fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true // unique-local fc00::/7
  const mapped = mappedIPv4(a)
  if (mapped) return isBlockedIPv4(mapped)
  return false
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return true // not a parseable IP → block
}

/**
 * Throws SsrfError unless `raw` is an https URL whose host resolves ONLY to
 * public addresses. Safe to call on every request and on save.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('Invalid URL')
  }
  if (url.protocol !== 'https:') throw new SsrfError('Only https URLs are allowed')

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError('URL host is a private or reserved address')
    return
  }

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new SsrfError('Could not resolve URL host')
  }
  if (addresses.length === 0) throw new SsrfError('URL host did not resolve')
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new SsrfError('URL resolves to a private or reserved address')
  }
}
