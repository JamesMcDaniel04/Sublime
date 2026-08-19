import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEgressAllowed } from '../http'

test('assertEgressAllowed is a no-op when no allowlist is configured', () => {
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', { allowlistEnv: undefined }))
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', { allowlistEnv: '' }))
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', { allowlistEnv: ' , ,' }))
})

test('assertEgressAllowed permits listed domains and their subdomains only', () => {
  const allowlistEnv = 'api.stripe.com, hubspot.com'
  assert.doesNotThrow(() => assertEgressAllowed('https://api.stripe.com/v1/charges', { allowlistEnv }))
  assert.doesNotThrow(() => assertEgressAllowed('https://app.hubspot.com/deals', { allowlistEnv }))
  assert.doesNotThrow(() => assertEgressAllowed('https://HUBSPOT.com/', { allowlistEnv }))
  assert.throws(() => assertEgressAllowed('https://evil.example.com/collect', { allowlistEnv }), /not permitted/)
  // Suffix tricks must not pass: notstripe.com ≠ stripe.com subdomain.
  assert.throws(() => assertEgressAllowed('https://evilapi.stripe.com.attacker.net/', { allowlistEnv }), /not permitted/)
  assert.throws(() => assertEgressAllowed('https://fakehubspot.com/', { allowlistEnv }), /not permitted/)
})
