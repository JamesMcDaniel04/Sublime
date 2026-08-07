import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDataOp } from '../data-ops'

const ok = (res: { output: unknown } | { error: string }): unknown => {
  assert.ok('output' in res, `expected output, got error: ${'error' in res ? res.error : ''}`)
  return res.output
}

const err = (res: { output: unknown } | { error: string }): string => {
  assert.ok('error' in res, 'expected an error result')
  return res.error
}

// ── compose ─────────────────────────────────────────────────────────────────

test('compose passes structured input through untouched', () => {
  const input = { deal: 'Acme', amount: 100 }
  assert.deepEqual(ok(runDataOp('compose', { input })), input)
})

test('compose exposes a JSON-looking string as structured output', () => {
  assert.deepEqual(ok(runDataOp('compose', { input: '{"a":1}' })), { a: 1 })
})

test('compose keeps plain text as text', () => {
  assert.equal(ok(runDataOp('compose', { input: 'hello world' })), 'hello world')
})

test('compose without an input fails with a plain-english message', () => {
  assert.match(err(runDataOp('compose', {})), /Compose needs/)
})

// ── parseJson ───────────────────────────────────────────────────────────────

test('parseJson parses a JSON string', () => {
  assert.deepEqual(ok(runDataOp('parseJson', { input: '{"score": 91, "tags": ["a"]}' })), { score: 91, tags: ['a'] })
})

test('parseJson passes already-structured input through', () => {
  assert.deepEqual(ok(runDataOp('parseJson', { input: [1, 2] })), [1, 2])
})

test('parseJson fails plainly on content that is not JSON', () => {
  const message = err(runDataOp('parseJson', { input: 'definitely not json' }))
  assert.match(message, /Parse JSON needs valid JSON/)
  assert.doesNotMatch(message, /SyntaxError/)
})

// ── join ────────────────────────────────────────────────────────────────────

test('join joins an array with the separator', () => {
  assert.equal(ok(runDataOp('join', { input: ['a', 'b', 'c'], separator: ' - ' })), 'a - b - c')
})

test('join defaults the separator to a comma', () => {
  assert.equal(ok(runDataOp('join', { input: ['a', 'b'] })), 'a,b')
})

test('join accepts a JSON array string', () => {
  assert.equal(ok(runDataOp('join', { input: '["x","y"]', separator: '|' })), 'x|y')
})

test('join stringifies object items as JSON', () => {
  assert.equal(ok(runDataOp('join', { input: [{ a: 1 }, 'b'], separator: ';' })), '{"a":1};b')
})

// Decision (tested contract): a non-array input is coerced to a single-item
// list, so join degrades to the item's text instead of failing.
test('join coerces a non-array input to a single item', () => {
  assert.equal(ok(runDataOp('join', { input: 'solo', separator: '-' })), 'solo')
})

test('join without an input fails with a plain-english message', () => {
  assert.match(err(runDataOp('join', {})), /Join needs/)
})

// ── csvTable ────────────────────────────────────────────────────────────────

test('csvTable renders records as CSV with a union header row', () => {
  const output = ok(runDataOp('csvTable', { input: [{ name: 'Acme', amount: 100 }, { name: 'Beta', owner: 'Dana' }] }))
  assert.equal(output, 'name,amount,owner\nAcme,100,\nBeta,,Dana')
})

test('csvTable quotes and escapes commas, quotes, and newlines', () => {
  const output = ok(runDataOp('csvTable', { input: [{ note: 'a,b', quote: 'say "hi"', multi: 'line1\nline2' }] }))
  assert.equal(output, 'note,quote,multi\n"a,b","say ""hi""","line1\nline2"')
})

test('csvTable quotes headers that contain commas', () => {
  const output = ok(runDataOp('csvTable', { input: [{ 'last, first': 'Doe, Jane' }] }))
  assert.equal(output, '"last, first"\n"Doe, Jane"')
})

test('csvTable keeps script tags as literal quoted text (no HTML meaning in CSV)', () => {
  const output = ok(runDataOp('csvTable', { input: [{ cell: '<script>alert(1)</script>' }] }))
  assert.equal(output, 'cell\n<script>alert(1)</script>')
})

test('csvTable wraps non-object items in a value column', () => {
  assert.equal(ok(runDataOp('csvTable', { input: ['a', 'b'] })), 'value\na\nb')
})

test('csvTable fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('csvTable', { input: 'not a list' })), /Create CSV table needs a list/)
})

// ── htmlTable ───────────────────────────────────────────────────────────────

test('htmlTable renders records as an HTML table', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ name: 'Acme', amount: 100 }] }))
  assert.equal(output, '<table><thead><tr><th>name</th><th>amount</th></tr></thead><tbody><tr><td>Acme</td><td>100</td></tr></tbody></table>')
})

test('htmlTable escapes script tags and every special character in cells', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ cell: '<script>alert("x")</script>' }] })) as string
  assert.ok(!output.includes('<script>'))
  assert.ok(output.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
})

test('htmlTable escapes headers and ampersands/apostrophes', () => {
  const output = ok(runDataOp('htmlTable', { input: [{ '<b>col</b>': "Tom & Jerry's" }] })) as string
  assert.ok(output.includes('<th>&lt;b&gt;col&lt;/b&gt;</th>'))
  assert.ok(output.includes('<td>Tom &amp; Jerry&#39;s</td>'))
})

