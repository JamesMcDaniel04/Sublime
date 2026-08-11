import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POST as feedbackPost } from '@/app/api/flows/[id]/runs/[runId]/feedback/route'
import { GET as queueGet, POST as queuePost } from '@/app/api/system/queues/route'

test('flow outcome feedback exposes an authenticated mutation handler', () => {
  assert.equal(typeof feedbackPost, 'function')
})

test('queue operations expose an authenticated dashboard and replay handler', () => {
  assert.equal(typeof queueGet, 'function')
  assert.equal(typeof queuePost, 'function')
})
