import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendMutation, hasAppliedMutation, MUTATION_LOG_LIMIT } from '../mutation-log'

test('a fresh log has no applied mutations', () => {
  assert.equal(hasAppliedMutation(null, 'client:1'), false)
  assert.equal(hasAppliedMutation([], 'client:1'), false)
})

test('an appended mutation id is recognized as applied', () => {
  const log = appendMutation([], 'client:1')
  assert.equal(hasAppliedMutation(log, 'client:1'), true)
  assert.equal(hasAppliedMutation(log, 'client:2'), false)
})

test('the log caps at the limit, evicting oldest first', () => {
  let log: string[] = []
  for (let index = 0; index < MUTATION_LOG_LIMIT + 10; index += 1) {
    log = appendMutation(log, `client:${index}`)
  }
  assert.equal(log.length, MUTATION_LOG_LIMIT)
  assert.equal(hasAppliedMutation(log, 'client:0'), false)
  assert.equal(hasAppliedMutation(log, `client:${MUTATION_LOG_LIMIT + 9}`), true)
})

test('malformed stored logs are tolerated, not fatal', () => {
  assert.equal(hasAppliedMutation('garbage', 'client:1'), false)
  assert.equal(hasAppliedMutation({ not: 'an array' }, 'client:1'), false)
  assert.equal(hasAppliedMutation([42, null, 'client:1'], 'client:1'), true)
  assert.deepEqual(appendMutation('garbage', 'client:1'), ['client:1'])
})
