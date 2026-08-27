/**
 * The store, end to end across two workspaces: publish, visibility, install
 * (native and external), the update path, and the invariant that a listing
 * never carries a secret. Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ALLOW_UNENCRYPTED_SECRETS = '1'
  let prisma: any
  let A: any
  let B: any
  let installTestAuth: (auth: any) => void
  let nativeAgentId: string
  let externalAgentId: string
  let nativeListingId: string
  let externalListingId: string

  const post = (path: string, body: unknown) =>
    new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const get = (path: string) => new NextRequest(`http://localhost${path}`)
  const as = (org: any) => installTestAuth(org.auth)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const seam = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = seam.installTestAuth
    A = await seam.seedTestOrg(prisma)
    B = await seam.seedTestOrg(prisma)
    await prisma.organization.update({ where: { id: A.organizationId }, data: { name: 'Acme Tools' } })
    nativeAgentId = (await prisma.agentTask.create({ data: {
      agentType: 'CUSTOM', description: 'Renewal Scout', objective: 'Monitor renewal risk across named accounts.', goal: 'Retain accounts', status: 'ACTIVE', visibility: 'shared',
      organizationId: A.organizationId, userId: A.userId, grants: { '*': 'read', slack: 'write' },
      metadata: { title: 'Riley', model: 'claude-sonnet-5', integrations: ['slack', 'salesforce'], skills: ['sk_local'] },
    } })).id
    externalAgentId = (await prisma.agentTask.create({ data: {
      agentType: 'CUSTOM', runtime: 'external', description: 'Legal reviewer', objective: 'Review contracts for risk.', status: 'ACTIVE', visibility: 'shared',
      organizationId: A.organizationId, userId: A.userId, metadata: { title: 'Lex' },
    } })).id
    const { encryptExternalAuth } = await import('@/lib/agents/external-agent')
    await prisma.externalAgentBinding.create({ data: {
      organizationId: A.organizationId, agentTaskId: externalAgentId, endpointUrl: 'https://example.com/legal', authType: 'bearer',
      authConfig: encryptExternalAuth({ authType: 'bearer', secret: 'publisher-secret' }), timeoutMinutes: 20,
    } })
  })
  after(async () => { await A?.cleanup?.(); await B?.cleanup?.() })

  test('the owner publishes to their workspace; only an admin can publish to every workspace', async () => {
    as(A)
    const { POST } = await import('../store/route')
    const org = await (await POST(post('/api/store', { agentId: nativeAgentId, visibility: 'organization' }))).json()
    assert.equal(org.success, true); assert.equal(org.listing.version, 1); assert.equal(org.listing.kind, 'native')
    nativeListingId = org.listing.id
    // The seeded user is an ADMIN, so public is allowed; a member would be refused (covered by the route's isAdmin gate).
    const pub = await (await POST(post('/api/store', { agentId: externalAgentId, visibility: 'public', slug: 'legal-reviewer' }))).json()
    assert.equal(pub.listing.kind, 'external'); assert.equal(pub.listing.visibility, 'public')
    externalListingId = pub.listing.id
  })

  test('a listing never carries a secret, and drops workspace-local skills', async () => {
    const rows = await prisma.storeListing.findMany({ where: { publisherOrganizationId: A.organizationId } })
    for (const row of rows) {
      const text = JSON.stringify(row.definition)
      assert.equal(text.includes('publisher-secret'), false)
      assert.equal(/secretEnc|ciphertext/.test(text), false)
      assert.equal(text.includes('sk_local'), false)
    }
  })

  test("another workspace sees the public listing but not the organization-only one", async () => {
    as(B)
    const { GET } = await import('../store/route')
    const { listings } = await (await GET(get('/api/store'))).json()
    assert.deepEqual(listings.map((l: any) => l.slug), ['legal-reviewer'])
    assert.equal(listings[0].publisher.name, 'Acme Tools')
    assert.equal(listings[0].requiresSecret, true)
    assert.equal(listings[0].install, null)
    as(A)
    const mine = await (await GET(get('/api/store'))).json()
    assert.equal(mine.listings.length, 2, 'the publisher sees both')
  })

  test('installing a native package puts a teammate on the roster with the listing\'s job and grants', async () => {
    as(A)
    const { POST: publish } = await import('../store/route')
    await publish(post('/api/store', { agentId: nativeAgentId, visibility: 'public' })) // re-publish public → version 2
    as(B)
    const { POST } = await import('../store/[id]/install/route')
    const result = await (await POST(post(`/api/store/${nativeListingId}/install`, {}))).json()
    assert.equal(result.success, true); assert.equal(result.installedVersion, 2)
    const agent = await prisma.agentTask.findFirst({ where: { id: result.agentId, organizationId: B.organizationId } })
    assert.ok(agent, 'installed into B, not A')
    assert.match(agent.objective, /Monitor renewal risk/)
    assert.equal(agent.goal, 'Retain accounts')
    assert.deepEqual(agent.grants, { '*': 'read', slack: 'write' }, "the listing's grant, not provisioning's default")
    assert.equal(agent.metadata.title, 'Riley')
    const again = await POST(post(`/api/store/${nativeListingId}/install`, {}))
    assert.equal(again.status, 409, 'already installed')
  })

  test('an authenticated external package needs the installer\'s own credential, and binds to the publisher\'s endpoint', async () => {
    as(B)
    const { POST } = await import('../store/[id]/install/route')
    const refused = await POST(post(`/api/store/${externalListingId}/install`, {}))
    assert.equal(refused.status, 400)
    const result = await (await POST(post(`/api/store/${externalListingId}/install`, { secret: 'installer-secret' }))).json()
    const agent = await prisma.agentTask.findFirst({ where: { id: result.agentId, organizationId: B.organizationId } })
    assert.equal(agent.runtime, 'external')
    const binding = await prisma.externalAgentBinding.findFirst({ where: { agentTaskId: agent.id, organizationId: B.organizationId } })
    assert.equal(binding.endpointUrl, 'https://example.com/legal')
    assert.equal(binding.authType, 'bearer')
    assert.notEqual(binding.authConfig.secretEnc, 'installer-secret', 'encrypted at rest')
    assert.equal(JSON.stringify(binding.authConfig).includes('publisher-secret'), false)
  })

  test('a re-publish surfaces an update; applying it respects local edits unless forced', async () => {
    as(A)
    await prisma.agentTask.updateMany({ where: { id: nativeAgentId, organizationId: A.organizationId }, data: { objective: 'Monitor renewal risk, and flag champions who changed roles.' } })
    const { POST: publish } = await import('../store/route')
    const bumped = await (await publish(post('/api/store', { agentId: nativeAgentId, visibility: 'public' }))).json()
    assert.equal(bumped.listing.version, 3)

    as(B)
    const { GET } = await import('../store/route')
    const { listings } = await (await GET(get('/api/store'))).json()
    const mine = listings.find((l: any) => l.id === nativeListingId)
    assert.equal(mine.install.installedVersion, 2); assert.equal(mine.install.updateAvailable, true)

    const { POST: install } = await import('../store/[id]/install/route')
    // B edits the installed agent locally, then an update must not silently clobber it.
    await new Promise((r) => setTimeout(r, 20))
    await prisma.agentTask.updateMany({ where: { id: mine.install.agentTaskId, organizationId: B.organizationId }, data: { objective: 'B tweaked this' } })
    const blocked = await install(post(`/api/store/${nativeListingId}/install`, { update: true }))
    assert.equal(blocked.status, 409)
    assert.equal((await blocked.json()).code, 'LOCAL_EDITS')
    const forced = await (await install(post(`/api/store/${nativeListingId}/install`, { update: true, force: true }))).json()
    assert.equal(forced.updated, true); assert.equal(forced.installedVersion, 3)
    const agent = await prisma.agentTask.findFirst({ where: { id: mine.install.agentTaskId, organizationId: B.organizationId } })
    assert.match(agent.objective, /champions who changed roles/)
  })
}
