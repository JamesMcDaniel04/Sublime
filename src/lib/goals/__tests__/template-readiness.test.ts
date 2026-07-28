import test from 'node:test'
import assert from 'node:assert/strict'
import { templateIsReady } from '../template-readiness'
import { goalTemplateByKey } from '../goal-templates'

const outcome = goalTemplateByKey('sales-org-quarterly-revenue')!
const action = goalTemplateByKey('sales-org-multithread-open-deals')!

test('an outcome template is ready once a real metric source is connected', () => {
  assert.equal(templateIsReady(outcome, new Set(['stripe']), new Set()), true)
  assert.equal(templateIsReady(outcome, new Set(), new Set()), false)
})

test('manual never makes an outcome template ready', () => {
  // Otherwise every template scores ready and the signal says nothing.
  assert.equal(templateIsReady(outcome, new Set(['manual']), new Set()), false)
})

test('an action template is ready when a curated agent can actually run', () => {
  // sales-multithreading-map needs salesforce + granola to do the work and
  // slack to deliver it — normalizeDelivery folds the channel into required.
  assert.equal(
    templateIsReady(action, new Set(), new Set(['salesforce', 'granola', 'slack'])),
    true,
  )
})

test('a partially connected action template is not ready', () => {
  // The delivery channel is missing, so the agent cannot actually run.
  assert.equal(templateIsReady(action, new Set(), new Set(['salesforce', 'granola'])), false)
  assert.equal(templateIsReady(action, new Set(), new Set(['salesforce'])), false)
})

test('action readiness ignores metric sources entirely', () => {
  assert.equal(templateIsReady(action, new Set(['stripe', 'hubspot']), new Set()), false)
})
