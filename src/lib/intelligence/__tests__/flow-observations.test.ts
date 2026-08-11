import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowObservationErrorClass } from '../flow-observations'

test('flow observations normalize failures without retaining provider payloads', () => {
  assert.equal(flowObservationErrorClass('HTTP request timed out after 30s'), 'timeout')
  assert.equal(flowObservationErrorClass('HTTP 429: configured for retry'), 'rate_limit')
  assert.equal(flowObservationErrorClass('The prior send may have completed at the provider'), 'ambiguous_side_effect')
  assert.equal(flowObservationErrorClass('401 Unauthorized'), 'authorization')
  assert.equal(flowObservationErrorClass(null), null)
})
