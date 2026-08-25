import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Seeded = Awaited<ReturnType<Awaited<typeof import('@/lib/server/__tests__/test-auth')>['seedTestOrg']>>

/**
 * Needs a real database (seedTestOrg + prisma). Gated so `npm test` stays
 * green on a machine without Postgres — the same convention every other
 * DB-backed suite here follows. Without it these ran unconditionally and
 * `npm test` was red by default for anyone with no TEST_DATABASE_URL.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: typeof import('@/lib/prisma').prisma
  let orgA: Seeded
  let orgB: Seeded

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    orgA = await seedTestOrg(prisma)
    orgB = await seedTestOrg(prisma)
  })

  after(async () => {
    await orgA.cleanup()
    await orgB.cleanup()
  })

  async function makeAgentWithRun(org: Seeded) {
    const agent = await prisma.agentTask.create({
      data: {
        description: 'test agent', objective: 'test', organizationId: org.auth.organizationId,
        userId: org.auth.dbUser.id, visibility: 'org_visible',
        metadata: { title: 'Test Agent' },
      },
    })
    const run = await prisma.agentExecution.create({
      data: {
        agentTaskId: agent.id, organizationId: org.auth.organizationId,
        agentType: 'CUSTOM', input: {}, trigger: { type: 'manual' }, userId: org.auth.dbUser.id,
        status: 'failed', startedAt: new Date(), error: 'Salesforce auth expired',
        metadata: { error: 'Salesforce auth expired' },
      },
    })
    const step = await prisma.workflowStep.create({
      data: { executionId: run.id, node: 'salesforce_query', status: 'failed', input: { soql: 'SELECT…' }, error: { message: 'INVALID_SESSION_ID' } },
    })
    return { agent, run, step }
  }

  test('get_run returns detail for own run, null-equivalent error for another org', async () => {
    const { buildAgentCopilotTools } = await import('../copilot-tools')
    const a = await makeAgentWithRun(orgA)
    const b = await makeAgentWithRun(orgB)

    const tools = buildAgentCopilotTools({
      agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
    })
    const getRun = tools.find((tool) => tool.definition.name === 'get_run')!

    const own = (await getRun.execute({ runId: a.run.id })) as Record<string, unknown>
    assert.equal(own.status, 'failed')
    assert.ok(Array.isArray(own.toolCalls))

    // SECURITY: org A's copilot must not read org B's run — same answer as nonexistent.
    const foreign = (await getRun.execute({ runId: b.run.id })) as Record<string, unknown>
    assert.deepEqual(foreign, { error: 'Run not found.' })
  })

  test('list_runs is capped at 20 and scoped to the agent', async () => {
    const { buildAgentCopilotTools } = await import('../copilot-tools')
    const a = await makeAgentWithRun(orgA)
    const tools = buildAgentCopilotTools({
      agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
    })
    const listRuns = tools.find((tool) => tool.definition.name === 'list_runs')!
    const result = (await listRuns.execute({ limit: 500, status: null, before: null })) as { runs: unknown[] }
    assert.ok(result.runs.length <= 20)
    assert.ok(result.runs.length >= 1)
  })

  test('get_step_output refuses a step whose run belongs to another org', async () => {
    const { buildAgentCopilotTools } = await import('../copilot-tools')
    const a = await makeAgentWithRun(orgA)
    const b = await makeAgentWithRun(orgB)
    const tools = buildAgentCopilotTools({
      agentId: a.agent.id, organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
    })
    const getStep = tools.find((tool) => tool.definition.name === 'get_step_output')!

    const own = (await getStep.execute({ runId: a.run.id, stepId: a.step.id })) as Record<string, unknown>
    assert.equal(own.tool, 'salesforce_query')
    assert.match(String(own.error), /INVALID_SESSION_ID/)

    const foreign = (await getStep.execute({ runId: b.run.id, stepId: b.step.id })) as Record<string, unknown>
    assert.deepEqual(foreign, { error: 'Step not found.' })
  })

  test('list_workspace_agents respects agentReadScope visibility', async () => {
    const { buildAgentCopilotTools } = await import('../copilot-tools')
    await makeAgentWithRun(orgA) // org_visible agent
    // A private agent owned by someone else in the same org must NOT appear.
    const otherUser = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: orgA.auth.organizationId, isActive: true, role: 'MEMBER' },
    })
    const privateAgent = await prisma.agentTask.create({
      data: {
        description: 'secret agent', objective: 'secret', organizationId: orgA.auth.organizationId,
        userId: otherUser.id, visibility: 'private', metadata: { title: 'Secret' },
      },
    })
    const tools = buildAgentCopilotTools({
      agentId: 'irrelevant', organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id,
    })
    const list = tools.find((tool) => tool.definition.name === 'list_workspace_agents')!
    const result = (await list.execute({})) as { agents: Array<{ id: string }> }
    assert.ok(result.agents.length >= 1)
    assert.ok(!result.agents.some((agent) => agent.id === privateAgent.id), 'private foreign agent leaked')
  })

  test('every tool has a label builder that mentions its subject', async () => {
    const { buildAgentCopilotTools } = await import('../copilot-tools')
    const tools = buildAgentCopilotTools({ agentId: 'a1', organizationId: 'o1', userId: 'u1' })
    assert.deepEqual(
      tools.map((tool) => tool.definition.name).sort(),
      ['get_run', 'get_step_output', 'get_tool_schema', 'list_runs', 'list_workspace_agents'],
    )
    const getRun = tools.find((tool) => tool.definition.name === 'get_run')!
    assert.match(getRun.label({ runId: 'run_abc12345' }), /run_abc1/)
  })

} else {
  test('copilot-tools (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}