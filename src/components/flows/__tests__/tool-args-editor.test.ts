import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, schemaFields, serializeArgs, type SchemaField } from '../tool-args-editor'

test('schemaFields flattens top-level tool input schemas', () => {
  const fields = schemaFields({
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'integer' },
      mode: { type: 'string', enum: ['fast', 'deep'] },
    },
  })
  assert.deepEqual(fields, [
    { name: 'query', type: 'string', required: true, description: 'Search query.', enumValues: undefined },
    { name: 'limit', type: 'integer', required: false, description: undefined, enumValues: undefined },
    { name: 'mode', type: 'string', required: false, description: undefined, enumValues: ['fast', 'deep'] },
  ])
})

test('serializeArgs preserves object, array, and any fields as JSON values', () => {
  const fields: SchemaField[] = [
    { name: 'payload', type: 'object', required: true },
    { name: 'items', type: 'array', required: false },
    { name: 'metadata', type: 'any', required: false },
  ]
  const json = serializeArgs(
    {
      payload: '{"account":"{{trigger.input.account}}","score":91}',
      items: '["a","b"]',
      metadata: 'true',
    },
    fields,
  )
  assert.deepEqual(JSON.parse(json), {
    payload: { account: '{{trigger.input.account}}', score: 91 },
    items: ['a', 'b'],
    metadata: true,
  })
})

test('serializeArgs leaves exact data tokens intact for runtime object substitution', () => {
  const fields: SchemaField[] = [{ name: 'payload', type: 'object', required: true }]
  assert.deepEqual(JSON.parse(serializeArgs({ payload: '{{trigger.input.record}}' }, fields)), {
    payload: '{{trigger.input.record}}',
  })
})

test('serializeArgs still coerces scalar fields', () => {
  const fields: SchemaField[] = [
    { name: 'limit', type: 'integer', required: false },
    { name: 'dryRun', type: 'boolean', required: false },
    { name: 'query', type: 'string', required: false },
  ]
  assert.deepEqual(JSON.parse(serializeArgs({ limit: '5', dryRun: 'true', query: 'Acme' }, fields)), {
    limit: 5,
    dryRun: true,
    query: 'Acme',
  })
})

test('parseArgs makes structured args editable as field text', () => {
  assert.deepEqual(parseArgs('{"payload":{"id":1},"items":["a"],"query":"Acme"}'), {
    payload: '{"id":1}',
    items: '["a"]',
    query: 'Acme',
  })
})

test('schemaFields and serializeArgs support nested tool contracts', () => {
  const fields = schemaFields({
    type: 'object',
    required: ['customer'],
    properties: {
      customer: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, tier: { enum: ['pro', 'free'] } } },
      options: { type: 'object', properties: { limit: { type: 'integer', default: 10 } } },
    },
  })
  assert.deepEqual(fields.map((field) => [field.name, field.required]), [['customer.id', true], ['customer.tier', false], ['options.limit', false]])
  assert.deepEqual(JSON.parse(serializeArgs({ 'customer.id': 'c1', 'customer.tier': 'pro', 'options.limit': '5' }, fields)), { customer: { id: 'c1', tier: 'pro' }, options: { limit: 5 } })
})
