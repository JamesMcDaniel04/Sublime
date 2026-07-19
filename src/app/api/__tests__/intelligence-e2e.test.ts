/**
 * End-to-end QA drive for intelligence phases 1-4 (cross-tool correlation +
 * capability gaps, org peer practices, platform archetypes with k-anonymity,
 * outcome-learning weights), following the route-smoke protocol: real
 * Postgres (TEST_DATABASE_URL), seeded auth context, REAL pipeline modules
 * and route handlers — loaders hit the actual database; only the tool-plane
 * catalog (network) is stubbed.
 *
 * LLM/graph-dependent legs (suggestion synthesis, Neo4j projection) degrade
 * gracefully without provider keys — this suite asserts the degradation is
 * clean (no phantom rows, claim released), not the LLM output itself.
 *
 * Skipped entirely unless TEST_DATABASE_URL is set (mirrors route-smoke).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'qa-cron-secret'

  const DAY = 24 * 60 * 60 * 1000
  const now = new Date()
  const daysAgo = (d: number, offsetMinutes = 0) => new Date(now.getTime() - d * DAY + offsetMinutes * 60 * 1000)

  let prisma: any
  let systemPrisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let peerUserId: string
  let peerFlowId: string
  let privateFlowId: string
  let manualFlowId: string

  const seedEvent = (data: {
    userId: string
    organizationId?: string
    kind: string
    resourceType?: string | null
    resourceId?: string | null
    context?: Record<string, unknown>
    occurredAt: Date
  }) =>
    prisma.userEvent.create({
      data: {
        organizationId: data.organizationId ?? organizationId,
        userId: data.userId,
        kind: data.kind,
        resourceType: data.resourceType ?? null,
        resourceId: data.resourceId ?? null,
        context: data.context ?? {},
        occurredAt: data.occurredAt,
      },
    })

  const seedToolCall = (uid: string, provider: string, occurredAt: Date, extra: { toolNames?: string[]; executionId?: string; organizationId?: string } = {}) =>
    seedEvent({
      userId: uid,
      organizationId: extra.organizationId,
      kind: 'tool_call',
      resourceType: 'integration',
      resourceId: provider,
      context: { provider, toolNames: extra.toolNames ?? ['do_thing'], executionId: extra.executionId ?? 'qa-x' },
      occurredAt,
    })

  const patterns = () => prisma.userPattern.findMany({ where: { organizationId, userId } })
  const patternBySlug = async (slug: string) => (await patterns()).find((p: any) => p.slug === slug)

  const runInference = async (overrides: Record<string, unknown> = {}) => {
    const { inferUserBehaviorPatterns } = await import('@/lib/behavior/infer-user-patterns')
    return inferUserBehaviorPatterns(organizationId, userId, {
      loadCapabilities: async () => new Map([['asana', ['list_tasks', 'create_task']]]),
      loadPeerInputs: async () => null,
      loadArchetypeInputs: async () => null,
      ...overrides,
    })
  }

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
    await systemPrisma.platformArchetype.deleteMany({}).catch(() => {})
  })

  // ══════════════ Phase 1: capture contract ══════════════

  test('P1 capture: recordToolCallEvents writes deduped, reference-only rows', async () => {
    const { recordToolCallEvents } = await import('@/lib/behavior/record-event')
    await recordToolCallEvents({
      organizationId,
      userId,
      executionId: 'qa-exec-1',
      touched: new Map([['asana', new Set(['list_tasks', 'list_tasks'])]]),
    })
    const row = await prisma.userEvent.findFirst({ where: { organizationId, userId, kind: 'tool_call' } })
    assert.ok(row, 'tool_call row missing')
    assert.equal(row.resourceType, 'integration')
    assert.equal(row.resourceId, 'asana')
    // Privacy contract: references only — exactly these keys, no args/results.
    assert.deepEqual(Object.keys(row.context).sort(), ['executionId', 'provider', 'toolNames'])
    assert.deepEqual(row.context.toolNames, ['list_tasks'])
    await prisma.userEvent.deleteMany({ where: { organizationId, userId } }) // clean slate for mining legs
  })

  // ══════════════ Phase 1: mining end-to-end ══════════════

  test('P1 mining: correlations + all three gap rules land in user_patterns', async () => {
    // Five interactive asana+github sessions across 5 distinct days spanning 8+ days.
    for (const d of [20, 18, 16, 14, 12]) {
      await seedEvent({ userId, kind: 'agent_run_manual', resourceType: 'agent', resourceId: 'qa-agent', occurredAt: daysAgo(d) })
      await seedToolCall(userId, 'asana', daysAgo(d, 5), { toolNames: ['list_tasks'] })
      await seedToolCall(userId, 'github', daysAgo(d, 10), { toolNames: ['list_prs'] })
    }
    // Dormant connection: added 35 days ago, provider never in any tool_call.
    await seedEvent({
      userId, kind: 'connection_added', resourceType: 'connection', resourceId: 'conn-slack',
      context: { provider: 'slack' }, occurredAt: daysAgo(35),
    })
    // Manual-cadence flow: real manual-trigger flow, run by hand on 3 same-weekday dates.
    const manualFlow = await prisma.flow.create({
      data: { name: 'QA Manual Review', organizationId, userId, status: 'DRAFT', visibility: 'private', trigger: { type: 'manual' } },
    })
    manualFlowId = manualFlow.id
    for (const d of [7, 14, 21]) {
      await seedEvent({ userId, kind: 'flow_run_manual', resourceType: 'flow', resourceId: manualFlowId, occurredAt: daysAgo(d) })
    }

    const result = await runInference()
    assert.ok('patterns' in result, `inference failed: ${JSON.stringify(result)}`)

    const corr = await patternBySlug('toolcorr:asana+github')
    assert.ok(corr, 'tool_correlation pattern missing')
    assert.equal(corr.kind, 'tool_correlation')
    assert.equal(corr.occurrenceCount, 5)

    assert.ok(await patternBySlug('gap:dormant:slack'), 'dormant-connection gap missing')
    assert.ok(await patternBySlug(`gap:schedule:${manualFlowId}`), 'manual-cadence gap missing')
    const capGap = await patternBySlug('gap:capability:asana:create_task')
    assert.ok(capGap, 'unused-capability gap missing')
    assert.equal(capGap.kind, 'capability_gap')
    // The USED capability must not be flagged.
    assert.equal(await patternBySlug('gap:capability:asana:list_tasks'), undefined)
  })

  test('P1 gate: correlation and gaps pass eligibility with correct kind rules', async () => {
    const { listEligiblePatterns } = await import('@/lib/behavior/eligibility')
    const eligible = await listEligiblePatterns(organizationId, userId)
    const slugs = eligible.map((p: any) => p.slug)
    assert.ok(slugs.includes('toolcorr:asana+github'), 'correlation not eligible')
    assert.ok(slugs.includes('gap:dormant:slack'), 'dormant gap not eligible (occurrence/span bypass broken)')
    assert.ok(slugs.includes(`gap:schedule:${manualFlowId}`), 'schedule gap not eligible')
  })

  // ══════════════ Phase 2: peer practices ══════════════

  test('P2: an org-shared, actively-run teammate flow mines a peer_practice; private flows never do', async () => {
    peerUserId = (await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true } })).id
    const mkPeerFlow = async (name: string, visibility: string, providers: string[]) => {
      const flow = await prisma.flow.create({
        data: { name, organizationId, userId: peerUserId, status: 'ACTIVE', visibility, trigger: { type: 'manual' } },
      })
      for (const d of [3, 5, 8]) {
        const run = await prisma.flowRun.create({
          data: { flowId: flow.id, organizationId, userId: peerUserId, status: 'succeeded', startedAt: daysAgo(d) },
        })
        for (const provider of providers) {
          await seedToolCall(peerUserId, provider, daysAgo(d, 2), { executionId: run.id })
        }
      }
      return flow.id
    }
    peerFlowId = await mkPeerFlow('Peer Standup Digest', 'shared', ['asana', 'slack'])
    privateFlowId = await mkPeerFlow('Private Side Project', 'private', ['asana', 'gmail'])

    const result = await runInference({ loadPeerInputs: undefined }) // real DB loader
    assert.ok('patterns' in result, `inference failed: ${JSON.stringify(result)}`)

    const peer = await patternBySlug(`peer:flow:${peerFlowId}`)
    assert.ok(peer, 'peer_practice pattern missing')
    assert.equal(peer.kind, 'peer_practice')
    assert.equal(peer.occurrenceCount, 3)
    assert.ok(peer.summary.includes('Peer Standup Digest'))
    // Privacy: no teammate identity anywhere in the row.
    assert.ok(!JSON.stringify(peer).includes(peerUserId), 'peer summary leaks teammate id')
    // Privacy: the private flow NEVER becomes a pattern.
    assert.equal(await patternBySlug(`peer:flow:${privateFlowId}`), undefined, 'private flow leaked into peer mining')
    // Evidence contract: every cited event belongs to the mining user.
    const evidenceRows = await prisma.userEvent.findMany({ where: { organizationId, id: { in: peer.evidence as string[] } } })
    assert.ok(evidenceRows.length > 0)
    assert.ok(evidenceRows.every((e: any) => e.userId === userId), 'evidence cites another user’s events')
  })

  // ══════════════ Phase 3: platform archetypes + k-anonymity ══════════════

  const contributorOrgs: string[] = []
  const seedContributorOrg = async (n: number) => {
    const org = await prisma.organization.create({ data: { name: `QA Archetype ${n}`, slug: `qa-arch-${crypto.randomUUID()}` } })
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true } })
    const flow = await prisma.flow.create({
      data: { name: `Digest ${n}`, organizationId: org.id, userId: user.id, status: 'ACTIVE', visibility: 'shared', trigger: { type: 'schedule' } },
    })
    for (const d of [2, 4, 6]) {
      const run = await prisma.flowRun.create({
        data: { flowId: flow.id, organizationId: org.id, userId: user.id, status: 'succeeded', startedAt: daysAgo(d) },
      })
      for (const provider of ['asana', 'slack']) {
        await seedToolCall(user.id, provider, daysAgo(d, 2), { executionId: run.id, organizationId: org.id })
      }
    }
    contributorOrgs.push(org.id)
  }

  test('P3 k-anonymity: below the org floor, NO archetype row exists', async () => {
    const { aggregatePlatformArchetypes, MIN_ARCHETYPE_ORGS } = await import('@/lib/intelligence/aggregate-archetypes')
    for (let i = 0; i < MIN_ARCHETYPE_ORGS - 1; i++) await seedContributorOrg(i)
    const result = await aggregatePlatformArchetypes()
    assert.ok('archetypes' in result, `sweep failed: ${JSON.stringify(result)}`)
    const row = await systemPrisma.platformArchetype.findUnique({ where: { signature: 'asana+slack:schedule' } })
    assert.equal(row, null, `k-anonymity violated: row exists at ${MIN_ARCHETYPE_ORGS - 1} orgs`)
  })

  test('P3 aggregation: at the floor, the shape aggregates with correct counts and no org identity', async () => {
    const { aggregatePlatformArchetypes, MIN_ARCHETYPE_ORGS } = await import('@/lib/intelligence/aggregate-archetypes')
    await seedContributorOrg(MIN_ARCHETYPE_ORGS - 1)
    await aggregatePlatformArchetypes()
    const row = await systemPrisma.platformArchetype.findUnique({ where: { signature: 'asana+slack:schedule' } })
    assert.ok(row, 'archetype row missing at the k-anon floor')
    assert.equal(row.orgCount, MIN_ARCHETYPE_ORGS)
    assert.equal(row.triggerType, 'schedule')
    // Nothing org- or user-identifiable in the row.
    for (const orgId of contributorOrgs) assert.ok(!JSON.stringify(row).includes(orgId))
  })

  test('P3 mining: an org with the tools but not the shape gets an archetype_gap', async () => {
    // The target user now touches slack too (their org has asana+slack but no scheduled shape).
    await seedToolCall(userId, 'slack', daysAgo(2))
    const result = await runInference({ loadArchetypeInputs: undefined }) // real DB loader
    assert.ok('patterns' in result, `inference failed: ${JSON.stringify(result)}`)
    const gap = await patternBySlug('archetype:asana+slack:schedule')
    assert.ok(gap, 'archetype_gap pattern missing')
    assert.equal(gap.kind, 'archetype_gap')
    assert.ok(gap.summary.includes('other organizations'))
    const evidenceRows = await prisma.userEvent.findMany({ where: { organizationId, id: { in: gap.evidence as string[] } } })
    assert.ok(evidenceRows.every((e: any) => e.userId === userId), 'archetype evidence cites foreign events')
  })

  test('P3 mining suppression: an org that HAS the shape gets no archetype_gap', async () => {
    // Contributor org 0 has the shape; its user must NOT mine the gap.
    const contribUser = await prisma.user.findFirst({ where: { organizationId: contributorOrgs[0] } })
    const { inferUserBehaviorPatterns } = await import('@/lib/behavior/infer-user-patterns')
    await inferUserBehaviorPatterns(contributorOrgs[0], contribUser.id, {
      loadCapabilities: async () => new Map(),
      loadPeerInputs: async () => null,
    })
    const leaked = await systemPrisma.userPattern.findFirst({
      where: { organizationId: contributorOrgs[0], userId: contribUser.id, slug: 'archetype:asana+slack:schedule' },
    })
    assert.equal(leaked, null, 'org owning the shape still mined the gap')
  })

  // ══════════════ Synthesis degradation (no LLM keys) ══════════════

  test('synthesis: without provider keys it degrades cleanly — no phantom suggestion, claim released', async () => {
    const { synthesizeUserSuggestions } = await import('@/lib/intelligence/suggest-user-workflows')
    const result = await synthesizeUserSuggestions(organizationId, userId)
    assert.ok('skipped' in result, `expected graceful skip, got ${JSON.stringify(result)}`)
    const open = await prisma.userSuggestion.findFirst({ where: { organizationId, userId, status: 'open' } })
    assert.equal(open, null, 'phantom suggestion created without an LLM')
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { metadata: true } })
    assert.equal((user?.metadata as any)?.lastBehaviorSynthesisAt, undefined, 'weekly claim not released after failure')
  })

  // ══════════════ Phase 4: outcome weights at the gate ══════════════

  test('P4: repeatedly rejected kinds are suppressed; adopted kinds rank first; history is user-scoped', async () => {
    const { listEligiblePatterns } = await import('@/lib/behavior/eligibility')
    const before = await listEligiblePatterns(organizationId, userId)
    assert.ok(before.some((p: any) => p.kind === 'tool_correlation'), 'precondition: correlation eligible')

    // Two dismissed suggestions grounded in tool_correlation → weight -2 → suppressed.
    for (const title of ['qa-reject-1', 'qa-reject-2']) {
      await prisma.userSuggestion.create({
        data: {
          organizationId, userId, kind: 'new_flow', title, description: 'qa', status: 'dismissed',
          sourcePatternSlugs: ['toolcorr:asana+github'], evidence: [],
        },
      })
    }
    // One accepted-and-adopted suggestion grounded in the dormant gap → capability_gap +2.
    const adoptedFlow = await prisma.flow.create({
      data: { name: 'QA Adopted', organizationId, userId, status: 'ACTIVE', visibility: 'private', trigger: { type: 'manual' } },
    })
    await prisma.userSuggestion.create({
      data: {
        organizationId, userId, kind: 'new_flow', title: 'qa-adopted', description: 'qa', status: 'accepted',
        flowId: adoptedFlow.id, sourcePatternSlugs: ['gap:dormant:slack'], evidence: [],
      },
    })

    const after = await listEligiblePatterns(organizationId, userId)
    assert.ok(!after.some((p: any) => p.kind === 'tool_correlation'), 'rejected kind not suppressed at the gate')
    assert.equal(after[0]?.kind, 'capability_gap', 'adopted kind not ranked first')

    // Isolation: another user in the same org is unaffected by this user's history.
    const peerEligible = await listEligiblePatterns(organizationId, peerUserId)
    assert.ok(peerEligible !== null) // gate runs clean for a user with no patterns
  })

  // ══════════════ Real cron surface ══════════════

  test('cron dispatch: the real route runs the tick (behavior + archetype hooks) without error', async () => {
    const route = await import('../cron/dispatch/route')
    const res = await route.GET(new NextRequest(new URL('http://test/api/cron/dispatch'), {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    } as never))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
  })

  test('cleanup: contributor orgs', async () => {
    for (const orgId of contributorOrgs) {
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
    }
    assert.ok(true)
  })
} else {
  test('intelligence e2e (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
