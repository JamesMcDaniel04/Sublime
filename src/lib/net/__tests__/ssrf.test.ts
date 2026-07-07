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
