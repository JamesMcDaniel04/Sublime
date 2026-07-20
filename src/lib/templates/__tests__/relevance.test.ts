import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingIntegrations, tierForTemplate, connectedSlugSet, sortByReadiness, sortByPersonaFit } from '../relevance'

test('ready when all required are connected (or none required)', () => {
  const connected = new Set(['salesforce', 'slack'])
  assert.equal(tierForTemplate(['salesforce'], connected), 'ready')
  assert.equal(tierForTemplate([], connected), 'ready')
  assert.equal(tierForTemplate(['github'], connected), 'connect')
})

test('missingIntegrations returns only the unmet required slugs (canonicalized both sides)', () => {
  assert.deepEqual(missingIntegrations(['github', 'slack'], new Set(['Slack'])), ['github'])
})

test('connectedSlugSet canonicalizes available-tools chips and drops disconnected', () => {
  const set = connectedSlugSet([
    { key: 'Slack', connected: true },
    { key: 'HTTP API', connected: true },
    { label: 'GitHub', connected: false },
  ])
  assert.ok(set.has('slack') && set.has('http'))
  assert.ok(!set.has('github'))
})

test('sortByReadiness is stable and NEVER drops items (ready first)', () => {
  const items = [
    { seedKey: 'a', requiredIntegrations: ['github'] },
    { seedKey: 'b', requiredIntegrations: [] },
    { seedKey: 'c', requiredIntegrations: ['github'] },
    { seedKey: 'd', requiredIntegrations: [] },
  ]
  const out = sortByReadiness(items, new Set<string>()).map((i) => i.seedKey)
  assert.deepEqual(out, ['b', 'd', 'a', 'c'])
  assert.equal(out.length, items.length)
})

test('sortByPersonaFit boosts department overlap, is stable on ties, identity without weights', () => {
  const items = [
    { id: 'a', departments: ['marketing'] },
    { id: 'b', departments: ['engineering'] },
    { id: 'c', departments: ['engineering', 'sales'] },
    { id: 'd', departments: [] as string[] },
  ]
  const weights = { engineering: 0.7, sales: 0.2, marketing: 0.1 }
  assert.deepEqual(sortByPersonaFit(items, weights).map((i) => i.id), ['c', 'b', 'a', 'd'])
  assert.deepEqual(sortByPersonaFit(items, null).map((i) => i.id), ['a', 'b', 'c', 'd'])
  const tied = [{ id: 'x', departments: ['sales'] }, { id: 'y', departments: ['sales'] }]
  assert.deepEqual(sortByPersonaFit(tied, weights).map((i) => i.id), ['x', 'y'])
})
