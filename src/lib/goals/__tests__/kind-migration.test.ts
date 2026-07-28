import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_KIND_VALUES,
  LEGACY_KIND_MAP,
  mapLegacyKind,
  type GoalKind,
} from '../kind-migration'

test('every legacy kind maps to a valid new kind', () => {
  for (const [legacy, next] of Object.entries(LEGACY_KIND_MAP)) {
    assert.ok(
      (GOAL_KIND_VALUES as readonly string[]).includes(next),
      `${legacy} maps to invalid kind ${next}`,
    )
  }
})

test('all seven historical kinds are covered', () => {
  for (const legacy of [
    'arr',
    'mrr',
    'revenue',
    'quota',
    'savings',
    'lead_gen',
    'custom_kpi',
  ]) {
    assert.equal(typeof mapLegacyKind(legacy), 'string', `${legacy} unmapped`)
  }
})

test('revenue family collapses to arr', () => {
  assert.equal(mapLegacyKind('arr'), 'arr')
  assert.equal(mapLegacyKind('mrr'), 'arr')
  assert.equal(mapLegacyKind('revenue'), 'arr')
})

test('quota is identity', () => {
  assert.equal(mapLegacyKind('quota'), 'quota')
})

test('savings, lead_gen and custom_kpi collapse to kpi', () => {
  assert.equal(mapLegacyKind('savings'), 'kpi')
  assert.equal(mapLegacyKind('lead_gen'), 'kpi')
  assert.equal(mapLegacyKind('custom_kpi'), 'kpi')
})

test('the three new kinds are identities', () => {
  for (const kind of GOAL_KIND_VALUES) {
    assert.equal(mapLegacyKind(kind), kind)
  }
})

test('an unknown kind falls back to kpi rather than throwing', () => {
  // A row written by a future/rogue caller must not crash the migration path.
  assert.equal(mapLegacyKind('not_a_kind'), 'kpi')
})

test('mapLegacyKind output always type-checks as GoalKind', () => {
  const result: GoalKind = mapLegacyKind('mrr')
  assert.equal(result, 'arr')
})
