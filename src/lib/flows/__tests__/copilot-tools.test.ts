import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

type Seeded = Awaited<ReturnType<Awaited<typeof import('@/lib/server/__tests__/test-auth')>['seedTestOrg']>>

let prisma: typeof import('@/lib/prisma').prisma
let orgA: Seeded
let orgB: Seeded
let flowA: { id: string }
let flowB: { id: string }
let runA: { id: string }
let runB: { id: string }

before(async () => {
  ;({ prisma } = await import('@/lib/prisma'))
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  orgA = await seedTestOrg(prisma)
  orgB = await seedTestOrg(prisma)

  async function makeFlowWithRun(org: Seeded) {
    const flow = await prisma.flow.create({
      data: {
        name: 'Lead router', organizationId: org.auth.organizationId, userId: org.auth.dbUser.id,
        visibility: 'org_visible', graph: { nodes: [], edges: [] },
      },
    })
    const run = await prisma.flowRun.create({
      data: {
        flowId: flow.id, organizationId: org.auth.organizationId, status: 'failed',
        error: 'HTTP 401 from Salesforce', startedAt: new Date(),
      },
    })
    await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id, nodeId: 'sf_query', order: 1, status: 'failed',
        input: { soql: 'SELECT…' }, error: 'INVALID_SESSION_ID',
      },
    })
    return { flow, run }
  }

  const a = await makeFlowWithRun(orgA)
  const b = await makeFlowWithRun(orgB)
  flowA = a.flow
  flowB = b.flow
  runA = a.run
  runB = b.run
})

after(async () => {
  await orgA.cleanup()
  await orgB.cleanup()
})

test('get_flow_run returns own run steps, refuses another org\'s run', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({
    organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: flowA.id,
  })
  const getRun = tools.find((tool) => tool.definition.name === 'get_flow_run')!

  const own = (await getRun.execute({ runId: runA.id })) as { status: string; steps: Array<{ nodeId: string }> }
  assert.equal(own.status, 'failed')
  assert.equal(own.steps[0].nodeId, 'sf_query')

  const foreign = (await getRun.execute({ runId: runB.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Run not found.' })
})

test('get_flow returns a visible flow graph and refuses a foreign one', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({
    organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: null,
  })
  const getFlow = tools.find((tool) => tool.definition.name === 'get_flow')!
  const own = (await getFlow.execute({ flowId: flowA.id })) as Record<string, unknown>
  assert.ok(own.graph)
  const foreign = (await getFlow.execute({ flowId: flowB.id })) as Record<string, unknown>
  assert.deepEqual(foreign, { error: 'Flow not found.' })
})

test('list_flow_runs defaults to the current flow and errors helpfully without one', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const withFlow = buildFlowCopilotTools({
    organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: flowA.id,
  })
  const list = withFlow.find((tool) => tool.definition.name === 'list_flow_runs')!
  const result = (await list.execute({ flowId: null, status: null, limit: null })) as { runs: Array<{ id: string }> }
  assert.equal(result.runs[0].id, runA.id)

  const withoutFlow = buildFlowCopilotTools({
    organizationId: orgA.auth.organizationId, userId: orgA.auth.dbUser.id, currentFlowId: null,
  })
  const listBare = withoutFlow.find((tool) => tool.definition.name === 'list_flow_runs')!
  const bare = (await listBare.execute({ flowId: null, status: null, limit: null })) as Record<string, unknown>
  assert.match(String(bare.error), /flow/i)
})

test('tool roster and labels', async () => {
  const { buildFlowCopilotTools } = await import('../copilot-tools')
  const tools = buildFlowCopilotTools({ organizationId: 'o1', userId: 'u1', currentFlowId: null })
  assert.deepEqual(
    tools.map((tool) => tool.definition.name).sort(),
    ['get_flow', 'get_flow_run', 'get_tool_schema', 'list_flow_connections', 'list_flow_runs'],
  )
  const getRun = tools.find((tool) => tool.definition.name === 'get_flow_run')!
  assert.match(getRun.label({ runId: 'run_xyz98765' }), /run_xyz9/)
})
