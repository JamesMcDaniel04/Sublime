import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLE_LABEL_MAX_CHARS, fallbackRoleLabel, normalizeRoleLabel } from '../role-label'

test('collapses surrounding and internal whitespace, including newlines the model adds', () => {
  assert.equal(normalizeRoleLabel('  Revenue   Analyst \n'), 'Revenue Analyst')
  assert.equal(normalizeRoleLabel('Revenue\nAnalyst'), 'Revenue Analyst')
})

test('title-cases all-lowercase model output', () => {
  assert.equal(normalizeRoleLabel('revenue analyst'), 'Revenue Analyst')
})

// Uppercasing only the first letter would turn 'QA' into 'Qa' and 'GTM' into
// 'Gtm' — the labels most likely to be an acronym are the ones people notice.
test('preserves acronyms instead of mangling them to sentence case', () => {
  assert.equal(normalizeRoleLabel('QA Lead'), 'QA Lead')
  assert.equal(normalizeRoleLabel('GTM Analyst'), 'GTM Analyst')
})

test('strips markdown emphasis and trailing punctuation the model wraps labels in', () => {
  assert.equal(normalizeRoleLabel('**Revenue Analyst**'), 'Revenue Analyst')
  assert.equal(normalizeRoleLabel('Revenue Analyst.'), 'Revenue Analyst')
  assert.equal(normalizeRoleLabel('`Revenue Analyst`'), 'Revenue Analyst')
})

test('strips a decorative emoji rather than rejecting an otherwise good label', () => {
  assert.equal(normalizeRoleLabel('📈 Revenue Analyst'), 'Revenue Analyst')
})

test('rejects three or more words — the tile has room for two', () => {
  assert.equal(normalizeRoleLabel('Chief Revenue Officer'), null)
})

test('rejects an over-long label rather than clipping it mid-word', () => {
  const tooLong = 'Interdepartmental Coordinator'
  assert.ok(tooLong.length > ROLE_LABEL_MAX_CHARS)
  assert.equal(normalizeRoleLabel(tooLong), null)
})

test('rejects empty, whitespace-only, and non-string input', () => {
  assert.equal(normalizeRoleLabel(''), null)
  assert.equal(normalizeRoleLabel('   '), null)
  assert.equal(normalizeRoleLabel(undefined), null)
  assert.equal(normalizeRoleLabel(null), null)
  assert.equal(normalizeRoleLabel(42), null)
})

// The label is derived from user-authored instructions, so a prompt-injected
// payload can reach it. Markup must never survive into a rendered label.
test('rejects markup payloads instead of storing them as a label', () => {
  assert.equal(normalizeRoleLabel('<script>alert(1)</script>'), null)
  assert.equal(normalizeRoleLabel('<img src=x onerror=alert(1)>'), null)
})

test('keeps a hyphenated single word intact', () => {
  assert.equal(normalizeRoleLabel('Go-To-Market'), 'Go-To-Market')
})

test('falls back to the department when no label has been generated yet', () => {
  assert.equal(fallbackRoleLabel('sales'), 'Sales')
  assert.equal(fallbackRoleLabel('engineering'), 'Engineering')
  assert.equal(fallbackRoleLabel('csm'), 'Customer Success')
})

test('falls back to Generalist for the general department and for unknown input', () => {
  assert.equal(fallbackRoleLabel('general'), 'Generalist')
  assert.equal(fallbackRoleLabel(undefined), 'Generalist')
  assert.equal(fallbackRoleLabel('not-a-department'), 'Generalist')
})

test('every fallback label satisfies the same rules generated labels must pass', () => {
  for (const area of ['sales', 'engineering', 'marketing', 'finance', 'csm', 'general', undefined]) {
    const label = fallbackRoleLabel(area)
    assert.equal(normalizeRoleLabel(label), label, `fallback "${label}" would be rejected by normalizeRoleLabel`)
  }
})
