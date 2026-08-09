/**
 * Credential resolution against a real Postgres. The assertions that matter are
 * the denials: cross-org, personal-to-another-user, inactive, and
 * domain-blocked must all refuse rather than inject.
 */
import type { Prisma } from '@/generated/prisma/client'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'unit-test-key'

  let prisma: typeof import('@/lib/prisma').prisma
  let resolveCredential: typeof import('../resolve').resolveCredential
  let CREDENTIAL_UNAVAILABLE: string
  let CREDENTIAL_DOMAIN_BLOCKED: string
  let buildCredentialConfig: typeof import('../config').buildCredentialConfig
  let seeded: { organizationId: string; userId: string; cleanup: () => Promise<void> }
  let other: { organizationId: string; userId: string; cleanup: () => Promise<void> }

  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolveCredential, CREDENTIAL_UNAVAILABLE, CREDENTIAL_DOMAIN_BLOCKED } = await import('../resolve'))
    ;({ buildCredentialConfig } = await import('../config'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    other = await seedTestOrg(prisma)

    const make = async (name: string, extra: Record<string, unknown> = {}) => {
      const row = await prisma.credential.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          name,
          type: 'bearer',
          authConfig: buildCredentialConfig({ type: 'bearer', token: `tok-${name}` }) as Prisma.InputJsonValue,
          allowedDomains: ['example.com'],
          ...extra,
        },
        select: { id: true },
      })
      ids[name] = row.id
    }
    await make('mine', { userId: seeded.userId })
    await make('theirs', { userId: other.userId })
    await make('inactive', { isActive: false })
    await make('scoped', { allowedDomains: ['acme.com'] })
    await make('legacy-shared', { userId: null })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
    if (other) await other.cleanup()
  })

  const resolve = (name: string, url = 'https://api.example.com/x', userId = seeded.userId) =>
    resolveCredential({ credentialId: ids[name], organizationId: seeded.organizationId, userId, requestUrl: url })

  test('refuses a legacy org-shared credential', async () => {
    await assert.rejects(() => resolve('legacy-shared'), new RegExp(CREDENTIAL_UNAVAILABLE))
  })

  test("resolves the acting user's own personal credential", async () => {
    const plan = await resolve('mine', 'https://api.example.com/x', seeded.userId)
    assert.equal(plan.headers?.authorization, 'Bearer tok-mine')
  })

  test("refuses another user's personal credential", async () => {
    await assert.rejects(() => resolve('theirs', 'https://api.example.com/x', seeded.userId), new RegExp(CREDENTIAL_UNAVAILABLE))
  })

  test('refuses an inactive credential', async () => {
    await assert.rejects(() => resolve('inactive'), new RegExp(CREDENTIAL_UNAVAILABLE))
  })

  test('refuses a credential from another org', async () => {
    await assert.rejects(
      () => resolveCredential({ credentialId: ids.mine, organizationId: other.organizationId, userId: other.userId, requestUrl: 'https://api.example.com/x' }),
      new RegExp(CREDENTIAL_UNAVAILABLE),
    )
  })

  test('enforces the domain allow-list', async () => {
    const allowed = await resolve('scoped', 'https://api.acme.com/x')
    assert.equal(allowed.headers?.authorization, 'Bearer tok-scoped')
    await assert.rejects(() => resolve('scoped', 'https://evil.example.com/x'), new RegExp(CREDENTIAL_DOMAIN_BLOCKED))
  })

  test('a missing credential id refuses rather than injecting nothing silently', async () => {
    await assert.rejects(
      () => resolveCredential({ credentialId: 'nope', organizationId: seeded.organizationId, userId: seeded.userId, requestUrl: 'https://api/x' }),
      new RegExp(CREDENTIAL_UNAVAILABLE),
    )
  })

  test('stamps lastUsedAt without blocking the request', async () => {
    await resolve('mine')
    // Best-effort and fire-and-forget, so poll briefly rather than assume.
    let stamped: Date | null = null
    for (let i = 0; i < 20 && !stamped; i++) {
      await new Promise((r) => setTimeout(r, 25))
      const row = await prisma.credential.findFirst({
        where: { id: ids.mine, organizationId: seeded.organizationId },
        select: { lastUsedAt: true },
      })
      stamped = row?.lastUsedAt ?? null
    }
    assert.ok(stamped, 'lastUsedAt was never stamped')
  })
}
