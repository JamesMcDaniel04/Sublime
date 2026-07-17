import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserSuggestions, renderPatternEvidence } from '@/lib/intelligence/suggest-user-workflows'

const valid = new Set(['seq:a>>b', 'routine:x:1'])

test('valid new_flow suggestion with cited slugs parses', () => {
  const parsed = parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Automate Monday review', description: 'd', flowPrompt: 'build it', sourcePatternSlugs: ['seq:a>>b'] },
  }), valid)
  assert.ok(parsed)
  assert.equal(parsed.kind, 'new_flow')
  assert.deepEqual(parsed.sourcePatternSlugs, ['seq:a>>b'])
})

test('uncited or invalid-slug suggestions are rejected — no evidence, no suggestion', () => {
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', flowPrompt: 'p', sourcePatternSlugs: ['made-up'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', flowPrompt: 'p', sourcePatternSlugs: [] },
  }), valid), null)
})

test('enhancement requires target; new_flow requires flowPrompt; null passes through', () => {
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'enhancement', title: 't', description: 'd', sourcePatternSlugs: ['routine:x:1'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', sourcePatternSlugs: ['routine:x:1'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({ suggestion: null }), valid), null)
  assert.equal(parseUserSuggestions('garbage', valid), null)
})

test('evidence lines carry counts, dates, and event ids', () => {
  const lines = renderPatternEvidence([{
    slug: 'seq:a>>b', kind: 'sequence', summary: 'Runs A then edits B',
    occurrenceCount: 4, firstSeenAt: new Date('2026-06-02T00:00:00Z'), lastSeenAt: new Date('2026-07-10T00:00:00Z'),
    evidence: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
  }])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'Runs A then edits B — 4 times between 2026-06-02 and 2026-07-10 (events: e1, e2, e3, e4, e5)')
})
