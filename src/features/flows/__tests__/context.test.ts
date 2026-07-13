import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPath, resolveTemplate, resolveTemplateValue, asStructured, evalCondition, evalClause, type FlowContext } from '../context'

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

test('resolveTemplate supports field names with spaces and dashes', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n1: { output: { 'account-name': 'Acme', 'in segment': true } } },
  }
  assert.equal(resolveTemplate('{{step.n1.output.account-name}}', c), 'Acme')
  assert.equal(resolveTemplate('{{step.n1.output.in segment}}', c), 'true')
})

test('resolveTemplateValue preserves exact-token structured values', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { n1: { output: { name: 'Acme', score: 91 } } },
  }
  assert.deepEqual(resolveTemplateValue({ account: '{{step.n1.output}}', label: 'Account {{step.n1.output.name}}' }, c), {
    account: { name: 'Acme', score: 91 },
    label: 'Account Acme',
  })
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

test('evalClause trims resolved string operands (chip insertion leaves trailing spaces)', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { s: { output: { stage: 'enterprise ', notes: 'the enterprise tier' } } },
  }
  // eq: trailing space from a chip insert on either side still matches.
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'eq', right: 'enterprise' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.stage}} ', op: 'eq', right: ' enterprise ' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'neq', right: 'enterprise' }, c), false)
  // contains: a trailing-space needle still matches.
  assert.equal(evalClause({ left: '{{step.s.output.notes}}', op: 'contains', right: 'enterprise ' }, c), true)
  // matches: a padded pattern still compiles and matches.
  assert.equal(evalClause({ left: '{{step.s.output.stage}}', op: 'matches', right: ' ^enter ' }, c), true)
})

test('evalClause numeric comparisons still work with padded numerics', () => {
  const c: FlowContext = { trigger: { input: ' 80 ' }, step: { s: { output: { score: '91 ' } } } }
  assert.equal(evalClause({ left: '{{step.s.output.score}} ', op: 'gt', right: '{{trigger.input}}' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'lte', right: '{{trigger.input}}' }, c), false)
  assert.equal(evalClause({ left: ' 91 ', op: 'eq', right: '91' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'gte', right: '91' }, c), true)
})

test('evalClause leaves non-string operands from structured outputs intact', () => {
  const c: FlowContext = {
    trigger: { input: '' },
    step: { s: { output: { score: 91, active: true, ratio: 0.5 } } },
  }
  assert.equal(evalClause({ left: '{{step.s.output.score}}', op: 'eq', right: '91' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.active}}', op: 'eq', right: 'true' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.ratio}}', op: 'lt', right: '1' }, c), true)
  assert.equal(evalClause({ left: '{{step.s.output.score}} ', op: 'gt', right: '90' }, c), true)
})

test('evalCondition combines clauses with all (AND) / any (OR)', () => {
  const pass = { left: '{{step.n3.output.score}}', op: 'gt' as const, right: '80' }
  const fail = { left: '{{item}}', op: 'eq' as const, right: 'Globex' }
  assert.equal(evalCondition({ match: 'all', clauses: [pass, fail] }, ctx), false)
  assert.equal(evalCondition({ match: 'any', clauses: [pass, fail] }, ctx), true)
  assert.equal(evalCondition({ match: 'all', clauses: [pass] }, ctx), true)
})

test('safe expressions transform values without executing JavaScript', () => {
  assert.equal(resolveTemplate('{{= upper(trigger.input.name) }}', { trigger: { input: { name: 'acme' } }, step: {} }), 'ACME')
  assert.equal(resolveTemplateValue('{{= add(2, step.n3.output.score) }}', ctx), 93)
  assert.equal(resolveTemplateValue('{{= coalesce(step.missing.output, "fallback") }}', ctx), 'fallback')
  assert.equal(resolveTemplateValue('{{= process.exit() }}', ctx), '')
})
