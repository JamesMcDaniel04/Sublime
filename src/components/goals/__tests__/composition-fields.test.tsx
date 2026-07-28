import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SLOT_HINTS, SLOT_LABELS, slotLabel, slotsForKind } from '../slot-labels'

test('ARR offers the four movements as required', () => {
  const required = slotsForKind('arr')
    .filter((entry) => entry.required)
    .map((entry) => entry.slot)
  assert.deepEqual(required.sort(), [
    'churned_arr',
    'contraction_arr',
    'expansion_arr',
    'new_arr',
  ])
})

test('ARR also offers the optional customer-count slots', () => {
  const optional = slotsForKind('arr').filter((entry) => !entry.required)
  assert.deepEqual(optional.map((entry) => entry.slot).sort(), [
    'customers_churned',
    'customers_start',
  ])
})

test('quota offers only optional leading indicators', () => {
  const slots = slotsForKind('quota')
  assert.ok(slots.length > 0)
  assert.ok(slots.every((entry) => !entry.required))
})

test('KPI offers nothing until a shape is declared', () => {
  assert.deepEqual(slotsForKind('kpi'), [])
})

test('a KPI funnel offers one slot per declared stage', () => {
  assert.deepEqual(
    slotsForKind('kpi', 'funnel', 3).map((entry) => entry.slot),
    ['stage:1', 'stage:2', 'stage:3'],
  )
})

test('a KPI ratio offers numerator and denominator, both required', () => {
  const slots = slotsForKind('kpi', 'ratio')
  assert.deepEqual(
    slots.map((entry) => entry.slot),
    ['numerator', 'denominator'],
  )
  assert.ok(slots.every((entry) => entry.required))
})

test('every offered slot has human copy', () => {
  for (const kind of ['arr', 'quota'] as const) {
    for (const entry of slotsForKind(kind)) {
      assert.ok(SLOT_LABELS[entry.slot], `${entry.slot} has no label`)
    }
  }
  for (const entry of slotsForKind('kpi', 'ratio')) {
    assert.ok(SLOT_LABELS[entry.slot], `${entry.slot} has no label`)
  }
})

test('every ARR and quota slot explains itself', () => {
  // A driver the user cannot distinguish from its neighbour will be mis-bound,
  // and a mis-bound driver silently fails reconciliation.
  for (const kind of ['arr', 'quota'] as const) {
    for (const entry of slotsForKind(kind)) {
      assert.ok(SLOT_HINTS[entry.slot], `${entry.slot} has no hint`)
    }
  }
})

test('slotLabel falls back to the raw slot rather than rendering blank', () => {
  // A slot from a future vocabulary must still render as something.
  assert.equal(slotLabel('some_unknown_slot'), 'some_unknown_slot')
  assert.equal(slotLabel('new_arr'), 'New ARR')
})

test('driver and stage slots get readable labels, not raw keys', () => {
  // These slots are generated, so they have no entry in SLOT_LABELS — without
  // the fallbacks the UI would render 'driver:data-dog' at the user.
  assert.equal(slotLabel('driver:data-dog'), 'Data dog')
  assert.equal(slotLabel('driver:aws'), 'Aws')
  assert.equal(slotLabel('stage:2'), 'Stage 2')
})

test('weighted_sum slots follow the declared drivers', () => {
  const slots = slotsForKind('kpi', 'weighted_sum', undefined, {
    'driver:aws': 1,
    'driver:gcp': 2,
  })
  assert.deepEqual(
    slots.map((entry) => entry.slot).sort(),
    ['driver:aws', 'driver:gcp'],
  )
  assert.ok(slots.every((entry) => entry.required))
})
