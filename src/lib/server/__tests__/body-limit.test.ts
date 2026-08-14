/**
 * Request bodies are bounded at the API wrapper.
 *
 * Next's App Router applies no body limit to route handlers, so before this the
 * only ceiling was Vercel's 4.5 MB platform cap — and nothing at all on the
 * worker, which runs the same handlers under Fastify.
 *
 * No database required: the check runs BEFORE requireAuthContext(), which is
 * both the cheaper order and what makes it testable in the plain unit pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { DEFAULT_MAX_BODY_BYTES, declaredBodyTooLarge, withAuthenticatedApi } from '../api-handler'

const requestDeclaring = (bytes: number | null) =>
  new NextRequest(new URL('http://test/api/thing'), {
    method: 'POST',
    ...(bytes === null ? {} : { headers: { 'content-length': String(bytes) } }),
  } as never)

test('a body over the budget is refused', () => {
  assert.equal(declaredBodyTooLarge(requestDeclaring(DEFAULT_MAX_BODY_BYTES + 1), DEFAULT_MAX_BODY_BYTES), true)
})

test('a body at or under the budget passes', () => {
  assert.equal(declaredBodyTooLarge(requestDeclaring(DEFAULT_MAX_BODY_BYTES), DEFAULT_MAX_BODY_BYTES), false)
  assert.equal(declaredBodyTooLarge(requestDeclaring(1024), DEFAULT_MAX_BODY_BYTES), false)
})

test('a missing Content-Length is not treated as oversized', () => {
  // Content-Length is the client's claim, not a measurement — a chunked
  // request omits it entirely. Refusing those would break legitimate streaming
  // clients to catch an attacker who can simply omit the header anyway.
  assert.equal(declaredBodyTooLarge(requestDeclaring(null), DEFAULT_MAX_BODY_BYTES), false)
})

test('the wrapper returns 413 before attempting authentication', async () => {
  // If auth ran first this would throw (no session, no database); reaching a
  // clean 413 is the proof that the size check precedes it.
  let handlerRan = false
  const handler = withAuthenticatedApi(async () => {
    handlerRan = true
    return { success: true }
  }, { requires: 'member' })

  const response = await handler(requestDeclaring(DEFAULT_MAX_BODY_BYTES + 1))
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'TOO_LARGE')
  assert.equal(handlerRan, false)
})

test('a route may raise its own budget', async () => {
  // Upload and import routes legitimately exceed the default. Raising it per
  // route keeps the large surfaces countable rather than making the default
  // generous enough to cover them.
  let handlerRan = false
  const handler = withAuthenticatedApi(async () => {
    handlerRan = true
    return { success: true }
  }, { requires: 'member', maxBodyBytes: 12 * 1024 * 1024 })

  const response = await handler(requestDeclaring(2 * 1024 * 1024))
  // Past the size gate, so it fails at auth instead — which is the point.
  assert.notEqual(response.status, 413)
  assert.equal(handlerRan, false)
})
