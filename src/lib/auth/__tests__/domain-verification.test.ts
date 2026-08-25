/**
 * Proving a workspace controls a domain before it may claim it.
 *
 * Without this the SSO policy is a vulnerability rather than a feature: any
 * workspace could claim `competitor.com`, and every one of that competitor's
 * users would be routed into the attacker's workspace on their next sign-in.
 *
 * The proof is a DNS TXT record, which is the standard mechanism precisely
 * because publishing one requires control of the domain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  domainVerificationToken,
  verifyDomainRecords,
  DOMAIN_TXT_PREFIX,
} from '../domain-verification'

// ── the token ───────────────────────────────────────────────────────────────

test('a verification token is stable for a workspace and domain', () => {
  const a = domainVerificationToken('org-1', 'acme.com', 'pepper')
  assert.equal(a, domainVerificationToken('org-1', 'acme.com', 'pepper'))
})

// If one token verified every domain, publishing it once would let a
// workspace claim every domain it could find the record on.
test('a different domain yields a different token', () => {
  assert.notEqual(
    domainVerificationToken('org-1', 'acme.com', 'pepper'),
    domainVerificationToken('org-1', 'globex.io', 'pepper'),
  )
})

// The property that stops one workspace verifying with another's published
// record: Acme publishes its token, and a hostile workspace cannot reuse it.
test('a different workspace yields a different token for the same domain', () => {
  assert.notEqual(
    domainVerificationToken('org-1', 'acme.com', 'pepper'),
    domainVerificationToken('org-2', 'acme.com', 'pepper'),
  )
})

// Derived from a server-side secret, so a token cannot be computed by whoever
// wants to claim the domain.
test('a token cannot be derived without the server secret', () => {
  assert.notEqual(
    domainVerificationToken('org-1', 'acme.com', 'pepper'),
    domainVerificationToken('org-1', 'acme.com', 'different-pepper'),
  )
})

test('a token is prefixed so it is identifiable in a zone file', () => {
  assert.match(domainVerificationToken('org-1', 'acme.com', 'pepper'), new RegExp(`^${DOMAIN_TXT_PREFIX}`))
})

// ── checking the records ────────────────────────────────────────────────────

test('a domain publishing the expected token verifies', () => {
  const token = domainVerificationToken('org-1', 'acme.com', 'pepper')
  assert.equal(verifyDomainRecords([['unrelated=1'], [token]], token), true)
})

test('a domain publishing nothing does not verify', () => {
  assert.equal(verifyDomainRecords([], domainVerificationToken('org-1', 'acme.com', 'pepper')), false)
})

test('a domain publishing another workspace\'s token does not verify', () => {
  const ours = domainVerificationToken('org-1', 'acme.com', 'pepper')
  const theirs = domainVerificationToken('org-2', 'acme.com', 'pepper')
  assert.equal(verifyDomainRecords([[theirs]], ours), false)
})

// DNS resolvers hand back TXT records split into chunks; a token that spans a
// chunk boundary must still verify or long tokens would randomly fail.
test('a token split across TXT chunks verifies', () => {
  const token = domainVerificationToken('org-1', 'acme.com', 'pepper')
  const half = Math.floor(token.length / 2)
  assert.equal(verifyDomainRecords([[token.slice(0, half), token.slice(half)]], token), true)
})

// A record that merely CONTAINS the token is not the token — otherwise
// publishing `sublime-verify=<ours>-not-really` would pass.
test('a record containing the token as a substring does not verify', () => {
  const token = domainVerificationToken('org-1', 'acme.com', 'pepper')
  assert.equal(verifyDomainRecords([[`prefix-${token}-suffix`]], token), false)
})

test('surrounding whitespace in a published record is tolerated', () => {
  const token = domainVerificationToken('org-1', 'acme.com', 'pepper')
  assert.equal(verifyDomainRecords([[`  ${token}  `]], token), true)
})
