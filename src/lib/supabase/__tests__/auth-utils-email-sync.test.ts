import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import type { User } from '@supabase/supabase-js'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let ensureWorkspaceMembership: (user: User) => Promise<any>
  const supabaseId = crypto.randomUUID()

  const supabaseUser = (email: string | undefined): User =>
    ({ id: supabaseId, email, user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '' }) as User

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ensureWorkspaceMembership } = await import('@/lib/supabase/auth-utils'))
  })

  after(async () => {
    await prisma.organization.deleteMany({ where: { slug: `org-${supabaseId}` } }).catch(() => {})
  })

  test('a changed auth email syncs to the app user row on the next request', async () => {
    const member = await ensureWorkspaceMembership(supabaseUser('old@example.com'))
    assert.equal(member.email, 'old@example.com')

    // Same identity comes back with a new (confirmed) address in its token.
    const resynced = await ensureWorkspaceMembership(supabaseUser('New@Example.com'))
    assert.equal(resynced.email, 'new@example.com')

    const row = await prisma.user.findFirst({ where: { supabaseId } })
    assert.equal(row.email, 'new@example.com')
  })

  test('a token without an email claim never clobbers the stored address', async () => {
    const resynced = await ensureWorkspaceMembership(supabaseUser(undefined))
    assert.equal(resynced.email, 'new@example.com')

    const row = await prisma.user.findFirst({ where: { supabaseId } })
    assert.equal(row.email, 'new@example.com')
  })
} else {
  test('auth-utils email sync (skipped: TEST_DATABASE_URL not set)', () => {})
}
