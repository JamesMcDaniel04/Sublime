/**
 * Every key on the data node must be accounted for.
 *
 * This is the test that makes the session's recurring bug impossible, not the
 * manifest itself. Three fields shipped that the executor reads and no panel
 * rendered — `data.count`, `data.field`, `splitItems` — because nothing forced
 * anyone to say where a new schema key gets edited.
 *
 * The pattern is borrowed from route-permissions.test.ts, which already works
 * this way for API routes: every route either goes through
 * withAuthenticatedApi or is listed with the mechanism it uses instead. Nobody
 * adds an unauthenticated route by accident. Nobody should be able to add an
 * uneditable parameter by accident either.
 *
 * Adding a key to `dataNode` in graph.ts fails this test until it is either
 * declared in DATA_PARAMS, or listed below with a reason.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DATA_PARAMS } from '../data-params'
import { dataNodeDataKeys } from '../graph'

/**
 * Keys edited by a COMPOSITE editor rather than a single control. Scalar
 * fields belong in the manifest; these are rows-with-add-and-remove, which
 * n8n models as fixedCollection and which stay bespoke JSX on purpose.
 */
const BESPOKE_EDITORS: ReadonlyArray<{ key: string; editor: string }> = [
  { key: 'clauses', editor: 'clause rows (filterArray) — shared with ConditionBody' },
  { key: 'fields', editor: 'name/value rows (select, aggregate)' },
  { key: 'input', editor: 'TokenTextEditor — needs token insertion + FieldPreview' },
]

/**
 * Keys that are deliberately NOT user-editable in the params pane. Each needs
 * a reason, because "it has no control" is exactly the bug this file exists to
 * catch — the entry is the difference between a decision and an oversight.
 */
const NOT_USER_FACING: ReadonlyArray<{ key: string; reason: string }> = [
  { key: 'op', reason: 'the op selector itself — it is what the manifest is conditioned ON' },
  { key: 'label', reason: 'edited in the step header, not the params pane' },
  { key: 'note', reason: 'edited in StepSettingsFooter, shared by every node type' },
  { key: 'disabled', reason: 'advanced-params manifest (Execution on/off)' },
  { key: 'forEachItem', reason: 'advanced-params manifest (per-item fan-out)' },
  { key: 'excludeFromContext', reason: 'advanced-params manifest (agent context)' },
]

test('every data-node key is declared, given a bespoke editor, or excluded with a reason', () => {
  const declared = new Set(DATA_PARAMS.map((spec) => spec.key))
  const bespoke = new Set(BESPOKE_EDITORS.map((entry) => entry.key))
  const excluded = new Set(NOT_USER_FACING.map((entry) => entry.key))

  const unaccounted = dataNodeDataKeys().filter(
    (key) => !declared.has(key) && !bespoke.has(key) && !excluded.has(key),
  )

  assert.deepEqual(
    unaccounted,
    [],
    `data-node key(s) with no way to edit them and no recorded reason: ${unaccounted.join(', ')}. ` +
      'Add a DATA_PARAMS spec, or list the key in this test with why.',
  )
})

// The inverse: a manifest entry for a key the schema does not have would be a
// control that silently writes a field nothing reads.
test('the manifest declares no key the schema would strip', () => {
  const schemaKeys = new Set(dataNodeDataKeys())
  const orphans = DATA_PARAMS.map((spec) => spec.key).filter((key) => !schemaKeys.has(key))
  assert.deepEqual(orphans, [], `DATA_PARAMS declares key(s) absent from dataNode: ${orphans.join(', ')}`)
})

test('every exclusion carries a non-trivial reason', () => {
  for (const entry of NOT_USER_FACING) {
    assert.ok(entry.reason.length > 15, `${entry.key} needs a real reason, got "${entry.reason}"`)
  }
})

// A number spec that does not mirror the executor's clamp lets a user save a
// value the run silently rewrites.
test('number params declare their bounds', () => {
  for (const spec of DATA_PARAMS.filter((entry) => entry.control === 'number')) {
    assert.equal(typeof spec.min, 'number', `${spec.key} has no min`)
    assert.equal(typeof spec.max, 'number', `${spec.key} has no max`)
  }
})

test('every select param declares its options', () => {
  for (const spec of DATA_PARAMS.filter((entry) => entry.control === 'select')) {
    assert.ok(spec.options?.length, `${spec.key} is a select with no options`)
  }
})
