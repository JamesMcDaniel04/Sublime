import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATAPOINT_LIMIT,
  GoalsToolClient,
  goalsTools,
  type AgentGoalView,
  type GoalsDataPort,
  type GoalWorkItem,
  type WriteWorkInput,
} from '@/lib/integrations/goals'

const NOW = new Date('2026-07-27T12:00:00Z')

function goalView(overrides: Partial<AgentGoalView> = {}): AgentGoalView {
  return {
    id: 'goal-a',
    name: 'Quarterly revenue',
    kind: 'arr',
    unit: 'usd',
    direction: 'increase',
    startValue: 0,
    targetValue: 1000,
    startAt: new Date('2026-07-01T00:00:00Z'),
    targetDate: new Date('2026-07-31T00:00:00Z'),
    recurrence: 'quarterly',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    primarySource: 'manual',
    refreshIntervalHours: 24,
    ...overrides,
  }
}

type WorkWrite = { goalId: string; input: WriteWorkInput }

function fakePort(
  goals: Record<string, AgentGoalView>,
  points: Record<string, { value: number; capturedAt: Date }[]> = {},
  work: Record<string, GoalWorkItem[]> = {},
): GoalsDataPort & {
  writes: { goalId: string; value: number; capturedAt: Date }[]
  workWrites: WorkWrite[]
} {
  const writes: { goalId: string; value: number; capturedAt: Date }[] = []
  const workWrites: WorkWrite[] = []
  return {
    writes,
    workWrites,
    async getGoal(goalId) {
      return goals[goalId] ?? null
    },
    async listDatapoints(goalId, limit) {
      return (points[goalId] ?? []).slice(0, limit)
    },
    async writeDatapoint(goalId, value, capturedAt) {
      writes.push({ goalId, value, capturedAt })
    },
    async writeWork(goalId, input) {
      workWrites.push({ goalId, input })
      return { id: `work-${workWrites.length}`, assigned: input.assigneeHint !== null }
    },
    async listWork(goalId, limit, disposition) {
      const rows = work[goalId] ?? []
      return rows
        .filter((row) => (disposition ? row.disposition === disposition : true))
        .slice(0, limit)
    },
  }
}

