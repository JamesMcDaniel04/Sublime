import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOOGLE_SERVICE_SCOPES,
  buildAuthUrl,
  googleOAuthConfigured,
  signState,
  verifyState,
} from '../oauth'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.com/api/google/oauth/callback'
})

test('configured only when all three env vars are set', () => {
  assert.equal(googleOAuthConfigured(), true)
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
  assert.equal(googleOAuthConfigured(), false)
})

test('gmail scope set covers send and userinfo.email, and stays clear of restricted scopes', () => {
  const scopes: readonly string[] = GOOGLE_SERVICE_SCOPES['google-mail']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.send'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
  // Restricted Gmail scopes (readonly/modify/compose/full) trigger Google's
  // annual CASA security assessment — keep them out unless a feature needs them.
  assert.ok(!scopes.some((s) => /gmail\.(readonly|modify|compose|insert|metadata|settings)|mail\.google\.com/.test(s)))
})

test('sheets scope set covers spreadsheets and userinfo.email only', () => {
  const scopes: readonly string[] = GOOGLE_SERVICE_SCOPES['google-sheets']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/spreadsheets'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
  // Drive scopes on the Sheets service would silently widen the grant.
  assert.ok(!scopes.some((s) => s.includes('/auth/drive')))
})

test('drive scope set uses per-file drive.file and stays clear of restricted scopes', () => {
  const scopes: readonly string[] = GOOGLE_SERVICE_SCOPES['google-drive']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
  // Broad Drive scopes (drive, drive.readonly, drive.metadata…) are
  // "restricted" — they trigger Google's annual CASA assessment.
  assert.ok(!scopes.some((s) => /\/auth\/drive(\.readonly|\.metadata|\.appdata|\.scripts)?$/.test(s)))
})

test('calendar scope set covers event read/write plus the readonly ActivitySource scope', () => {
  const scopes: readonly string[] = GOOGLE_SERVICE_SCOPES['google-calendar']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.readonly'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'))
  // Full calendar scope (incl. calendar list mutation, ACLs) is broader than
  // any shipped feature needs.
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/calendar'))
})

test('analytics scope set is read-only plus userinfo.email', () => {
  const scopes: readonly string[] = GOOGLE_SERVICE_SCOPES['google-analytics']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/analytics.readonly'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
  // The write scopes (analytics.edit, plain analytics, user/manage scopes)
  // widen the grant beyond any shipped feature.
  assert.ok(!scopes.some((s) => /\/auth\/analytics(\.edit|\.manage\.users(\.readonly)?|\.provision)?$/.test(s)))
})

test('auth url strips stray whitespace from env values', () => {
  // A trailing newline pasted into the deployment env encodes as %0A in the
  // redirect_uri, which Google rejects with a secure-response-handling
  // policy error instead of a redirect_uri_mismatch.
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.com/api/google/oauth/callback\n'
  process.env.GOOGLE_OAUTH_CLIENT_ID = ' client-id.apps.googleusercontent.com\n'
  const url = new URL(buildAuthUrl({ service: 'google-mail', state: 'abc123' }))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/api/google/oauth/callback')
  assert.equal(url.searchParams.get('client_id'), 'client-id.apps.googleusercontent.com')
})

test('state round-trips and rejects tampering', () => {
  const state = signState({ organizationId: 'org-1', userId: 'user-1', service: 'google-mail' })
  const verified = verifyState(state)
  assert.deepEqual(
    { organizationId: verified?.organizationId, userId: verified?.userId, service: verified?.service },
    { organizationId: 'org-1', userId: 'user-1', service: 'google-mail' },
  )
  assert.equal(verifyState(state.slice(0, -2) + 'xx'), null)
  assert.equal(verifyState('garbage'), null)
})

test('auth url carries offline access, consent prompt, scopes, and state', () => {
  const url = new URL(buildAuthUrl({ service: 'google-mail', state: 'abc123' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-id.apps.googleusercontent.com')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/api/google/oauth/callback')
  assert.equal(url.searchParams.get('state'), 'abc123')
  assert.ok(url.searchParams.get('scope')?.includes('gmail.send'))
})
