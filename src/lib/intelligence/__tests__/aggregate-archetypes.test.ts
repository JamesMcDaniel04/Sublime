import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeOrgShapes,
  aggregateShapes,
  shapeSignature,
  MIN_ARCHETYPE_ORGS,
  MIN_SHAPE_RUNS,
} from '@/lib/intelligence/aggregate-archetypes'

test('shapeSignature: providers sorted and joined, trigger appended', () => {
  assert.equal(shapeSignature(['slack', 'asana'], 'schedule'), 'asana+slack:schedule')
})

test('computeOrgShapes: qualifying flows only — needs runs and providers; trigger normalized', () => {
  const shapes = computeOrgShapes([
    { trigger: { type: 'schedule' }, providers: ['slack', 'asana'], successfulRuns: MIN_SHAPE_RUNS },
    { trigger: { type: 'signal' }, providers: ['github'], successfulRuns: 10 },
    { trigger: null, providers: ['gmail'], successfulRuns: 5 }, // no type → manual
    { trigger: { type: 'schedule' }, providers: ['slack'], successfulRuns: MIN_SHAPE_RUNS - 1 }, // too few runs
    { trigger: { type: 'schedule' }, providers: [], successfulRuns: 9 }, // no providers resolved
  ])
  assert.deepEqual(
    [...shapes.keys()].sort(),
    ['asana+slack:schedule', 'github:signal', 'gmail:manual'],
  )
})

test('computeOrgShapes: duplicate shapes within one org collapse to one', () => {
  const shapes = computeOrgShapes([
    { trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 5 },
    { trigger: { type: 'schedule' }, providers: ['slack', 'asana'], successfulRuns: 8 },
  ])
  assert.equal(shapes.size, 1)
  assert.equal(shapes.get('asana+slack:schedule')?.flowCount, 2)
})

test('aggregateShapes: k-anonymity — shapes below the org floor never surface', () => {
  const below = Array.from({ length: MIN_ARCHETYPE_ORGS - 1 }, () =>
    computeOrgShapes([{ trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 5 }]),
  )
  assert.equal(aggregateShapes(below).length, 0)

  const at = Array.from({ length: MIN_ARCHETYPE_ORGS }, () =>
    computeOrgShapes([{ trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 5 }]),
  )
  const rows = aggregateShapes(at)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].signature, 'asana+slack:schedule')
  assert.equal(rows[0].orgCount, MIN_ARCHETYPE_ORGS)
  assert.equal(rows[0].flowCount, MIN_ARCHETYPE_ORGS)
  assert.deepEqual(rows[0].providers, ['asana', 'slack'])
  assert.equal(rows[0].triggerType, 'schedule')
})

test('aggregateShapes: an org contributes each shape to orgCount at most once', () => {
  const manyFlowsOneOrg = computeOrgShapes([
    { trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 5 },
    { trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 7 },
  ])
  const others = Array.from({ length: MIN_ARCHETYPE_ORGS - 1 }, () =>
    computeOrgShapes([{ trigger: { type: 'schedule' }, providers: ['asana', 'slack'], successfulRuns: 5 }]),
  )
  const rows = aggregateShapes([manyFlowsOneOrg, ...others])
  assert.equal(rows[0].orgCount, MIN_ARCHETYPE_ORGS)
  assert.equal(rows[0].flowCount, MIN_ARCHETYPE_ORGS + 1)
})

test('shouldRunArchetypeSweep: exactly the [04:00, 04:15) UTC window', async () => {
  const { shouldRunArchetypeSweep } = await import('@/lib/intelligence/aggregate-archetypes')
  assert.equal(shouldRunArchetypeSweep(new Date('2026-07-18T03:59:59Z')), false)
  assert.equal(shouldRunArchetypeSweep(new Date('2026-07-18T04:00:00Z')), true)
  assert.equal(shouldRunArchetypeSweep(new Date('2026-07-18T04:14:59Z')), true)
  assert.equal(shouldRunArchetypeSweep(new Date('2026-07-18T04:15:00Z')), false)
  assert.equal(shouldRunArchetypeSweep(new Date('2026-07-18T16:05:00Z')), false)
})