test('goalsTools exposes exactly the six documented tools', () => {
  const names = goalsTools().map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'get_goal', 'get_pace', 'list_datapoints', 'list_work', 'log_datapoint', 'log_work',
  ])
  for (const tool of goalsTools()) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a usable description`)
    assert.equal((tool.inputSchema as { type: string }).type, 'object')
  }
})

test('a single linked goal makes goalId optional', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  const result = (await client.executeTool('', 'get_goal', {})) as { name: string }
  assert.equal(result.name, 'Quarterly revenue')
})

test('a goal outside the linked set is refused, not silently empty', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'get_goal', { goalId: 'goal-b' }),
    /not linked/,
  )
})

test('with several linked goals, goalId is required rather than guessed', async () => {
  const client = new GoalsToolClient(
    ['goal-a', 'goal-b'],
    fakePort({ 'goal-a': goalView(), 'goal-b': goalView({ id: 'goal-b' }) }),
    () => NOW,
  )
  await assert.rejects(() => client.executeTool('', 'get_goal', {}), /goalId is required/)
})

test('get_pace agrees with evaluateGoal and reports days remaining', async () => {
  const points = [
    { value: 100, capturedAt: new Date('2026-07-20T00:00:00Z') },
    { value: 400, capturedAt: new Date('2026-07-27T00:00:00Z') },
  ]
  const client = new GoalsToolClient(
    ['goal-a'],
    fakePort({ 'goal-a': goalView() }, { 'goal-a': points }),
    () => NOW,
  )
  const pace = (await client.executeTool('', 'get_pace', {})) as {
    currentValue: number
    riskLevel: string
    daysRemaining: number
  }
  assert.equal(pace.currentValue, 400)
  // 0..1000 over July; on 27 July expected pace is ~0.84, actual is 0.40.
  assert.equal(pace.riskLevel, 'off_track')
  assert.equal(pace.daysRemaining, 4)
})

test('list_datapoints is bounded so a long goal cannot flood the context', async () => {
  const many = Array.from({ length: 500 }, (_, index) => ({
    value: index,
    capturedAt: new Date(Date.UTC(2026, 0, 1 + index)),
  }))
  const client = new GoalsToolClient(
    ['goal-a'],
    fakePort({ 'goal-a': goalView() }, { 'goal-a': many }),
    () => NOW,
  )
  const result = (await client.executeTool('', 'list_datapoints', {})) as { points: unknown[] }
  assert.equal(result.points.length, DATAPOINT_LIMIT)
})

test('an unknown tool name is rejected', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(() => client.executeTool('', 'delete_goal', {}), /Unknown goals tool/)
})

test('log_datapoint writes on every AI/human-owned source, labeled AI-read', async () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    const port = fakePort({ 'goal-a': goalView({ primarySource: source }) })
    const client = new GoalsToolClient(['goal-a'], port, () => NOW)
    const result = (await client.executeTool('', 'log_datapoint', { value: 512 })) as {
      ok: boolean
      labeledAs: string
    }
    assert.equal(result.ok, true)
    assert.equal(result.labeledAs, 'AI-read')
    assert.deepEqual(port.writes, [{ goalId: 'goal-a', value: 512, capturedAt: NOW }])
  }
})

test('log_datapoint refuses every system-of-record source and writes nothing', async () => {
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    const port = fakePort({ 'goal-a': goalView({ primarySource: source }) })
    const client = new GoalsToolClient(['goal-a'], port, () => NOW)
    await assert.rejects(
      () => client.executeTool('', 'log_datapoint', { value: 512 }),
      /Cannot write this goal's value/,
      `${source} must refuse the write`,
    )
    assert.deepEqual(port.writes, [], `${source} must not have written`)
  }
})

test('log_datapoint refuses a goal with no metric configured', async () => {
  const port = fakePort({ 'goal-a': goalView({ primarySource: null }) })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 1 }),
    /no metric configured/,
  )
  assert.deepEqual(port.writes, [])
})

test('log_datapoint refuses a non-numeric or future reading', async () => {
  const port = fakePort({ 'goal-a': goalView({ primarySource: 'manual' }) })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)

  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 'lots' }),
    /finite number/,
  )
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { value: 1, capturedAt: '2026-08-01T00:00:00Z' }),
    /future/,
  )
  assert.deepEqual(port.writes, [])
})

test('an unlinked goal cannot be written to even when its source is writable', async () => {
  const port = fakePort({
    'goal-a': goalView({ primarySource: 'manual' }),
    'goal-b': goalView({ id: 'goal-b', primarySource: 'manual' }),
  })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'log_datapoint', { goalId: 'goal-b', value: 9 }),
    /not linked/,
  )
  assert.deepEqual(port.writes, [])
})

test('log_work writes one row per subject and reports whether it found an assignee', async () => {
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)

  const result = await client.executeTool('', 'log_work', {
    subject: 'Acme Corp — deal 412',
    subjectRef: 'deal-412',
    produced: 're-entry email',
    body: 'Following up on the pricing question…',
    assigneeHint: 'dana@acme.com',
  })

  assert.equal(port.workWrites.length, 1, 'exactly one row per call')
  assert.equal(port.workWrites[0].input.subject, 'Acme Corp — deal 412')
  assert.equal(port.workWrites[0].input.subjectRef, 'deal-412')
  assert.equal(port.workWrites[0].input.bodyFormat, 'markdown', 'markdown is the default')
  assert.deepEqual(result, {
    ok: true,
    id: 'work-1',
    goalId: 'goal-a',
    subject: 'Acme Corp — deal 412',
    assigned: true,
  })
})

test('log_work is permitted on a goal owned by a system of record', async () => {
  // Unlike log_datapoint, work has no system of record — this agent IS the
  // author — so AGENT_WRITABLE_SOURCES must not gate it.
  const port = fakePort({ 'goal-a': goalView({ primarySource: 'stripe' }) })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  const result = (await client.executeTool('', 'log_work', {
    subject: 'Acme',
    produced: 're-entry email',
    body: 'x',
  })) as { ok: boolean }
  assert.equal(result.ok, true)
  assert.equal(port.workWrites.length, 1)
})

test('log_work requires a subject and something produced', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(
    () => client.executeTool('', 'log_work', { produced: 'email', body: 'x' }),
    /subject/i,
  )
  await assert.rejects(
    () => client.executeTool('', 'log_work', { subject: 'Acme', body: 'x' }),
    /produced/i,
  )
})

test('log_work refuses a goal this agent is not linked to', async () => {
  const client = new GoalsToolClient(['goal-a'], fakePort({ 'goal-a': goalView() }), () => NOW)
  await assert.rejects(
    () =>
      client.executeTool('', 'log_work', {
        goalId: 'goal-elsewhere',
        subject: 'A',
        produced: 'b',
        body: 'c',
      }),
    /not linked/i,
  )
})

test('list_work returns queued items with their disposition and outcome', async () => {
  const port = fakePort({ 'goal-a': goalView() }, {}, {
    'goal-a': [
      {
        id: 'w1',
        subject: 'Acme',
        subjectRef: 'deal-412',
        produced: 're-entry email',
        disposition: 'skipped',
        outcome: 'unknown',
        assigneeUserId: null,
        createdAt: new Date('2026-07-20T00:00:00Z'),
      },
    ],
  })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  const result = (await client.executeTool('', 'list_work', {})) as {
    items: Array<{ disposition: string; createdAt: string; assigned: boolean }>
  }
  assert.equal(result.items[0].disposition, 'skipped')
  assert.equal(result.items[0].createdAt, '2026-07-20T00:00:00.000Z')
  assert.equal(result.items[0].assigned, false)
})

test('list_work filters by disposition so an agent can see only what was skipped', async () => {
  const port = fakePort({ 'goal-a': goalView() }, {}, {
    'goal-a': [
      { id: 'w1', subject: 'A', subjectRef: null, produced: 'e', disposition: 'skipped', outcome: 'unknown', assigneeUserId: null, createdAt: NOW },
      { id: 'w2', subject: 'B', subjectRef: null, produced: 'e', disposition: 'used', outcome: 'worked', assigneeUserId: null, createdAt: NOW },
    ],
  })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  const result = (await client.executeTool('', 'list_work', { disposition: 'skipped' })) as {
    items: Array<{ id: string }>
  }
  assert.deepEqual(result.items.map((item) => item.id), ['w1'])
})

test('log_work carries signals and a probe rule id through to the port', async () => {
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)

  await client.executeTool('', 'log_work', {
    subject: 'Acme — deal 412',
    produced: 're-entry email',
    body: 'x',
    signals: { daysCold: 21, stage: 'negotiation' },
    probeRuleId: 'rul_8f2',
  })

  assert.deepEqual(port.workWrites[0].input.signals, { daysCold: 21, stage: 'negotiation' })
  assert.equal(port.workWrites[0].input.probeRuleId, 'rul_8f2')
})

test('log_work without signals stores null rather than an empty object', async () => {
  // An empty object would mean "the agent reported no features", which is
  // different from "the agent reported nothing".
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await client.executeTool('', 'log_work', { subject: 'A', produced: 'b', body: 'c' })
  assert.equal(port.workWrites[0].input.signals, null)
  assert.equal(port.workWrites[0].input.probeRuleId, null)
})

test('log_work rejects non-object signals instead of storing junk', async () => {
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  for (const bad of ['daysCold=21', 42, [1, 2]]) {
    await assert.rejects(
      () => client.executeTool('', 'log_work', { subject: 'A', produced: 'b', body: 'c', signals: bad }),
      /signals/i,
      `${JSON.stringify(bad)} must be refused`,
    )
  }
  assert.equal(port.workWrites.length, 0, 'nothing may be written on a refusal')
})

test('the log_work schema documents signals and probeRuleId', async () => {
  const tool = goalsTools().find((entry) => entry.name === 'log_work')!
  const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties
  assert.ok(properties.signals, 'signals must be discoverable in the schema')
  assert.ok(properties.probeRuleId, 'probeRuleId must be discoverable in the schema')
})
