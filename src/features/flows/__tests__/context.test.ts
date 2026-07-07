import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPath, resolveTemplate, asStructured, evalCondition, evalClause, type FlowContext } from '../context'

const ctx: FlowContext = {
  trigger: { input: 'Acme, Globex' },
  step: { n1: { output: '["Acme","Globex"]' }, n3: { output: { score: 91 } } },
  item: 'Acme',
}

test('readPath reads trigger, nested step output, and item', () => {
  assert.equal(readPath(ctx, 'trigger.input'), 'Acme, Globex')
  assert.equal(readPath(ctx, 'step.n3.output.score'), 91)
  assert.equal(readPath(ctx, 'item'), 'Acme')
  assert.equal(readPath(ctx, 'step.nope.output'), undefined)
})

test('resolveTemplate substitutes tokens; missing → empty; objects → JSON', () => {
  assert.equal(resolveTemplate('Score {{item}}', ctx), 'Score Acme')
  assert.equal(resolveTemplate('{{step.n3.output}}', ctx), '{"score":91}')
  assert.equal(resolveTemplate('x{{step.missing.output}}y', ctx), 'xy')
})

test('asStructured parses JSON strings, passes through non-JSON', () => {
  assert.deepEqual(asStructured('["a","b"]'), ['a', 'b'])
  assert.equal(asStructured('hello'), 'hello')
  assert.deepEqual(asStructured({ a: 1 }), { a: 1 })
})

test('evalCondition handles numeric and string ops (legacy single clause)', () => {
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'gt', right: '80' }, ctx), true)
  assert.equal(evalCondition({ left: '{{step.n3.output.score}}', op: 'lt', right: '80' }, ctx), false)
  assert.equal(evalCondition({ left: '{{trigger.input}}', op: 'contains', right: 'Globex' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'eq', right: 'Acme' }, ctx), true)
  assert.equal(evalCondition({ left: '{{item}}', op: 'matches', right: '^Ac' }, ctx), true)
})

test('evalClause templates the right-hand side (dynamic comparison)', () => {
  const c: FlowContext = { trigger: { input: '80' }, step: { s: { output: { score: 91 } } } }
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'gt', right: '{{trigger.input}}' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'lt', right: '{{trigger.input}}' }, c), false)
})

test('evalCondition combines clauses with all (AND) / any (OR)', () => {
  const pass = { left: '{{step.n3.output.score}}', op: 'gt' as const, right: '80' }
  const fail = { left: '{{item}}', op: 'eq' as const, right: 'Globex' }
  assert.equal(evalCondition({ match: 'all', clauses: [pass, fail] }, ctx), false)
  assert.equal(evalCondition({ match: 'any', clauses: [pass, fail] }, ctx), true)
  assert.equal(evalCondition({ match: 'all', clauses: [pass] }, ctx), true)
})
