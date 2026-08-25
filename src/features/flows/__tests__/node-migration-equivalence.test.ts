/**
 * A migration must not change what a flow does.
 *
 * This is the property that makes node versioning safe rather than dangerous.
 * A migration rewrites the configuration of a node inside somebody's working
 * flow; if the rewritten node evaluates differently from the original for even
 * one input, the migration silently broke their automation.
 *
 * So this tests the MIGRATION against the REAL evaluator, over every shape a
 * legacy condition can take — rather than against a description of what the
 * evaluator is believed to do.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evalCondition, type FlowContext } from '../context'
import { migrateNodeData } from '@/lib/flows/node-versions'

const ctx: FlowContext = {
  trigger: { input: null },
  step: {},
  variables: { status: 'done', count: 3, empty: '' },
}

/** Every legacy condition shape worth worrying about, including partial ones. */
const LEGACY_SHAPES: Record<string, unknown>[] = [
  { left: '{{var.status}}', op: 'eq', right: 'done' },
  { left: '{{var.status}}', op: 'eq', right: 'other' },
  { left: '{{var.status}}', op: 'ne', right: 'done' },
  { left: '{{var.count}}', op: 'gt', right: '1' },
  { left: '{{var.count}}', op: 'lt', right: '1' },
  { left: '{{var.empty}}', op: 'eq', right: '' },
  { left: '{{var.missing}}', op: 'eq', right: '' },
  { left: '{{var.status}}', op: 'contains', right: 'on' },
  // Partial configurations — a half-configured node is extremely common in a
  // real workspace, and it is where an "obvious" migration goes wrong.
  {},
  { left: '{{var.status}}' },
  { left: '{{var.status}}', op: 'eq' },
  // The discriminating cases: a missing `right` only changes the answer when
  // the comparison against '' would be TRUE. The legacy evaluator refuses to
  // build a clause at all when right is undefined, so it always says false;
  // a migration that defaults right to '' would say true.
  { left: '{{var.empty}}', op: 'eq' },
  { left: '{{var.missing}}', op: 'eq' },
  { left: '', op: 'eq' },
  { op: 'eq', right: 'done' },
  { right: 'done' },
  { left: '', op: 'eq', right: '' },
  // Already using clauses at v1.
  { clauses: [{ left: '{{var.status}}', op: 'eq', right: 'done' }] },
  { clauses: [{ left: '{{var.status}}', op: 'eq', right: 'done' }, { left: '{{var.count}}', op: 'gt', right: '1' }], match: 'any' },
  { clauses: [{ left: '{{var.status}}', op: 'eq', right: 'no' }, { left: '{{var.count}}', op: 'gt', right: '1' }], match: 'all' },
  // Both shapes present at once.
  { clauses: [{ left: '{{var.count}}', op: 'gt', right: '1' }], left: '{{var.status}}', op: 'eq', right: 'nope' },
]

test('every legacy condition evaluates the same after migration', () => {
  for (const shape of LEGACY_SHAPES) {
    const before = evalCondition(shape as never, ctx)
    const after = evalCondition(migrateNodeData('condition', 1, 2, shape) as never, ctx)
    assert.equal(
      after,
      before,
      `migration changed the result for ${JSON.stringify(shape)}: ${before} became ${after}`,
    )
  }
})

test('the match mode still applies after migration', () => {
  const any = { clauses: [{ left: '{{var.status}}', op: 'eq', right: 'no' }, { left: '{{var.count}}', op: 'gt', right: '1' }], match: 'any' }
  const migrated = migrateNodeData('condition', 1, 2, any)
  assert.equal(evalCondition(migrated as never, ctx), true)
  assert.equal(evalCondition({ ...migrated, match: 'all' } as never, ctx), false)
})

// After migrating, the evaluator must no longer need the legacy branch to
// produce the right answer — that is what lets the branch eventually go.
test('a migrated node evaluates without relying on the legacy fields', () => {
  const migrated = migrateNodeData('condition', 1, 2, { left: '{{var.status}}', op: 'eq', right: 'done' })
  assert.equal('left' in migrated, false)
  assert.equal(evalCondition(migrated as never, ctx), true)
})
