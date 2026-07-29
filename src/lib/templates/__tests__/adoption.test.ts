import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptionScore,
  loadTemplateAdoptionScores,
  sortByAdoption,
  templateKeyOfContext,
} from '../adoption'

test('loadTemplateAdoptionScores reads the k-anonymous aggregate table', async () => {
  const db = {
    templateAdoption: {
      findMany: async () => [
        { templateKey: 'seed:a', deploys: 9, surviving: 4 },
        { templateKey: 'db:tpl_1', deploys: 3, surviving: 0 },
      ],
    },
  }
  assert.deepEqual(await loadTemplateAdoptionScores(db as never), {
    'seed:a': { deploys: 9, surviving: 4 },
    'db:tpl_1': { deploys: 3, surviving: 0 },
  })
})

test('loadTemplateAdoptionScores degrades to an empty map instead of throwing', async () => {
  const db = {
    templateAdoption: {
      findMany: async () => {
        throw new Error('table missing')
      },
    },
  }
  assert.deepEqual(await loadTemplateAdoptionScores(db as never), {})
})

test('loadTemplateAdoptionScores sources scores from the aggregate, not the ledger', async () => {
  // The whole point of the aggregate table: no un-floored ledger read can
  // reach the request path again. Asserting the aggregate was queried (rather
  // than that the ledger threw) is what makes this fail if the read regresses,
  // since the loader swallows errors by contract.
  let readAggregate = false
  const db = {
    templateAdoption: {
      findMany: async () => {
        readAggregate = true
        return []
      },
    },
    userEvent: {
      findMany: async () => {
        throw new Error('user_events must not be read here')
      },
    },
  }
  assert.deepEqual(await loadTemplateAdoptionScores(db as never), {})
  assert.equal(readAggregate, true, 'must query template_adoptions')
})

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
