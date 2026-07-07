import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDataTree, inferFields } from '../datatree'

test('inferFields walks objects and arrays into dot-path tokens', () => {
  const fields = inferFields({ score: 91, owner: { name: 'Ada' }, tags: ['a'] }, 'step.n1.output')
  const score = fields.find((f) => f.label === 'score')
  assert.equal(score?.token, '{{step.n1.output.score}}')
  assert.equal(score?.type, 'number')
  const owner = fields.find((f) => f.label === 'owner')
  assert.equal(owner?.children?.[0]?.token, '{{step.n1.output.owner.name}}')
  const tags = fields.find((f) => f.label === 'tags')
  assert.equal(tags?.children?.[0]?.token, '{{step.n1.output.tags.0}}')
})

test('buildDataTree offers trigger, declared fields, and inferred fields', () => {
  const tree = buildDataTree({
    trigger: true,
    upstream: [{ id: 'n1', label: 'Pull accounts', outputFields: [{ name: 'count', type: 'number' }] }],
    lastOutputs: { n1: { count: 5, region: 'EMEA' } },
  })
  assert.equal(tree[0].token, '{{trigger.input}}')
  const n1 = tree.find((r) => r.label === 'Pull accounts')
  const labels = n1?.children?.map((c) => c.label)
  assert.ok(labels?.includes('count')) // declared
  assert.ok(labels?.includes('region')) // inferred from last run
  // declared field is not duplicated by inference
  assert.equal(n1?.children?.filter((c) => c.label === 'count').length, 1)
})

test('buildDataTree exposes {{item}}/{{loop.index}} inside a loop', () => {
  const tree = buildDataTree({ upstream: [], insideLoop: true, lastOutputs: { __item: { name: 'Acme' } } })
  const item = tree.find((r) => r.token === '{{item}}')
  assert.ok(item)
  assert.equal(item?.children?.[0]?.token, '{{item.name}}')
  assert.ok(tree.some((r) => r.token === '{{loop.index}}'))
})
