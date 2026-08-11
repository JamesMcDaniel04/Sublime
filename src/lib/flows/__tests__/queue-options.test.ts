import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowJobOptions } from '../queue-options'

test('flowJobOptions uses the immutable outbox id for every dispatch', () => {
  const opts = flowJobOptions('outbox-1')
  assert.equal(opts.jobId, 'flow-outbox-1')
  assert.equal(opts.attempts, 1)
})
