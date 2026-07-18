import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserSuggestions, renderPatternEvidence, suggestionOutcomeLabel } from '@/lib/intelligence/suggest-user-workflows'

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

// Outcome tracking: "accepted" is not the same as USEFUL. The synthesis
// prompt sees what actually happened to past suggestions, so an accepted
// draft that was never published reads as the weak signal it is.
const day = 24 * 60 * 60 * 1000
const now = new Date('2026-07-17T12:00:00Z')
const base = { title: 't', status: 'accepted', kind: 'new_flow', flowId: 'f1', updatedAt: new Date(now.getTime() - 2 * day) }

test('outcome labels: dismissed and enhancements pass through', () => {
  assert.equal(suggestionOutcomeLabel({ ...base, status: 'dismissed' }, null, now), 'dismissed')
  assert.equal(suggestionOutcomeLabel({ ...base, kind: 'enhancement', flowId: null }, null, now), 'accepted')
})

test('outcome labels: an accepted flow that got published counts as adopted', () => {
  assert.equal(suggestionOutcomeLabel(base, { status: 'ACTIVE', publishedGraph: null }, now), 'accepted-and-adopted')
  assert.equal(suggestionOutcomeLabel(base, { status: 'DRAFT', publishedGraph: { nodes: [] } }, now), 'accepted-and-adopted')
})

test('outcome labels: accepted but untouched for 14+ days is a weak signal; deleted is negative', () => {
  const old = { ...base, updatedAt: new Date(now.getTime() - 15 * day) }
  assert.equal(suggestionOutcomeLabel(old, { status: 'DRAFT', publishedGraph: null }, now), 'accepted-but-never-published')
  assert.equal(suggestionOutcomeLabel(base, { status: 'DRAFT', publishedGraph: null }, now), 'accepted')
  assert.equal(suggestionOutcomeLabel(base, null, now), 'accepted-then-deleted')
})

test('evidence lines are fully human-readable — dates and counts, never raw event ids', () => {
  // Evidence-integrity contract: user_events age out at 180 days but the
  // rendered "why this exists" snapshot lives on a suggestion forever. Raw
  // event ids in that snapshot rot into dangling references (and mean nothing
  // to a person anyway) — the snapshot must stand alone.
  const lines = renderPatternEvidence([{
    slug: 'seq:a>>b', kind: 'sequence', summary: 'Runs A then edits B',
    occurrenceCount: 4, firstSeenAt: new Date('2026-06-02T00:00:00Z'), lastSeenAt: new Date('2026-07-10T00:00:00Z'),
    evidence: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
  }])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'Runs A then edits B — observed 4 times between 2026-06-02 and 2026-07-10, most recently 2026-07-10')
  assert.ok(!lines[0].includes('e1'), 'raw event ids must never reach the user-facing snapshot')
})
