import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { KlavisClient } from '../klavis-client'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockServersResponse(servers: unknown) {
  globalThis.fetch = (async () =>
    ({ ok: true, json: async () => ({ servers }) }) as unknown as Response) as typeof fetch
}

test('listServerCatalog preserves tool names + descriptions (not just a count)', async () => {
  mockServersResponse([
    {
      name: 'Salesforce',
      description: 'CRM',
      tools: [
        { name: 'create_record', description: 'Create a record' },
        { name: 'query', description: 'Run SOQL' },
        { name: 'nodesc' },
      ],
    },
  ])
  const catalog = await new KlavisClient({ apiKey: 'k' }).listServerCatalog()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].toolCount, 3)
  assert.deepEqual(catalog[0].tools, [
    { name: 'create_record', description: 'Create a record' },
    { name: 'query', description: 'Run SOQL' },
    { name: 'nodesc', description: undefined },
  ])
})

test('listServerCatalog drops malformed tool entries and servers without a name', async () => {
  mockServersResponse([
    { name: 'Slack', tools: [{ name: 'ok' }, { description: 'no name' }, null, 42] },
    { description: 'server without a name' },
  ])
  const catalog = await new KlavisClient({ apiKey: 'k' }).listServerCatalog()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'Slack')
  assert.deepEqual(catalog[0].tools, [{ name: 'ok', description: undefined }])
})

test('listServerCatalog leaves tools undefined when the server omits them', async () => {
  mockServersResponse([{ name: 'Gmail', description: 'mail' }])
  const catalog = await new KlavisClient({ apiKey: 'k' }).listServerCatalog()
  assert.equal(catalog[0].tools, undefined)
  assert.equal(catalog[0].toolCount, undefined)
})
