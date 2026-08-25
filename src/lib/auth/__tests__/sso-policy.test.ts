/**
 * Workspace SSO policy.
 *
 * The SAML/OIDC protocol itself is Supabase's -- deliberately. XML signature
 * validation is where SSO implementations get broken (signature wrapping,
 * unsigned-assertion acceptance, XXE), and hand-rolling it against an identity
 * provider would be reckless when the auth provider already does it.
 *
 * What Sublime owns is everything Supabase cannot know: which workspace an
 * email domain belongs to, whether that workspace REQUIRES SSO, and what a
 * user provisioned on first SSO login is allowed to do.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ssoPolicyFor, organizationForEmail, ssoEnforcementFor, PUBLIC_EMAIL_DOMAINS } from '../sso-policy'

// ── reading the policy ──────────────────────────────────────────────────────

test('a workspace has no SSO policy by default', () => {
  const policy = ssoPolicyFor({})
  assert.equal(policy.enforced, false)
  assert.deepEqual(policy.domains, [])
})

test('a configured policy reports its domains and provider', () => {
  const policy = ssoPolicyFor({ sso: { enforced: true, domains: ['acme.com'], providerId: 'p1' } })
  assert.equal(policy.enforced, true)
  assert.deepEqual(policy.domains, ['acme.com'])
  assert.equal(policy.providerId, 'p1')
})

test('domains are normalised to lowercase', () => {
  assert.deepEqual(ssoPolicyFor({ sso: { domains: ['ACME.com', ' Acme.COM '] } }).domains, ['acme.com'])
})

// Enforcement without a provider would lock every member out of a workspace
// nobody can sign into. Fail OPEN here specifically, because failing closed
// means an unrecoverable workspace.
test('enforcement without a provider is not honoured', () => {
  assert.equal(ssoPolicyFor({ sso: { enforced: true, domains: ['acme.com'] } }).enforced, false)
})

test('a JIT-provisioned member defaults to the least privilege', () => {
  assert.equal(ssoPolicyFor({ sso: { domains: ['acme.com'], providerId: 'p1' } }).defaultRole, 'MEMBER')
})

// An admin who can self-assign ADMIN on first login makes domain capture a
// privilege escalation rather than an inconvenience.
test('a policy cannot provision members straight to ADMIN', () => {
  const policy = ssoPolicyFor({ sso: { domains: ['acme.com'], providerId: 'p1', defaultRole: 'ADMIN' } })
  assert.equal(policy.defaultRole, 'MEMBER')
})

// ── matching an email to a workspace ────────────────────────────────────────

const orgs = [
  { id: 'acme', settings: { sso: { enforced: true, domains: ['acme.com'], providerId: 'p1' } } },
  { id: 'globex', settings: { sso: { enforced: true, domains: ['globex.io'], providerId: 'p2' } } },
]

test('an email is matched to the workspace claiming its domain', () => {
  assert.equal(organizationForEmail('sam@acme.com', orgs)?.id, 'acme')
  assert.equal(organizationForEmail('sam@globex.io', orgs)?.id, 'globex')
})

test('an unclaimed domain matches nothing', () => {
  assert.equal(organizationForEmail('sam@nowhere.com', orgs), null)
})

test('matching is case-insensitive', () => {
  assert.equal(organizationForEmail('Sam@ACME.com', orgs)?.id, 'acme')
})

// The bug this exists to prevent: a suffix match would let anyone register
// evil-acme.com and be routed into Acme's workspace.
test('a domain that merely ends with a claimed domain does not match', () => {
  assert.equal(organizationForEmail('attacker@evil-acme.com', orgs), null)
  assert.equal(organizationForEmail('attacker@notacme.com', orgs), null)
})

// A subdomain is a different domain and must be claimed explicitly.
test('a subdomain of a claimed domain does not match', () => {
  assert.equal(organizationForEmail('sam@mail.acme.com', orgs), null)
})

test('a malformed address matches nothing', () => {
  assert.equal(organizationForEmail('not-an-email', orgs), null)
  assert.equal(organizationForEmail('', orgs), null)
  assert.equal(organizationForEmail('a@b@c.com', orgs), null)
})

// Without this, one workspace claims gmail.com and captures every Google user
// who ever signs in.
test('a public email domain can never be claimed', () => {
  const greedy = [{ id: 'greedy', settings: { sso: { enforced: true, domains: ['gmail.com'], providerId: 'p1' } } }]
  assert.equal(organizationForEmail('someone@gmail.com', greedy), null)
  assert.ok(PUBLIC_EMAIL_DOMAINS.has('gmail.com'))
})

test('a public domain is stripped from a policy rather than silently kept', () => {
  assert.deepEqual(ssoPolicyFor({ sso: { domains: ['acme.com', 'gmail.com'] } }).domains, ['acme.com'])
})

// ── enforcement ─────────────────────────────────────────────────────────────

test('password login is refused when the workspace enforces SSO', () => {
  const decision = ssoEnforcementFor('sam@acme.com', orgs, { method: 'password', role: 'MEMBER' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.organizationId, 'acme')
})

test('SSO login is allowed under enforcement', () => {
  assert.equal(ssoEnforcementFor('sam@acme.com', orgs, { method: 'sso', role: 'MEMBER' }).allowed, true)
})

test('password login is allowed where no workspace enforces SSO', () => {
  assert.equal(ssoEnforcementFor('sam@nowhere.com', orgs, { method: 'password', role: 'MEMBER' }).allowed, true)
})

// Break-glass. A misconfigured identity provider must not permanently lock an
// organisation out of its own workspace, so an existing ADMIN keeps the
// password path. This is a deliberate trade: it narrows enforcement in
// exchange for making enforcement recoverable, which is the same call Okta and
// Google Workspace make.
test('an existing admin keeps a password path so a broken IdP is recoverable', () => {
  const decision = ssoEnforcementFor('boss@acme.com', orgs, { method: 'password', role: 'ADMIN' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.breakGlass, true)
})

// The break-glass is for EXISTING admins only — otherwise anyone claiming to
// be an admin bypasses enforcement.
test('break-glass does not apply to someone who is not already a member', () => {
  assert.equal(ssoEnforcementFor('stranger@acme.com', orgs, { method: 'password', role: null }).allowed, false)
})

// ── reading the sign-in method from a token ─────────────────────────────────
//
// Password sign-in happens client-side against Supabase, so enforcement cannot
// live in the login form — a client check is bypassable by calling Supabase
// directly. It has to happen server-side on every request, which means reading
// how the session was obtained from the token's own `amr` claim.

test('a password session is identified from amr', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({ amr: [{ method: 'password' }] }), 'password')
})

test('a SAML session is identified from amr', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({ amr: [{ method: 'sso/saml' }] }), 'sso')
})

test('an OIDC session counts as SSO', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({ amr: [{ method: 'oidc' }] }), 'sso')
})

// MFA adds a second amr entry; the session is still an SSO session.
test('a stepped-up SSO session is still SSO', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({ amr: [{ method: 'sso/saml' }, { method: 'totp' }] }), 'sso')
})

// The indeterminate case. Claims are unavailable on the getUser fallback path,
// and locking a workspace out because a token could not be introspected would
// turn a transient auth hiccup into an outage. Same call the MFA gate makes.
test('an unreadable token yields no method rather than a lockout', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({}), null)
  assert.equal(authMethodFrom({ amr: [] }), null)
  assert.equal(authMethodFrom(null), null)
})

test('an unknown method is not silently treated as SSO', async () => {
  const { authMethodFrom } = await import('../sso-policy')
  assert.equal(authMethodFrom({ amr: [{ method: 'something-new' }] }), 'password')
})

// ── the request gate ────────────────────────────────────────────────────────
//
// The eight lines that used to sit inline in requireAuthContext, pulled out so
// the security decision is tested rather than being untested glue between two
// tested functions.

const enforcedOrg = { id: 'acme', settings: { sso: { enforced: true, domains: ['acme.com'], providerId: 'p1' } } }

test('a password session in an SSO workspace is refused', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  const result = ssoGateFor({ email: 'sam@acme.com', role: 'MEMBER', authMethod: 'password', organization: enforcedOrg })
  assert.equal(result.allowed, false)
})

test('an SSO session is admitted', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: 'sam@acme.com', role: 'MEMBER', authMethod: 'sso', organization: enforcedOrg }).allowed, true)
})

// The indeterminate case must never lock anyone out.
test('an unknown auth method is admitted rather than locked out', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: 'sam@acme.com', role: 'MEMBER', authMethod: null, organization: enforcedOrg }).allowed, true)
})

test('a user with no email on record is admitted', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: null, role: 'MEMBER', authMethod: 'password', organization: enforcedOrg }).allowed, true)
})

test('a user with no organization is admitted', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: 'sam@acme.com', role: 'MEMBER', authMethod: 'password', organization: null }).allowed, true)
})

test('an admin keeps the break-glass path through the gate', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: 'boss@acme.com', role: 'ADMIN', authMethod: 'password', organization: enforcedOrg }).allowed, true)
})

// A member of an SSO workspace whose own domain is not claimed is not covered
// by the policy — a contractor on a different domain keeps password login.
test('a member on an unclaimed domain is not caught by enforcement', async () => {
  const { ssoGateFor } = await import('../sso-policy')
  assert.equal(ssoGateFor({ email: 'contractor@other.com', role: 'MEMBER', authMethod: 'password', organization: enforcedOrg }).allowed, true)
})
