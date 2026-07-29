import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTestAuthContext, requireAuthContext } from '../auth'
import { makeTestAuthContext } from './test-auth'

test('setTestAuthContext override is ignored in production', async () => {
  const prev = process.env.NODE_ENV
  const prevDb = process.env.TEST_DATABASE_URL
  ;(process.env as Record<string, string>).NODE_ENV = 'production'
  process.env.TEST_DATABASE_URL = 'postgres://x'
  setTestAuthContext(makeTestAuthContext({ organizationId: 'o', userId: 'u', dbUser: { id: 'u' } as never, user: { id: 'u' } as never }))
  // In production the override must NOT short-circuit — requireAuthContext must
  // fall through to the real (here, unconfigured) Supabase path and reject.
  await assert.rejects(() => requireAuthContext())
  setTestAuthContext(null)
  ;(process.env as Record<string, string>).NODE_ENV = prev as string
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('setTestAuthContext override is honored under test gating', async () => {
  const prevDb = process.env.TEST_DATABASE_URL
  process.env.TEST_DATABASE_URL = 'postgres://x' // NODE_ENV is undefined under tsx --test in this repo; gate is NODE_ENV !== 'production'
  const ctx = makeTestAuthContext({ organizationId: 'o1', userId: 'u1', dbUser: { id: 'u1' } as never, user: { id: 'u1' } as never })
  setTestAuthContext(ctx)
  const resolved = await requireAuthContext()
  assert.equal(resolved.organizationId, 'o1')
  assert.equal(resolved.userId, 'u1')
  setTestAuthContext(null)
  if (prevDb === undefined) delete process.env.TEST_DATABASE_URL
  else process.env.TEST_DATABASE_URL = prevDb
})

test('with no override, requireAuthContext ignores the seam entirely', async () => {
  setTestAuthContext(null)
  await assert.rejects(() => requireAuthContext()) // no Supabase configured in unit env
})
