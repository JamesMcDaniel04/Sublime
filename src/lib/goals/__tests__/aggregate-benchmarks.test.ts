import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeGoalBenchmarks,
  surfaceGoalBenchmark,
} from '@/lib/goals/aggregate-benchmarks'

const seed = (seedKey: string, name: string) =>
  ({
    seedKey,
    name,
    description: '',
    kind: 'flow',
    departments: ['sales'],
    requiredIntegrations: [],
    recommendedIntegrations: [],
    goalKinds: ['arr'],
  }) as never

test('benchmark math counts outcomes, distinct orgs, and ranks adopted seeds', () => {
  const rows = computeGoalBenchmarks(
    [
      { kind: 'arr', organizationId: 'a', outcome: 'achieved' },
      { kind: 'arr', organizationId: 'a', outcome: 'missed' },
      { kind: 'arr', organizationId: 'b', outcome: 'achieved' },
    ],
    [seed('a', 'A'), seed('b', 'B')],
    {
      'seed:a': { deploys: 20, surviving: 0 },
      'seed:b': { deploys: 3, surviving: 3 },
    },
  )
  assert.deepEqual(rows, [
    {
      kind: 'arr',
      orgCount: 2,
      settledCount: 3,
      achievedCount: 2,
      topSeedKeys: [
        { seedKey: 'b', name: 'B', deploys: 3 },
        { seedKey: 'a', name: 'A', deploys: 20 },
      ],
    },
  ])
})

test('surfacing applies the k floor and rounds achieved rate', () => {
  const row = {
    orgCount: 5,
    settledCount: 8,
    achievedCount: 5,
    topSeedKeys: [{ seedKey: 'a', name: 'Pipeline Reviver', deploys: 7 }],
  }
  assert.equal(surfaceGoalBenchmark({ ...row, orgCount: 4 }), null)
  assert.deepEqual(surfaceGoalBenchmark(row), {
    orgCount: 5,
    achievedRate: 63,
    topSeeds: [{ seedKey: 'a', name: 'Pipeline Reviver', deploys: 7 }],
  })
})
