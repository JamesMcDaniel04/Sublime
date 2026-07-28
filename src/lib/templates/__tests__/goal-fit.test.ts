import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalTemplatesFor } from '../goal-fit'
import { SEED_CATALOGUE, type SeedTemplate } from '../catalogue'

test('every revenue goal kind has at least one tagged template', () => {
  for (const kind of ['arr', 'kpi', 'quota'] as const) {
    assert.ok(goalTemplatesFor(kind).length >= 1, `no template tagged for goal kind '${kind}'`)
  }
})

test('tagged seeds carry a per-run time-saved estimate', () => {
  for (const seed of SEED_CATALOGUE.filter((item) => (item.goalKinds ?? []).length > 0)) {
    assert.ok(
      (seed.estimatedMinutesSaved ?? 0) > 0,
      `${seed.seedKey} tagged for goals but has no estimatedMinutesSaved`,
    )
  }
})

test('filter is exact and pure', () => {
  const seeds = [
    { seedKey: 'a', goalKinds: ['arr'], estimatedMinutesSaved: 20 },
    { seedKey: 'b', goalKinds: ['quota'], estimatedMinutesSaved: 20 },
    { seedKey: 'c' },
  ] as SeedTemplate[]
  assert.deepEqual(
    goalTemplatesFor('quota', seeds).map((seed) => seed.seedKey),
    ['b'],
  )
})
