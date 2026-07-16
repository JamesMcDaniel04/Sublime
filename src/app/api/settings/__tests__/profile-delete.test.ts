import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // Identity-provider cleanup must fail loudly in this env, never silently
  // pass — the behavior under test (cache invalidation) happens before it.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY

  let prisma: any
  const supabaseId = crypto.randomUUID()
  const supabaseUser = { id: supabaseId, email: 'doomed@example.com', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '' } as User

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
  })

  after(async () => {
    const { clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    clearTestAuth()
    await prisma.user.deleteMany({ where: { supabaseId } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { slug: `org-${supabaseId}` } }).catch(() => {})
  })

  test('account deletion drops the cached user row so the auth path cannot serve the dead workspace', async () => {
    // Resolve through the real auth path so the row lands in the dbUser cache.
    const { ensureWorkspaceMembership } = await import('@/lib/supabase/auth-utils')
    const member = await ensureWorkspaceMembership(supabaseUser)
    assert.ok(member?.organizationId)

    const { installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth({ organizationId: member.organizationId, userId: member.id, dbUser: member, user: supabaseUser })

    const { DELETE } = await import('@/app/api/settings/profile/route')
    const request = new NextRequest(new URL('http://test/api/settings/profile'), {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    })
    // Sole member → workspace teardown runs; the identity-provider cleanup
    // step then fails (no service key here), which must not matter for this.
    await DELETE(request)
    clearTestAuth()

    // The workspace is gone from the DB. A stale cache would still resolve
    // this identity to the dead row; an invalidated one re-provisions fresh.
    assert.equal(await prisma.user.count({ where: { supabaseId } }), 0)
    const resolved = await ensureWorkspaceMembership(supabaseUser)
    const org = await prisma.organization.findUnique({ where: { id: resolved?.organizationId } })
    assert.ok(org, 'auth path served a deleted workspace from the stale cache')
  })
} else {
  test('profile delete cache invalidation (skipped: TEST_DATABASE_URL not set)', () => {})
}
