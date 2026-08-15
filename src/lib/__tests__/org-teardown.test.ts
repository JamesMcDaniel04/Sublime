import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  // Prove the no-external-env path: teardown must clean up the DB rows
  // without attempting any external calls when Nango/Neo4j are
  // unconfigured.
  delete process.env.NANGO_SECRET_KEY
  delete process.env.NEO4J_URI
  delete process.env.NEO4J_USERNAME
  delete process.env.NEO4J_PASSWORD

  let prisma: any
  let systemPrisma: any
  let teardownOrganization: (
    organizationId: string,
    options?: { actorUserId?: string | null },
  ) => Promise<{ nango: number; google: number; slack: number; graphCleared: boolean }>
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    ;({ teardownOrganization } = await import('@/lib/org-teardown'))

    const org = await prisma.organization.create({ data: { name: 'Teardown Org', slug: `teardown-${Date.now()}` } })
    ids.org = org.id

    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id

    const nangoConnection = await prisma.nangoConnection.create({
      data: {
        organizationId: org.id,
        connectionId: `conn-${Date.now()}`,
        providerConfigKey: 'slack',
      },
    })
    ids.nangoConnection = nangoConnection.id

    const flow = await prisma.flow.create({
      data: { name: 'teardown-flow', organizationId: org.id, status: 'ACTIVE', graph: { nodes: [], edges: [] } },
    })
    ids.flow = flow.id

    // Undecryptable ciphertexts: the google/slack revoke legs must skip their
    // network calls, not reach Google/Slack from a unit test.
    const google = await prisma.googleOAuthConnection.create({
      data: {
        organizationId: org.id, userId: user.id, service: 'google-mail',
        accountEmail: 'teardown@example.com', scopes: [], refreshTokenEnc: 'v2:AAAA:AAAA:AAAA:AAAA',
      },
    })
    ids.google = google.id
    const slack = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: org.id, userId: user.id, teamId: 'T-teardown', botUserId: 'U-teardown-bot',
        botToken: { value: 'v2:AAAA:AAAA:AAAA:AAAA' }, signingSecret: { value: 'v2:AAAA:AAAA:AAAA:AAAA' }, status: 'active',
      },
    })
    ids.slack = slack.id
  })

  after(async () => {
    // Best-effort cleanup in case the delete under test didn't run (RED phase).
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.nangoConnection.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.user.deleteMany({ where: { organizationId: ids.org } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: ids.org } }).catch(() => {})
  })

  test('teardownOrganization deprovisions externals (no-op when unconfigured), clears the graph, and deletes the org row + cascades', async () => {
    assert.equal(process.env.NANGO_SECRET_KEY, undefined)
    assert.equal(process.env.NEO4J_URI, undefined)

    const result = await teardownOrganization(ids.org)

    // Env unset → each external leg no-ops without attempting a call.
    assert.equal(result.nango, 0)
    assert.equal(result.graphCleared, false)

    const org = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.equal(org, null)

    const nangoConnectionCount = await prisma.nangoConnection.count({ where: { id: ids.nangoConnection, organizationId: ids.org } })
    assert.equal(nangoConnectionCount, 0)

    const flowCount = await prisma.flow.count({ where: { id: ids.flow, organizationId: ids.org } })
    assert.equal(flowCount, 0)

    // Google/Slack legs ran (undecryptable tokens → zero revocations
    // attempted) and the rows cascaded away with the org.
    assert.equal(result.google, 0)
    assert.equal(result.slack, 0)
    const googleCount = await prisma.googleOAuthConnection.count({ where: { id: ids.google, organizationId: ids.org } })
    assert.equal(googleCount, 0)
    const slackCount = await prisma.slackWorkspaceConnection.count({ where: { id: ids.slack, organizationId: ids.org } })
    assert.equal(slackCount, 0)
  })

  test('the teardown itself is on the audit record — and the row survives the org delete', async () => {
    // Workspace deletion is the one admin action that used to erase its own
    // audit trail: AuditEvent cascaded with the org. The FK is now SET NULL,
    // so the organization.deleted row (written before the delete) persists as
    // an orphan a DB operator can still read.
    const event = await systemPrisma.auditEvent.findFirst({
      where: { action: 'organization.deleted', resourceId: ids.org },
    })
    assert.ok(event, 'workspace deletion wrote no audit row')
    assert.equal(event.organizationId, null, 'audit row did not survive the cascade (expected SET NULL)')
  })
}
