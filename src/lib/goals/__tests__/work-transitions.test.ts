import test from 'node:test'
import assert from 'node:assert/strict'
import { refusePatch } from '../work-transitions'

const pending = { disposition: 'pending', outcome: 'unknown' } as const
const used = { disposition: 'used', outcome: 'unknown' } as const
const edited = { disposition: 'edited', outcome: 'unknown' } as const
const skipped = { disposition: 'skipped', outcome: 'unknown' } as const

test('a pending item accepts any disposition', () => {
  assert.equal(refusePatch(pending, { disposition: 'used' }), null)
  assert.equal(refusePatch(pending, { disposition: 'edited' }), null)
  assert.equal(refusePatch(pending, { disposition: 'skipped' }), null)
})

test('outcome may be set on used or edited items', () => {
  assert.equal(refusePatch(used, { outcome: 'worked' }), null)
  assert.equal(refusePatch(edited, { outcome: 'no_response' }), null)
})

test('outcome on a skipped item is refused — it was never sent', () => {
  // Allowing this would put an item in the outcome numerator that was never
  // in its denominator, making the process look better or worse than it was.
  const refusal = refusePatch(skipped, { outcome: 'worked' })
  assert.ok(refusal, 'must be refused')
  assert.match(refusal, /skipped/i)
})

test('outcome on a pending item is refused — nobody has used it yet', () => {
  assert.ok(refusePatch(pending, { outcome: 'worked' }))
})

test('a skipped item cannot be un-skipped', () => {
  const refusal = refusePatch(skipped, { disposition: 'used' })
  assert.ok(refusal, 'skipped is terminal')
  assert.match(refusal, /terminal|skipped/i)
})

test('a dispositioned item may still move between used and edited', () => {
  // Editing something you already copied is normal and must not be refused.
  assert.equal(refusePatch(used, { disposition: 'edited' }), null)
})

test('setting disposition and outcome in one patch is judged on the landing state', () => {
  // Copy-then-mark-worked in a single call must succeed…
  assert.equal(refusePatch(pending, { disposition: 'used', outcome: 'worked' }), null)
  // …but skip-and-mark-worked must not.
  assert.ok(refusePatch(pending, { disposition: 'skipped', outcome: 'worked' }))
})

test('assignee, body and skipReason are always allowed', () => {
  assert.equal(refusePatch(skipped, { assigneeUserId: null }), null)
  assert.equal(refusePatch(pending, { body: 'redrafted' }), null)
  assert.equal(refusePatch(pending, { skipReason: 'too early' }), null)
})

test('an unknown disposition or outcome value is refused', () => {
  assert.ok(refusePatch(pending, { disposition: 'sent' as never }))
  assert.ok(refusePatch(used, { outcome: 'great' as never }))
})
