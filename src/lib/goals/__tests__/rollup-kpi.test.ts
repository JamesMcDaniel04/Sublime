import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kpiRequiredSlots, rollupKpi } from '../composition/rollup-kpi'

test('funnel required slots follow the declared stage count', () => {
  assert.deepEqual(kpiRequiredSlots('funnel', { stages: 3 }), [
    'stage:1',
    'stage:2',
    'stage:3',
  ])
})

test('ratio required slots are numerator and denominator', () => {
  assert.deepEqual(kpiRequiredSlots('ratio', {}), ['numerator', 'denominator'])
})

test('weighted_sum required slots come from the weight keys', () => {
  assert.deepEqual(
    kpiRequiredSlots('weighted_sum', {
      weights: { 'driver:aws': 1, 'driver:gcp': 2 },
    }).sort(),
    ['driver:aws', 'driver:gcp'],
  )
})

test('funnel derives the final stage and per-stage conversions', () => {
  const r = rollupKpi(
    'funnel',
    new Map([
      ['stage:1', 1000],
      ['stage:2', 250],
      ['stage:3', 50],
    ]),
    { stages: 3 },
  )
  assert.equal(r.derived, 50)
  assert.equal(r.stageConversions?.length, 2)
  assert.ok(Math.abs((r.stageConversions?.[0].rate ?? 0) - 0.25) < 1e-9)
  assert.ok(Math.abs((r.stageConversions?.[1].rate ?? 0) - 0.2) < 1e-9)
})

test('a zero upstream stage yields a null conversion, not Infinity', () => {
  const r = rollupKpi(
    'funnel',
    new Map([
      ['stage:1', 0],
      ['stage:2', 0],
    ]),
    { stages: 2 },
  )
  assert.equal(r.stageConversions?.[0].rate, null)
})

test('a missing funnel stage yields derived null', () => {
  const r = rollupKpi('funnel', new Map([['stage:1', 1000]]), { stages: 2 })
  assert.equal(r.derived, null)
  assert.deepEqual(r.missing, ['stage:2'])
})

test('ratio divides numerator by denominator', () => {
  const r = rollupKpi(
    'ratio',
    new Map([
      ['numerator', 42],
      ['denominator', 168],
    ]),
    {},
  )
  assert.ok(Math.abs((r.derived ?? 0) - 0.25) < 1e-9)
})

test('a zero denominator yields derived null', () => {
  const r = rollupKpi(
    'ratio',
    new Map([
      ['numerator', 42],
      ['denominator', 0],
    ]),
    {},
  )
  assert.equal(r.derived, null)
})

test('weighted_sum multiplies each driver by its weight', () => {
  const r = rollupKpi(
    'weighted_sum',
    new Map([
      ['driver:aws', 100],
      ['driver:gcp', 50],
    ]),
    { weights: { 'driver:aws': 1, 'driver:gcp': 2 } },
  )
  assert.equal(r.derived, 100 * 1 + 50 * 2)
})

test('weighted_sum reports each driver share of the total', () => {
  const r = rollupKpi(
    'weighted_sum',
    new Map([
      ['driver:aws', 100],
      ['driver:gcp', 100],
    ]),
    { weights: { 'driver:aws': 1, 'driver:gcp': 3 } },
  )
  const aws = r.driverShares?.find((d) => d.slot === 'driver:aws')
  assert.ok(Math.abs((aws?.share ?? 0) - 0.25) < 1e-9)
})

test('driver shares are null when the weighted total is zero', () => {
  const r = rollupKpi('weighted_sum', new Map([['driver:aws', 0]]), {
    weights: { 'driver:aws': 1 },
  })
  assert.equal(r.driverShares?.[0].share, null)
})

test('shape-irrelevant derived collections are null, not empty arrays', () => {
  // An empty array reads as "computed, found none"; null reads as "n/a here".
  const ratioRollup = rollupKpi(
    'ratio',
    new Map([
      ['numerator', 1],
      ['denominator', 2],
    ]),
    {},
  )
  assert.equal(ratioRollup.stageConversions, null)
  assert.equal(ratioRollup.driverShares, null)
})
