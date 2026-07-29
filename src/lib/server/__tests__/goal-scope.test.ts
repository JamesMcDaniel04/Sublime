import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalReadWhere, ALL_SCOPE } from '../goal-scope'

test('goalReadWhere admits org goals and the actors own personal goals', () => {
  const where = goalReadWhere('user_1')
  assert.deepEqual(where, { OR: [{ ownerUserId: null }, { ownerUserId: 'user_1' }] })
})

test('the all-scope sentinel is the literal "all"', () => {
  // The routing layer relies on this exact value; a rename would silently
  // turn /g/all/flows into a goal lookup for a goal named "all".
  assert.equal(ALL_SCOPE, 'all')
})
