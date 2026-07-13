import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTemplateForRoute, templateRouteIdCandidates } from '@/lib/templates/route-id'

const templates = [
  { id: 'db-template-1', name: 'Stored template' },
  { id: 'seed:sales-daily-digest', seedKey: 'sales-daily-digest', name: 'Seed template' },
]

test('stored template ids continue to resolve exactly', () => {
  assert.equal(findTemplateForRoute(templates, 'db-template-1')?.name, 'Stored template')
})

test('seed ids resolve when the colon is URL-encoded', () => {
  assert.equal(findTemplateForRoute(templates, 'seed%3Asales-daily-digest')?.name, 'Seed template')
})

test('seed ids tolerate a double-encoded redirect segment', () => {
  assert.equal(findTemplateForRoute(templates, 'seed%253Asales-daily-digest')?.name, 'Seed template')
})

test('a bare seed key resolves through stable seedKey metadata', () => {
  assert.equal(findTemplateForRoute(templates, 'sales-daily-digest')?.name, 'Seed template')
})

test('malformed escapes do not throw or match an unrelated template', () => {
  assert.deepEqual(templateRouteIdCandidates('seed%ZZbroken'), ['seed%ZZbroken'])
  assert.equal(findTemplateForRoute(templates, 'seed%ZZbroken'), undefined)
})