test('htmlTable fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('htmlTable', { input: { not: 'a list' } })), /Create HTML table needs a list/)
})

// ── filterArray ─────────────────────────────────────────────────────────────

test('filterArray keeps items whose clauses all pass (eq)', () => {
  const input = [{ status: 'open', name: 'A' }, { status: 'closed', name: 'B' }, { status: 'open', name: 'C' }]
  const output = ok(runDataOp('filterArray', { input, clauses: [{ left: '{{item.status}}', op: 'eq', right: 'open' }] }))
  assert.deepEqual(output, [{ status: 'open', name: 'A' }, { status: 'open', name: 'C' }])
})

test('filterArray supports contains on item fields', () => {
  const input = [{ title: 'Renewal — Acme' }, { title: 'New logo — Beta' }]
  const output = ok(runDataOp('filterArray', { input, clauses: [{ left: '{{item.title}}', op: 'contains', right: 'Acme' }] }))
  assert.deepEqual(output, [{ title: 'Renewal — Acme' }])
})

test('filterArray ANDs multiple clauses', () => {
  const input = [{ stage: 'closed', amount: 50 }, { stage: 'closed', amount: 200 }]
  const output = ok(runDataOp('filterArray', {
    input,
    clauses: [
      { left: '{{item.stage}}', op: 'eq', right: 'closed' },
      { left: '{{item.amount}}', op: 'gt', right: '100' },
    ],
  }))
  assert.deepEqual(output, [{ stage: 'closed', amount: 200 }])
})

test('filterArray without clauses fails plainly', () => {
  assert.match(err(runDataOp('filterArray', { input: [1] })), /Filter array needs at least one condition/)
})

test('filterArray fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('filterArray', { input: 'nope', clauses: [{ left: '{{item}}', op: 'eq', right: 'nope' }] })), /Filter array needs a list/)
})

// ── select ──────────────────────────────────────────────────────────────────

test('select maps items to objects with the configured fields', () => {
  const input = [{ name: 'Acme', amount: 100 }, { name: 'Beta', amount: 200 }]
  const output = ok(runDataOp('select', { input, fields: [{ name: 'company', value: '{{item.name}}' }] }))
  assert.deepEqual(output, [{ company: 'Acme' }, { company: 'Beta' }])
})

test('select maps a missing source field to null, not a crash', () => {
  const input = [{ name: 'Acme' }]
  const output = ok(runDataOp('select', {
    input,
    fields: [
      { name: 'company', value: '{{item.name}}' },
      { name: 'owner', value: '{{item.owner.email}}' },
    ],
  }))
  assert.deepEqual(output, [{ company: 'Acme', owner: null }])
})

test('select supports composed text values around item tokens', () => {
  const output = ok(runDataOp('select', { input: [{ name: 'Acme' }], fields: [{ name: 'line', value: 'Deal: {{item.name}}' }] }))
  assert.deepEqual(output, [{ line: 'Deal: Acme' }])
})

test('select preserves structured values for exact item tokens', () => {
  const output = ok(runDataOp('select', { input: [{ tags: ['a', 'b'] }], fields: [{ name: 'tags', value: '{{item.tags}}' }] }))
  assert.deepEqual(output, [{ tags: ['a', 'b'] }])
})

test('select without fields fails plainly', () => {
  assert.match(err(runDataOp('select', { input: [1], fields: [] })), /Select needs at least one field/)
})

test('select fails plainly on a non-list input', () => {
  assert.match(err(runDataOp('select', { input: 'nope', fields: [{ name: 'x', value: '{{item}}' }] })), /Select needs a list/)
})

test('slackMessage formats aggregated records as fallback text and Block Kit sections', () => {
  const output = ok(runDataOp('slackMessage', { input: [{ account: 'Acme', risk: 'High' }, { account: 'Beta', risk: 'Low' }] })) as any
  assert.match(output.text, /\*account:\* Acme/)
  assert.equal(output.blocks.length, 2)
  assert.equal(output.blocks[0].type, 'section')
})

test('sort, limit, dedupe, splitOut ops', async () => {
  const { runDataOp } = await import('../data-ops')
  const items = [{ n: 3, tag: 'b' }, { n: 1, tag: 'a' }, { n: 3, tag: 'b' }, { n: 2, tag: 'c' }]
  const sorted = runDataOp('sort', { input: items, fields: [{ name: 'n', value: 'desc' }] })
  assert.deepEqual((sorted as { output: Array<{ n: number }> }).output.map((item) => item.n), [3, 3, 2, 1])
  const limited = runDataOp('limit', { input: items, count: 2 })
  assert.equal((limited as { output: unknown[] }).output.length, 2)
  const deduped = runDataOp('dedupe', { input: items, fields: [{ name: 'tag', value: '' }] })
  assert.deepEqual((deduped as { output: Array<{ tag: string }> }).output.map((item) => item.tag), ['b', 'a', 'c'])
  const split = runDataOp('splitOut', { input: [{ emails: ['x@a.co', 'y@a.co'], team: 'ops' }], field: 'emails' })
  assert.deepEqual((split as { output: unknown[] }).output, [
    { emails: 'x@a.co', team: 'ops' },
    { emails: 'y@a.co', team: 'ops' },
  ])
})
