import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouterPrompt, routerBranchSchema, parseRouterChoice } from '../router'

const branches = [
  { id: 'billing', label: 'Billing', description: 'invoices, refunds' },
  { id: 'tech', description: 'bugs, errors' },
]

test('routerBranchSchema constrains branch to the ids plus default', () => {
  const schema = routerBranchSchema(branches) as any
  assert.deepEqual(schema.properties.branch.enum, ['billing', 'tech', 'default'])
  assert.deepEqual(schema.required, ['branch'])
})

test('buildRouterPrompt lists every branch id + hint and includes the input', () => {
  const { system, user } = buildRouterPrompt(branches, 'Be strict.', 'my invoice is wrong')
  assert.match(system, /billing/)
  assert.match(system, /invoices, refunds/)
  assert.match(system, /Be strict\./)
  assert.match(user, /my invoice is wrong/)
})

test('parseRouterChoice accepts a known id, rejects an unknown one, tolerates fences', () => {
  assert.deepEqual(parseRouterChoice('{"branch":"tech"}', branches), { branch: 'tech' })
  assert.deepEqual(parseRouterChoice('```json\n{"branch":"billing"}\n```', branches), { branch: 'billing' })
  assert.deepEqual(parseRouterChoice('{"branch":"default"}', branches), { branch: 'default' })
  assert.ok('error' in parseRouterChoice('{"branch":"nope"}', branches))
  assert.ok('error' in parseRouterChoice('not json', branches))
})
