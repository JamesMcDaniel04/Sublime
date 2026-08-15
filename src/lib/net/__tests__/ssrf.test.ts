import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicUrl, SsrfError } from '../ssrf'

// IP-literal cases only (no DNS/network). Hostname resolution is covered by the
// runtime guards; here we lock the IP classification + the IPv4-mapped IPv6
// bypass that the audit caught.
const blocked = (url: string) =>
  assert.rejects(assertPublicUrl(url), (e) => e instanceof SsrfError, `expected block: ${url}`)
const allowed = (url: string) =>
  assert.doesNotReject(assertPublicUrl(url), `expected allow: ${url}`)

test('rejects non-https', async () => {
  await blocked('http://8.8.8.8/')
})

test('blocks loopback / private / metadata IPv4 literals', async () => {
  await blocked('https://127.0.0.1/')
  await blocked('https://10.0.0.5/')
  await blocked('https://172.16.0.1/')
  await blocked('https://192.168.1.1/')
  await blocked('https://169.254.169.254/') // cloud metadata
  await blocked('https://100.64.0.1/')      // CGNAT
})

test('blocks IPv4-mapped IPv6 (dotted AND hex-canonical form)', async () => {
  await blocked('https://[::1]/')
  await blocked('https://[::ffff:127.0.0.1]/')       // canonicalizes to ::ffff:7f00:1
  await blocked('https://[::ffff:169.254.169.254]/') // canonicalizes to ::ffff:a9fe:a9fe
})

test('allows a public IP literal', async () => {
  await allowed('https://8.8.8.8/')
})

test('blocks exotic IPv6 ranges that reach IPv4 internals via translation', async () => {
  // NAT64 (64:ff9b::/96) embeds an IPv4 the host may translate; 6to4 (2002::/16)
  // and Teredo (2001::/32) tunnel to arbitrary v4; ff00::/8 is v6 multicast.
  // The classifier was silently permissive (return false) for all of these.
  await blocked('https://[64:ff9b::7f00:1]/')          // NAT64 → 127.0.0.1
  await blocked('https://[64:ff9b::a9fe:a9fe]/')       // NAT64 → 169.254.169.254 (metadata)
  await blocked('https://[2002:7f00:1::]/')            // 6to4 → 127.0.0.1
  await blocked('https://[2001:0:0:0:0:0:7f00:1]/')    // Teredo prefix
  await blocked('https://[ff02::1]/')                  // IPv6 multicast
})

test('still allows a normal public IPv6 literal', async () => {
  await allowed('https://[2606:4700:4700::1111]/') // Cloudflare DNS, global unicast
})
