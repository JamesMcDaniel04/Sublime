import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEgressAllowed } from '../http'

test('assertEgressAllowed is a no-op when no allowlist is configured', () => {
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', undefined))
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', ''))
  assert.doesNotThrow(() => assertEgressAllowed('https://anywhere.example.com/x', ' , ,'))
})

test('assertEgressAllowed permits listed domains and their subdomains only', () => {
  const allow = 'api.stripe.com, hubspot.com'
  assert.doesNotThrow(() => assertEgressAllowed('https://api.stripe.com/v1/charges', allow))
  assert.doesNotThrow(() => assertEgressAllowed('https://app.hubspot.com/deals', allow))
  assert.doesNotThrow(() => assertEgressAllowed('https://HUBSPOT.com/', allow))
  assert.throws(() => assertEgressAllowed('https://evil.example.com/collect', allow), /not permitted/)
  // Suffix tricks must not pass: notstripe.com ≠ stripe.com subdomain.
  assert.throws(() => assertEgressAllowed('https://evilapi.stripe.com.attacker.net/', allow), /not permitted/)
  assert.throws(() => assertEgressAllowed('https://fakehubspot.com/', allow), /not permitted/)
})
