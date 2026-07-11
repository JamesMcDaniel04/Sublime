import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestAnswerMatch,
  renderAgentMemories,
  decideMemoryDedup,
  MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_INJECTION_LIMIT,
} from '../agent-memory'

const vec = (x: number, y: number) => [x, y]

test('bestAnswerMatch picks the closest embedded question above 0.86', () => {
  const candidates = [
    { id: 'm1', question: 'Which region should I focus on?', content: 'EMEA', embedding: vec(1, 0) },
    { id: 'm2', question: 'What is the pipeline threshold?', content: '$50k', embedding: vec(0, 1) },
  ]
  const hit = bestAnswerMatch(vec(0.99, 0.05), 'Which region?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(hit?.content, 'EMEA')
  assert.ok(hit!.score >= MEMORY_SIMILARITY_THRESHOLD)
})

test('bestAnswerMatch returns null below the threshold', () => {
  const candidates = [{ id: 'm1', question: 'Which region?', content: 'EMEA', embedding: vec(1, 0) }]
  assert.equal(bestAnswerMatch(vec(0.5, 0.87), 'unrelated', candidates), null)
})

test('bestAnswerMatch falls back to keyword overlap without vectors', () => {
  const candidates = [
    { id: 'm1', question: 'Which Salesforce region should the report cover?', content: 'EMEA', embedding: null },
  ]
  const hit = bestAnswerMatch(null, 'Which Salesforce region should this cover?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(bestAnswerMatch(null, 'completely different topic entirely', candidates), null)
})

test('renderAgentMemories renders headings, caps, and critique', () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`, kind: 'learning', title: `T${i}`, content: `Learned ${i}`, question: null, score: 1 - i / 10,
  }))
  const block = renderAgentMemories(hits.slice(0, MEMORY_INJECTION_LIMIT), 'Do fewer tool calls next time.')
  assert.match(block, /## What you've learned \(from previous runs\)/)
  assert.match(block, /Learned 0/)
  assert.match(block, /## Notes to self from last run/)
  assert.match(block, /fewer tool calls/)
  assert.equal(renderAgentMemories([], null), '')
  assert.match(renderAgentMemories([], 'note'), /## Notes to self from last run/)
})

// ── decideMemoryDedup ────────────────────────────────────────────────────
// Pure decision extracted from saveAgentMemory's nearest-neighbor dedup-on-
// write, so the dismiss-durability logic (a dismissed match must never flip
// back to open, and never gets shadowed by a fresh insert) is unit-testable
// without a pgvector-backed database.

const NEAR = MEMORY_SIMILARITY_THRESHOLD + 0.01
const FAR = MEMORY_SIMILARITY_THRESHOLD - 0.2

test('decideMemoryDedup: dismissed learning + same sourceRef + near-dup → dedupe (stays dismissed)', () => {
  const decision = decideMemoryDedup({
    kind: 'learning',
    similarity: NEAR,
    match: { status: 'dismissed', sourceRef: 'mcp:conn123' },
    requestSourceRef: 'mcp:conn123',
  })
  assert.equal(decision, 'dedupe')
})

test('decideMemoryDedup: open learning + same sourceRef + near-dup → dedupe (bump, no new row)', () => {
  const decision = decideMemoryDedup({
    kind: 'learning',
    similarity: NEAR,
    match: { status: 'open', sourceRef: 'mcp:conn123' },
    requestSourceRef: 'mcp:conn123',
  })
  assert.equal(decision, 'dedupe')
})

test('decideMemoryDedup: learning near-dup but DIFFERENT sourceRef → insert (never merges across connections)', () => {
  const decision = decideMemoryDedup({
    kind: 'learning',
    similarity: NEAR,
    match: { status: 'open', sourceRef: 'mcp:otherConn' },
    requestSourceRef: 'mcp:conn123',
  })
  assert.equal(decision, 'insert')
})

test('decideMemoryDedup: learning with no requestSourceRef never dedupes (no match to scope against)', () => {
  const decision = decideMemoryDedup({
    kind: 'learning',
    similarity: NEAR,
    match: null,
    requestSourceRef: undefined,
  })
  assert.equal(decision, 'insert')
})

test('decideMemoryDedup: no nearest match at all → insert', () => {
  assert.equal(decideMemoryDedup({ kind: 'learning', similarity: -1, match: null, requestSourceRef: 'mcp:conn123' }), 'insert')
  assert.equal(decideMemoryDedup({ kind: 'suggestion', similarity: -1, match: null }), 'insert')
})

test('decideMemoryDedup: below-threshold similarity → insert even with matching sourceRef', () => {
  const decision = decideMemoryDedup({
    kind: 'learning',
    similarity: FAR,
    match: { status: 'open', sourceRef: 'mcp:conn123' },
    requestSourceRef: 'mcp:conn123',
  })
  assert.equal(decision, 'insert')
})

test('decideMemoryDedup: suggestion dedup is unchanged — no sourceRef scoping required', () => {
  // Suggestions may not carry a sourceRef at all; a near-dup dedupes on
  // kind + status alone, same as before this fix.
  const dismissed = decideMemoryDedup({
    kind: 'suggestion',
    similarity: NEAR,
    match: { status: 'dismissed', sourceRef: null },
  })
  assert.equal(dismissed, 'dedupe')

  const open = decideMemoryDedup({
    kind: 'suggestion',
    similarity: NEAR,
    match: { status: 'open', sourceRef: null },
  })
  assert.equal(open, 'dedupe')

  const belowThreshold = decideMemoryDedup({
    kind: 'suggestion',
    similarity: FAR,
    match: { status: 'open', sourceRef: null },
  })
  assert.equal(belowThreshold, 'insert')
})
