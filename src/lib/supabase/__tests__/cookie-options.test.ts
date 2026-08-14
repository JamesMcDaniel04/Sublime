/**
 * Session cookie flags are pinned, not inherited from @supabase/ssr's defaults.
 *
 * The defaults are correct in 0.6.1, but that is a property of the installed
 * version rather than of this application — a minor bump could change it with
 * nothing to notice. These assertions are the notice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SESSION_COOKIE_OPTIONS } from '../config'

test('the session cookie is path-scoped to the app and SameSite=Lax', () => {
  assert.equal(SESSION_COOKIE_OPTIONS.path, '/')
  // Lax, not Strict: Strict withholds the cookie on the top-level navigation
  // BACK from an OAuth provider, so the callback lands signed-out.
  assert.equal(SESSION_COOKIE_OPTIONS.sameSite, 'lax')
})

test('Secure follows the environment rather than being hardcoded either way', () => {
  // Hardcoding true silently breaks local development (browsers drop Secure
  // cookies on http://localhost); hardcoding false ships a token over plain
  // HTTP if TLS ever terminates wrong.
  assert.equal(SESSION_COOKIE_OPTIONS.secure, process.env.NODE_ENV === 'production')
})

test('both server clients pass the pinned options', () => {
  // A client constructed without cookieOptions silently reverts to the library
  // defaults, which is the drift these assertions exist to catch.
  for (const file of ['../server.ts', '../middleware.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /cookieOptions: SESSION_COOKIE_OPTIONS/, `${file} must pass the pinned cookie options`)
  }
})

test('httpOnly is deliberately absent and stays that way', () => {
  // NOT an oversight. @supabase/ssr shares ONE cookie between the server and
  // createBrowserClient, which reads it from document.cookie to hydrate the
  // client session. httpOnly makes it invisible to that read and signs every
  // user out client-side. If a future change makes the session server-only,
  // this assertion is the right place to find out that httpOnly became
  // available — and the CSP is what carries the exposure until then.
  assert.equal('httpOnly' in SESSION_COOKIE_OPTIONS, false)
})
