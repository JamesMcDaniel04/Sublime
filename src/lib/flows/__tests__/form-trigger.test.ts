/**
 * Form trigger — a way for someone outside the workspace to start a flow.
 *
 * The gap in one sentence: every trigger Sublime has is either internal
 * (manual, schedule, signal, activity), a machine-to-machine webhook, or a
 * poll. There is no way to hand a person a link and collect typed input.
 *
 * The pieces already existed — `input` nodes declare typed params, and
 * `missingRequiredInputFields` validates them — so this is derivation and
 * coercion, not new machinery.
 *
 * Coercion matters more than it looks: an HTML form submits STRINGS. Without
 * it, a field declared `number` reaches the flow as "42" and every downstream
 * comparison silently does the wrong thing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formFieldsFor, coerceFormSubmission, type FormField } from '../form-trigger'
import type { FlowGraph } from '../graph'

const graph = (params: unknown[]): FlowGraph =>
  ({
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: { type: 'form' } } },
      { id: 'i', type: 'input', position: { x: 0, y: 1 }, data: { params } },
    ],
    edges: [],
  }) as unknown as FlowGraph

const FIELDS: FormField[] = [
  { name: 'email', type: 'string', required: true, description: 'Where to reply' },
  { name: 'headcount', type: 'number', required: false },
  { name: 'urgent', type: 'boolean', required: false },
]

// ── deriving the form ───────────────────────────────────────────────────────

test('the form is derived from the flow input node', () => {
  const fields = formFieldsFor(graph(FIELDS))
  assert.deepEqual(fields.map((f) => f.name), ['email', 'headcount', 'urgent'])
  assert.equal(fields[0].required, true)
})

test('descriptions come through so the form can label itself', () => {
  assert.equal(formFieldsFor(graph(FIELDS))[0].description, 'Where to reply')
})

test('a flow with no input node offers no fields rather than throwing', () => {
  const bare = { nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: {} }], edges: [] } as unknown as FlowGraph
  assert.deepEqual(formFieldsFor(bare), [])
})

test('a malformed graph yields no fields rather than throwing', () => {
  assert.deepEqual(formFieldsFor('nonsense' as unknown as FlowGraph), [])
})

// A field with no name cannot be rendered or submitted; carrying it would put
// an unlabelled input on a public page.
test('unnamed fields are dropped', () => {
  assert.deepEqual(formFieldsFor(graph([{ name: '  ', type: 'string' }])), [])
})

// ── coercing a submission ───────────────────────────────────────────────────

test('a required field must be present', () => {
  const result = coerceFormSubmission(FIELDS, {})
  assert.ok('errors' in result)
  assert.match(result.errors.join(' '), /email/)
})

test('a valid submission coerces to the declared types', () => {
  const result = coerceFormSubmission(FIELDS, { email: 'a@b.c', headcount: '42', urgent: 'true' })
  assert.ok('values' in result)
  assert.equal(result.values.email, 'a@b.c')
  assert.equal(result.values.headcount, 42, 'a form posts strings; number must coerce')
  assert.equal(result.values.urgent, true)
})

test('boolean coercion understands what a form actually posts', () => {
  const bool = (raw: unknown) => {
    const result = coerceFormSubmission([{ name: 'x', type: 'boolean', required: false }], { x: raw })
    return 'values' in result ? result.values.x : 'ERROR'
  }
  // Checkboxes post "on"; selects post "true"/"false"; JSON posts real booleans.
  assert.equal(bool('on'), true)
  assert.equal(bool('true'), true)
  assert.equal(bool(true), true)
  assert.equal(bool('false'), false)
  assert.equal(bool(''), false)
})

// "0" and "false" are VALUES, not absence — treating them as missing is a
// classic form bug that rejects a legitimate answer.
test('zero and false satisfy a required field', () => {
  const result = coerceFormSubmission(
    [{ name: 'count', type: 'number', required: true }, { name: 'agree', type: 'boolean', required: true }] as FormField[],
    { count: '0', agree: 'false' },
  )
  assert.ok('values' in result, `expected acceptance, got ${JSON.stringify(result)}`)
  assert.equal(result.values.count, 0)
  assert.equal(result.values.agree, false)
})

test('a non-numeric value for a number field is an error naming the field', () => {
  const result = coerceFormSubmission([{ name: 'n', type: 'number', required: true }], { n: 'twelve' })
  assert.ok('errors' in result)
  assert.match(result.errors.join(' '), /n\b/)
})

// A public endpoint takes whatever it is sent; extra keys must not reach the
// flow, or the form becomes an arbitrary payload injector.
test('fields the form does not declare are dropped, not passed through', () => {
  const result = coerceFormSubmission([{ name: 'email', type: 'string', required: false }], { email: 'a@b.c', isAdmin: true })
  assert.ok('values' in result)
  assert.equal(result.values.isAdmin, undefined)
})

test('an optional field left blank is simply absent', () => {
  const result = coerceFormSubmission(FIELDS, { email: 'a@b.c' })
  assert.ok('values' in result)
  assert.equal('headcount' in result.values, false)
})
