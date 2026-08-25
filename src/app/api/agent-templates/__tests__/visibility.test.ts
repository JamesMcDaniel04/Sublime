/**
 * Cross-org isolation for stored templates, driven through the real route.
 *
 * `AgentTemplate` is a PUBLIC cross-org library: GET /api/agent-templates
 * reads via systemPrisma with no organization filter, because the community
 * catalogue is meant to be shared. That default is right for hand-authored
 * catalogue entries and wrong for a template saved out of someone's own flow,
 * which carries their graph, prompts, step structure and connection names.
 *
 * These tests pin the boundary itself rather than the rule (the rule is
 * unit-tested in lib/templates/__tests__/visibility.test.ts). The
 * backward-compatibility case is as load-bearing as the privacy one: an
 * existing row with no `visibility` key must STAY visible cross-org, or
 * shipping this silently empties the community catalogue.
 *
 * Inside the TEST_DATABASE_URL gate, like the other .db tests.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const get = () => new NextRequest(new URL('http://test/api/agent-templates'), { method: 'GET' } as never)

  test('agent-templates cross-org visibility', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth, clearTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const { GET } = await import('../route')

    const owner = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    after(async () => {
      clearTestAuth()
      await owner.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const makeTemplate = (name: string, configuration: Record<string, unknown>) =>
      prisma.agentTemplate.create({
        data: {
          name, description: 'x', type: 'Custom',
          configuration: configuration as never,
          userId: owner.auth.dbUser.id,
          organizationId: owner.auth.organizationId,
        },
      })

    const namesVisibleTo = async (seeded: typeof owner): Promise<string[]> => {
      installTestAuth(seeded.auth)
      const body = await (await GET(get())).json()
      return (body.templates ?? []).map((entry: { name: string }) => entry.name)
    }

    const priv = await makeTemplate(`private-${Date.now()}`, { kind: 'flow', visibility: 'org' })
    const published = await makeTemplate(`published-${Date.now()}`, { kind: 'flow', visibility: 'community' })
    const legacy = await makeTemplate(`legacy-${Date.now()}`, { kind: 'agent' })

    await t.test('an org-visibility template is hidden from another workspace', async () => {
      assert.ok(!(await namesVisibleTo(other)).includes(priv.name))
    })

    await t.test('its own workspace still sees it', async () => {
      assert.ok((await namesVisibleTo(owner)).includes(priv.name))
    })

    await t.test('an explicitly published template is visible cross-org', async () => {
      assert.ok((await namesVisibleTo(other)).includes(published.name))
    })

    // The regression that would empty the community catalogue on deploy.
    await t.test('a pre-existing template with no visibility key stays cross-org visible', async () => {
      assert.ok((await namesVisibleTo(other)).includes(legacy.name))
    })
    // The read path that MATTERS more than the listing: provisioning
    // materializes a template into real rows. Listing another workspace's
    // private template is a disclosure; provisioning it copies their process
    // into your workspace. Both read via systemPrisma, so both need the rule.
    await t.test('another workspace cannot provision an org-private template', async () => {
      const { POST } = await import('../../templates/provision/route')
      installTestAuth(other.auth)
      const response = await POST(new NextRequest(new URL('http://test/api/templates/provision'), {
        method: 'POST',
        body: JSON.stringify({ templateId: priv.id, targetKind: 'agent' }),
        headers: { 'content-type': 'application/json' },
      } as never))
      const body = await response.json()
      assert.equal(body.success, false, 'an org-private template must not provision cross-org')
      assert.match(JSON.stringify(body), /not found/i)
    })

    await t.test('a published template still provisions cross-org', async () => {
      const { POST } = await import('../../templates/provision/route')
      installTestAuth(other.auth)
      const response = await POST(new NextRequest(new URL('http://test/api/templates/provision'), {
        method: 'POST',
        body: JSON.stringify({ templateId: published.id, targetKind: 'agent' }),
        headers: { 'content-type': 'application/json' },
      } as never))
      const body = await response.json()
      // It may still fail for unrelated reasons (missing integrations); what
      // must NOT happen is a not-found, which would mean visibility refused it.
      assert.doesNotMatch(JSON.stringify(body), /TEMPLATE_NOT_FOUND/)
    })
  })
} else {
  test('agent-templates cross-org visibility (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
