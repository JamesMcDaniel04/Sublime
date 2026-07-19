import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionToolName, actionInputSchema, runNangoAction, listActionTools } from '../actions'

test('actionToolName produces stable agent-safe names', () => {
  assert.equal(actionToolName('slack', 'post-message'), 'slack_post_message')
  assert.equal(actionToolName('gmail', 'send-email'), 'gmail_send_email')
  assert.equal(actionToolName('salesforce', 'create-record'), 'salesforce_create_record')
  assert.equal(actionToolName('monday', 'create.item v2'), 'monday_create_item_v2')
})

test('actionInputSchema resolves the input model from json_schema definitions', () => {
  const schema = actionInputSchema({
    input: 'In',
    json_schema: { definitions: { In: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } },
  })
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['x'])
  assert.equal(schema.definitions, undefined) // no other defs → nothing rides along
})

test('actionInputSchema keeps sibling definitions for $refs', () => {
  const schema = actionInputSchema({
    input: 'In',
    json_schema: {
      definitions: {
        In: { type: 'object', properties: { item: { $ref: '#/definitions/Item' } } },
        Item: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  })
  const defs = schema.definitions as Record<string, unknown>
  assert.ok(defs.Item)
  assert.equal(defs.In, undefined) // the input model itself is not duplicated
})

test('actionInputSchema falls back to an open object without an input model', () => {
  assert.deepEqual(actionInputSchema({ input: null, json_schema: null }), { type: 'object', properties: {} })
  assert.deepEqual(actionInputSchema({ input: 'Missing', json_schema: { definitions: {} } }), { type: 'object', properties: {} })
})

const connection = { connectionId: 'conn-1', providerConfigKey: 'slack', scope: 'user' as const }

test('runNangoAction triggers the action with the connection coordinates', async () => {
  const calls: unknown[][] = []
  const result = await runNangoAction(connection, 'post-message', { channel: 'C1' }, async (...args) => {
    calls.push(args)
    return { ok: true }
  })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls[0], ['slack', 'conn-1', 'post-message', { channel: 'C1' }])
})

test('runNangoAction rejects at the deadline instead of hanging', async () => {
  process.env.NANGO_ACTION_TIMEOUT_MS = '20'
  try {
    await assert.rejects(
      runNangoAction(connection, 'slow-action', {}, () => new Promise(() => {})),
      /timed out after 20ms/,
    )
  } finally {
    delete process.env.NANGO_ACTION_TIMEOUT_MS
  }
})

test('listActionTools fails open to [] when the catalog is unreachable', async () => {
  const prev = process.env.NANGO_SECRET_KEY
  delete process.env.NANGO_SECRET_KEY // getNangoClient throws → catalog fetch fails
  try {
    assert.deepEqual(await listActionTools('slack', 'slack'), [])
  } finally {
    if (prev !== undefined) process.env.NANGO_SECRET_KEY = prev
  }
})
