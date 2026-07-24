/**
 * Token preview. The contract that matters: a preview uses the SAME resolver
 * the runtime uses, so what the user sees is what the step will send. These
 * tests also pin the honesty rules — an unresolvable token must read as
 * unknown, never as an empty string.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPreviewContext, previewToken } from '../preview-context'

const ctx = buildPreviewContext({
  lastOutputs: { n1: { slug: 'widgets', items: [{ name: 'Acme' }] } },
  triggerInput: { account: 'Acme Corp', priority: 'high' },
})

test('resolves a step token from sample output', () => {
  const preview = previewToken('Alert: {{step.n1.output.slug}}', ctx)
  assert.deepEqual(preview, { kind: 'resolved', text: 'Alert: widgets', truncated: false })
})

test('resolves trigger input', () => {
  assert.equal((previewToken('{{trigger.input.account}}', ctx) as { text: string }).text, 'Acme Corp')
})

test('resolves a nested array path the datatree emits', () => {
  assert.equal((previewToken('{{step.n1.output.items.0.name}}', ctx) as { text: string }).text, 'Acme')
})

test('a field with no tokens is literal — not echoed back', () => {
  // Echoing a plain string under itself is noise; the preview exists to show
  // what you CANNOT otherwise see.
  assert.deepEqual(previewToken('#alerts', ctx), { kind: 'literal' })
})

test('an empty field previews as empty', () => {
  assert.deepEqual(previewToken('', ctx), { kind: 'empty' })
  assert.deepEqual(previewToken('   ', ctx), { kind: 'empty' })
})

test('an unknown token reports WHICH path is unresolved', () => {
  // resolveTemplate renders a missing path as '' — silently. Presenting that
  // as a successful empty resolution would hide a typo'd token, the single
  // most common flow-authoring bug.
  const preview = previewToken('Hi {{step.nope.output.x}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['step.nope.output.x'] })
})

test('a mix of known and unknown reports only the unknown', () => {
  const preview = previewToken('{{trigger.input.account}} / {{var.ghost}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['var.ghost'] })
})

test('objects resolve to JSON, matching runtime behaviour', () => {
  const preview = previewToken('{{step.n1.output}}', ctx) as { text: string }
  assert.equal(preview.text, JSON.stringify({ slug: 'widgets', items: [{ name: 'Acme' }] }))
})

test('long values truncate and say so', () => {
  const long = buildPreviewContext({ lastOutputs: { n1: { blob: 'x'.repeat(500) } } })
  const preview = previewToken('{{step.n1.output.blob}}', long, 80) as { text: string; truncated: boolean }
  assert.equal(preview.truncated, true)
  assert.ok(preview.text.length <= 80)
})

test('expression tokens preview through the real grammar', () => {
  // `{{=upper(...)}}` is runtime syntax; the preview must not treat it as an
  // unresolved path. Reusing resolveTemplate gets this for free.
  assert.equal((previewToken('{{=upper(trigger.input.priority)}}', ctx) as { text: string }).text, 'HIGH')
})

test('an absent trigger input does not throw', () => {
  const bare = buildPreviewContext({ lastOutputs: {} })
  assert.deepEqual(previewToken('{{trigger.input.x}}', bare), { kind: 'unresolved', missing: ['trigger.input.x'] })
})

test('loop item and index are previewable inside a loop body', () => {
  const inLoop = buildPreviewContext({ lastOutputs: {}, item: { sku: 'A1' }, loop: { index: 0, count: 3 } })
  assert.equal((previewToken('{{item.sku}}', inLoop) as { text: string }).text, 'A1')
  assert.equal((previewToken('{{loop.index}}', inLoop) as { text: string }).text, '0')
})

test('repeated calls give the same answer (no shared regex state)', () => {
  // Regression: a module-level /g/ regex shared between the has-tokens check
  // and the path scan carried `lastIndex` across calls, so the scan began
  // mid-string and missed tokens. A multi-token template masked it — the first
  // token was consumed by the check and the second still got scanned — so this
  // asserts the SINGLE-token case twice, which is where it actually broke.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(previewToken('{{step.nope.output.x}}', ctx), { kind: 'unresolved', missing: ['step.nope.output.x'] })
    assert.deepEqual(previewToken('Alert: {{step.n1.output.slug}}', ctx), { kind: 'resolved', text: 'Alert: widgets', truncated: false })
  }
})

test('every unresolved token in a template is reported, not just the last', () => {
  const preview = previewToken('{{a.b}} {{c.d}} {{e.f}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['a.b', 'c.d', 'e.f'] })
})

test('a declared variable with no sample reads as unresolved, not as empty', () => {
  // Variable values only exist mid-run, so the builder cannot sample them.
  // "No sample data" is the truth; a blank preview would imply the mapping
  // resolves to nothing.
  const preview = previewToken('{{var.attempts}}', ctx)
  assert.deepEqual(preview, { kind: 'unresolved', missing: ['var.attempts'] })
})

test('variables resolve when sample values ARE supplied', () => {
  const withVars = buildPreviewContext({ lastOutputs: {}, variables: { attempts: 3 } })
  assert.equal((previewToken('{{var.attempts}}', withVars) as { text: string }).text, '3')
})
