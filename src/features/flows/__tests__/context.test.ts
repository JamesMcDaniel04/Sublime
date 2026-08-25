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

test('matches refuses catastrophic-backtracking patterns instead of hanging the worker', () => {
  // The pattern side is templated, so upstream data (a webhook payload, an LLM
  // output) can supply it — an evil regex here would hang the run's worker
  // uninterruptibly. Refused patterns evaluate to false.
  const c: FlowContext = {
    trigger: { input: '(a+)+$' },
    step: { s: { output: { text: `${'a'.repeat(40)}X` } } },
  }
  const started = process.hrtime.bigint()
  assert.equal(evalClause({ left: '{{step.s.output.text}}', op: 'matches', right: '{{trigger.input}}' }, c), false)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 100, `expected immediate refusal, took ${elapsedMs}ms`)
  // Ordinary author patterns are unaffected.
  assert.equal(evalClause({ left: '{{step.s.output.text}}', op: 'matches', right: '^a+X$' }, c), true)
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

// A node's friendly label (what the builder shows on token chips) resolves to
// that node's output, so a hand-typed `{{Previous Agent.output.message}}`
// works the same as the id-keyed `{{step.<id>.output.message}}` the picker
// inserts. stepLabels is the run's node-id → display-label map.
const labelCtx: FlowContext = {
  trigger: { input: '' },
  step: { n7: { output: { message: 'Hello from the agent' } }, n8: { output: 'plain text' } },
  stepLabels: { n7: 'Previous Agent', n8: 'Draft Step' },
}

test('readPath resolves a node-label root to that step output', () => {
  assert.equal(readPath(labelCtx, 'Previous Agent.output.message'), 'Hello from the agent')
  assert.deepEqual(readPath(labelCtx, 'Previous Agent.output'), { message: 'Hello from the agent' })
  assert.equal(readPath(labelCtx, 'Draft Step.output'), 'plain text')
})

test('node-label resolution is case-insensitive and trims padding', () => {
  assert.equal(readPath(labelCtx, 'previous agent.output.message'), 'Hello from the agent')
  assert.equal(readPath(labelCtx, ' Previous Agent .output.message'), 'Hello from the agent')
})

test('reserved roots are never shadowed by a node label', () => {
  const c: FlowContext = {
    trigger: { input: 'real trigger' },
    step: { n1: { output: 'step out' } },
    stepLabels: { n1: 'trigger' }, // a node the user labeled "trigger"
  }
  // `{{trigger.input}}` must still read the real trigger, not the node.
  assert.equal(readPath(c, 'trigger.input'), 'real trigger')
})

test('an unresolvable label yields empty, id-keyed tokens still work', () => {
  assert.equal(resolveTemplate('{{Nonexistent Node.output}}', labelCtx), '')
  // Backward compatibility: the canonical id-keyed form is unaffected.
  assert.equal(readPath(labelCtx, 'step.n7.output.message'), 'Hello from the agent')
})

test('the Slack-node JSON arg case: exact label token resolves in-place', () => {
  // The tool node JSON.parses its args, then resolveTemplateValue walks them.
  assert.deepEqual(
    resolveTemplateValue({ query: '{{Previous Agent.output.message}}' }, labelCtx),
    { query: 'Hello from the agent' },
  )
})

// ── clock tokens ────────────────────────────────────────────────────────────
//
// {{now}} / {{today}} reach the resolver through the same path as every other
// root. The rendering rules live in lib/flows/clock-tokens.ts; these pin the
// WIRING — that a flow can actually write {{now}} in a field.

const clockCtx = (timezone?: string): FlowContext => ({
  trigger: { input: null },
  step: {},
  startedAt: '2026-03-14T15:09:26.535Z',
  ...(timezone ? { timezone } : {}),
}) as FlowContext

test('{{now}} resolves through readPath', () => {
  assert.equal(readPath(clockCtx(), 'now'), '2026-03-14T15:09:26.535Z')
})

test('{{today}} resolves through readPath', () => {
  assert.equal(readPath(clockCtx(), 'today'), '2026-03-14')
})

test('clock tokens honour the flow timezone', () => {
  assert.equal(readPath(clockCtx('Asia/Tokyo'), 'today'), '2026-03-15')
})

test('{{now.date}} renders inside a template', () => {
  assert.equal(resolveTemplate('run-{{now.date}}.csv', clockCtx()), 'run-2026-03-14.csv')
})

// A run with no startedAt (an older persisted context, a unit-test stub) must
// not render "undefined" into someone's filename.
test('a context without startedAt yields nothing rather than the string undefined', () => {
  const bare = { trigger: { input: null }, step: {} } as FlowContext
  assert.equal(resolveTemplate('x{{now}}', bare), 'x')
})

// A step named "now" must not be shadowed into oblivion, and equally must not
// hijack the clock root — reserved roots win, which is the existing rule.
test('the clock roots are reserved, like trigger and step', () => {
  const shadowed = { ...clockCtx(), step: { n1: { output: 'x' } } } as FlowContext
  assert.equal(readPath(shadowed, 'now'), '2026-03-14T15:09:26.535Z')
})
