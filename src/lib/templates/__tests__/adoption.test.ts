import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptionScore, sortByAdoption, templateKeyOfContext } from '../adoption'

test('adoptionScore: surviving automation dominates raw deploy clicks', () => {
  // 3 deploys, all deleted < 1 deploy that survived.
  assert.ok(adoptionScore({ deploys: 1, surviving: 1 }) > adoptionScore({ deploys: 3, surviving: 0 }))
  assert.equal(adoptionScore({ deploys: 0, surviving: 0 }), 0)
})

test('templateKeyOfContext: seed and db keys, null for anything else', () => {
  assert.equal(templateKeyOfContext({ seedKey: 'weekly-pipeline' }), 'seed:weekly-pipeline')
  assert.equal(templateKeyOfContext({ templateId: 'tpl_1' }), 'db:tpl_1')
  assert.equal(templateKeyOfContext({ seedKey: 'a', templateId: 'b' }), 'seed:a', 'seed wins when both present')
  assert.equal(templateKeyOfContext({}), null)
  assert.equal(templateKeyOfContext(null), null)
  assert.equal(templateKeyOfContext('string'), null)
})

test('sortByAdoption: stable desc by score, identity for unscored items', () => {
  const items = [
    { seedKey: 'a' }, { seedKey: 'b' }, { seedKey: 'c' }, { seedKey: 'd' },
  ]
  const scores = {
    'seed:c': { deploys: 2, surviving: 2 },
    'seed:b': { deploys: 1, surviving: 0 },
  }
  const sorted = sortByAdoption(items, (t) => `seed:${t.seedKey}`, scores)
  assert.deepEqual(sorted.map((t) => t.seedKey), ['c', 'b', 'a', 'd'], 'scored first, unscored keep input order')
  // No scores at all → identity.
  const identity = sortByAdoption(items, (t) => `seed:${t.seedKey}`, {})
  assert.deepEqual(identity.map((t) => t.seedKey), ['a', 'b', 'c', 'd'])
})
