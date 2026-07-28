import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATAPOINT_LIMIT,
  GoalsToolClient,
  goalsTools,
  type AgentGoalView,
  type GoalsDataPort,
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

function fakePort(
  goals: Record<string, AgentGoalView>,
  points: Record<string, { value: number; capturedAt: Date }[]> = {},
): GoalsDataPort & { writes: { goalId: string; value: number; capturedAt: Date }[] } {
  const writes: { goalId: string; value: number; capturedAt: Date }[] = []
  return {
    writes,
    async getGoal(goalId) {
      return goals[goalId] ?? null
    },
    async listDatapoints(goalId, limit) {
      return (points[goalId] ?? []).slice(0, limit)
    },
    async writeDatapoint(goalId, value, capturedAt) {
      writes.push({ goalId, value, capturedAt })
    },
  }
}

test('goalsTools exposes exactly the four documented tools, one of them a write', () => {
  const names = goalsTools().map((tool) => tool.name).sort()
  assert.deepEqual(names, ['get_goal', 'get_pace', 'list_datapoints', 'log_datapoint'])
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
