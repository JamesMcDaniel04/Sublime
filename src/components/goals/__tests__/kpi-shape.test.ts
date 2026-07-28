import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FUNNEL_STAGES,
  MIN_FUNNEL_STAGES,
  driverSlot,
  kpiConfigFrom,
  kpiShapeIsReady,
  usableDrivers,
} from '../kpi-shape'
import { kpiRequiredSlots } from '@/lib/goals/composition/rollup-kpi'

test('a driver slot is slugged and prefixed', () => {
  assert.equal(driverSlot('AWS'), 'driver:aws')
  assert.equal(driverSlot('Google Cloud'), 'driver:google-cloud')
  assert.equal(driverSlot('  Data   Dog!!  '), 'driver:data-dog')
})

test('a name that slugs to nothing yields null, not a bare prefix', () => {
  // `driver:` alone would be a meaningless slot the rollup could never read.
  assert.equal(driverSlot('   '), null)
  assert.equal(driverSlot('!!!'), null)
  assert.equal(driverSlot(''), null)
})

test('a driver slot stays inside the create route 64-char bound', () => {
  const slot = driverSlot('x'.repeat(200))!
  assert.ok(slot.length <= 64, `slot was ${slot.length} chars`)
})

test('unusable and duplicate drivers are dropped', () => {
  const usable = usableDrivers([
    { name: 'AWS', weight: '1' },
    { name: '  ', weight: '1' },
    // Slugs to the same slot as the first — the create route rejects the whole
    // request when two components share a slot, so the UI must not send both.
    { name: 'aws!', weight: '2' },
    { name: 'GCP', weight: '3' },
  ])
  assert.deepEqual(
    usable.map((entry) => entry.slot),
    ['driver:aws', 'driver:gcp'],
  )
})

test('funnel config clamps the stage count to the supported range', () => {
  assert.equal(kpiConfigFrom('funnel', 1, []).stages, MIN_FUNNEL_STAGES)
  assert.equal(kpiConfigFrom('funnel', 99, []).stages, MAX_FUNNEL_STAGES)
  assert.equal(kpiConfigFrom('funnel', 4, []).stages, 4)
})

test('weighted_sum config maps each usable driver to its weight', () => {
  const config = kpiConfigFrom('weighted_sum', 0, [
    { name: 'AWS', weight: '2' },
    { name: 'GCP', weight: '3' },
  ])
  assert.deepEqual(config.weights, { 'driver:aws': 2, 'driver:gcp': 3 })
})

test('a blank or unparseable weight counts once rather than zero', () => {
  // A silent zero would drop the driver from the sum while still demanding it
  // be bound — the worst of both.
  const config = kpiConfigFrom('weighted_sum', 0, [
    { name: 'AWS', weight: '' },
    { name: 'GCP', weight: 'abc' },
    { name: 'Azure', weight: '0' },
  ])
  assert.deepEqual(config.weights, {
    'driver:aws': 1,
    'driver:gcp': 1,
    'driver:azure': 1,
  })
})

test('ratio needs no extra config', () => {
  assert.deepEqual(kpiConfigFrom('ratio', 3, [{ name: 'x', weight: '1' }]), {})
})

test('THE FIX: a configured shape always yields slots to bind', () => {
  // The regression this file exists for: selecting weighted_sum used to yield
  // zero slots, so the user picked an option that rendered nothing.
  for (const [shape, stages, drivers] of [
    ['ratio', 0, []],
    ['funnel', 4, []],
    ['weighted_sum', 0, [{ name: 'AWS', weight: '1' }]],
  ] as const) {
    const config = kpiConfigFrom(shape, stages, [...drivers])
    const slots = kpiRequiredSlots(shape, config)
    assert.ok(slots.length > 0, `${shape} produced no slots`)
  }
})

test('readiness reflects whether anything can be bound', () => {
  assert.equal(kpiShapeIsReady('ratio', 0, []), true)
  assert.equal(kpiShapeIsReady('funnel', 3, []), true)
  assert.equal(kpiShapeIsReady('weighted_sum', 0, []), false)
  assert.equal(kpiShapeIsReady('weighted_sum', 0, [{ name: '  ', weight: '1' }]), false)
  assert.equal(kpiShapeIsReady('weighted_sum', 0, [{ name: 'AWS', weight: '1' }]), true)
})

test('funnel stage slots match the declared count end to end', () => {
  const config = kpiConfigFrom('funnel', 5, [])
  assert.deepEqual(kpiRequiredSlots('funnel', config), [
    'stage:1',
    'stage:2',
    'stage:3',
    'stage:4',
    'stage:5',
  ])
})
