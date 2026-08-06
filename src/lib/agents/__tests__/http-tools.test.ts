import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentHttpToolDefinition,
  agentHttpToolInputs,
  agentHttpToolIsWrite,
  agentHttpToolSchema,
  agentHttpToolsFromMetadata,
  substituteAgentHttpToolArgs,
} from '../http-tools'

const TOOL = {
  id: 'ep-1',
  name: 'Create CRM Lead',
  description: 'Creates a lead in the CRM.',
  config: {
    method: 'POST' as const,
    url: 'https://api.crm.example/v2/leads/{{input.pipeline}}',
    sendBody: true,
    body: '{"email":"{{input.email}}","source":"{{input.pipeline}}"}',
    headers: '{"x-team":"sales"}',
    auth: { type: 'bearer' as const, token: '{{input.email}}' },
    credentialId: 'cred-1',
    authMode: 'generic' as const,
  },
}

test('schema validates and rejects junk', () => {
  assert.ok(agentHttpToolSchema.safeParse(TOOL).success)
  assert.equal(agentHttpToolSchema.safeParse({ id: '', name: '', config: {} }).success, false)
  assert.equal(agentHttpToolSchema.safeParse({ id: 'x', name: 'x', config: { method: 'YEET', url: '' } }).success, false)
})

test('extracts unique placeholder inputs from templated fields only', () => {
  // auth subtree is deliberately excluded — secrets are never model-fillable.
  assert.deepEqual(agentHttpToolInputs(TOOL.config), ['pipeline', 'email'])
})

test('ignores non-input tokens', () => {
  assert.deepEqual(agentHttpToolInputs({ method: 'GET', url: 'https://x.co/{{step.a.output}}/{{ input.id }}' }), ['id'])
})

test('builds a model-facing tool definition', () => {
  const definition = agentHttpToolDefinition(agentHttpToolSchema.parse(TOOL))
  assert.equal(definition.name, 'http_create_crm_lead')
  assert.ok(definition.description.includes('Creates a lead in the CRM.'))
  assert.ok(definition.description.includes('POST'))
  const schema = definition.inputSchema as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(Object.keys(schema.properties), ['pipeline', 'email'])
  assert.deepEqual(schema.required, ['pipeline', 'email'])
})

test('substitutes args into templated fields but never the auth subtree', () => {
  const parsed = agentHttpToolSchema.parse(TOOL)
  const config = substituteAgentHttpToolArgs(parsed.config, { pipeline: 'inbound', email: 'a@x.co' })
  assert.equal(config.url, 'https://api.crm.example/v2/leads/inbound')
  assert.equal(config.body, '{"email":"a@x.co","source":"inbound"}')
  assert.equal(config.auth?.token, '{{input.email}}')
  // original untouched
  assert.equal(parsed.config.url, 'https://api.crm.example/v2/leads/{{input.pipeline}}')
})

test('missing args substitute as empty strings', () => {
  const config = substituteAgentHttpToolArgs(agentHttpToolSchema.parse(TOOL).config, {})
  assert.equal(config.url, 'https://api.crm.example/v2/leads/')
})

test('write classification follows the method', () => {
  assert.equal(agentHttpToolIsWrite({ method: 'GET' }), false)
  assert.equal(agentHttpToolIsWrite({ method: 'HEAD' }), false)
  assert.equal(agentHttpToolIsWrite({ method: 'POST' }), true)
})

test('agentHttpToolsFromMetadata drops invalid entries silently', () => {
  const tools = agentHttpToolsFromMetadata({ httpTools: [TOOL, { junk: true }, null] })
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'Create CRM Lead')
  assert.deepEqual(agentHttpToolsFromMetadata({}), [])
  assert.deepEqual(agentHttpToolsFromMetadata(undefined), [])
})
