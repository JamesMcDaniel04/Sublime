import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slackPostMessage,
  gmailSendEmail,
  salesforceCreateRecord,
  DELIVERY_TOOLS,
  capabilityForProviderConfigKey,
  capabilitiesToPurgeOnDisconnect,
  type NangoProxyArgs,
} from '../delivery'

const connection = { connectionId: 'conn-1', providerConfigKey: 'slack', scope: 'user' as const }

function recordingProxy() {
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return { data: { ok: true } }
  }
  return { calls, proxy }
}

test('slackPostMessage proxies chat.postMessage with channel + text', async () => {
  const { calls, proxy } = recordingProxy()
  await slackPostMessage(connection, { channel: '#revenue', text: 'hi' }, proxy)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].endpoint, '/chat.postMessage')
  assert.equal(calls[0].connectionId, 'conn-1')
  assert.deepEqual(calls[0].data, { channel: '#revenue', text: 'hi' })
})

test('gmailSendEmail base64url-encodes an RFC822 message', async () => {
  const { calls, proxy } = recordingProxy()
  await gmailSendEmail(
    { connectionId: 'c', providerConfigKey: 'google-mail', scope: 'org' },
    { to: 'a@b.com', subject: 'Hey', body: 'Body' },
    proxy,
  )
  const raw = (calls[0].data as { raw: string }).raw
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  assert.match(decoded, /To: a@b\.com/)
  assert.match(decoded, /Subject: Hey/)
  assert.match(decoded, /Body/)
})

test('salesforceCreateRecord posts to the sobject endpoint', async () => {
  const { calls, proxy } = recordingProxy()
  await salesforceCreateRecord(
    { connectionId: 'c', providerConfigKey: 'salesforce', scope: 'org' },
    { sobject: 'Task', fields: { Subject: 'Follow up' } },
    proxy,
  )
  assert.equal(calls[0].endpoint, '/services/data/v60.0/sobjects/Task')
  assert.deepEqual(calls[0].data, { Subject: 'Follow up' })
})

test('DELIVERY_TOOLS run() dispatches through the adapter with a custom proxy', async () => {
  const { calls, proxy } = recordingProxy()
  const slackTool = DELIVERY_TOOLS.find((tool) => tool.name === 'slack_post_message')!
  await slackTool.run(connection, { channel: 'C1', text: 'yo' }, proxy)
  assert.equal(calls[0].endpoint, '/chat.postMessage')
  // Each delivery tool exposes a JSON schema and a capability.
  for (const tool of DELIVERY_TOOLS) {
    assert.equal(typeof tool.description, 'string')
    assert.equal((tool.inputSchema as { type: string }).type, 'object')
  }
})

test('new delivery tools proxy the expected provider endpoints', async () => {
  const runs: Array<{ name: string; args: Record<string, unknown>; endpoint: string; method: string }> = [
    { name: 'asana_create_task', args: { project_gid: 'p1', name: 'T' }, endpoint: '/api/1.0/tasks', method: 'POST' },
    { name: 'clickup_create_task', args: { list_id: 'l1', name: 'T' }, endpoint: '/api/v2/list/l1/task', method: 'POST' },
    { name: 'confluence_create_page', args: { space_id: 's1', title: 'T', body: 'B' }, endpoint: '/wiki/api/v2/pages', method: 'POST' },
    { name: 'github_create_issue', args: { owner: 'o', repo: 'r', title: 'T' }, endpoint: '/repos/o/r/issues', method: 'POST' },
    { name: 'intercom_search_contacts', args: { email: 'a@b.com' }, endpoint: '/contacts/search', method: 'POST' },
    { name: 'monday_create_item', args: { board_id: 'b1', item_name: 'I' }, endpoint: '/v2', method: 'POST' },
    { name: 'perplexity_search', args: { query: 'q' }, endpoint: '/chat/completions', method: 'POST' },
  ]
  for (const spec of runs) {
    const { calls, proxy } = recordingProxy()
    const tool = DELIVERY_TOOLS.find((t) => t.name === spec.name)
    assert.ok(tool, `missing tool ${spec.name}`)
    await tool!.run(connection, spec.args, proxy)
    assert.equal(calls[0].endpoint, spec.endpoint, spec.name)
    assert.equal(calls[0].method, spec.method, spec.name)
  }
})

test('monday_create_item passes user input as GraphQL variables, not in the query string', async () => {
  const { calls, proxy } = recordingProxy()
  const tool = DELIVERY_TOOLS.find((t) => t.name === 'monday_create_item')!
  await tool.run(connection, { board_id: 'b1', item_name: 'evil") { boards { id } }' }, proxy)
  const data = calls[0].data as { query: string; variables: Record<string, unknown> }
  assert.ok(!data.query.includes('evil'))
  assert.equal(data.variables.itemName, 'evil") { boards { id } }')
})

// ── capabilityForProviderConfigKey ──────────────────────────────────────────

test('capabilityForProviderConfigKey: maps a known providerConfigKey to its capability', () => {
  assert.equal(capabilityForProviderConfigKey('slack'), 'slack')
  assert.equal(capabilityForProviderConfigKey('google-mail'), 'gmail')
  assert.equal(capabilityForProviderConfigKey('gmail'), 'gmail')
  assert.equal(capabilityForProviderConfigKey('salesforce'), 'salesforce')
  assert.equal(capabilityForProviderConfigKey('salesforce-sandbox'), 'salesforce')
  assert.equal(capabilityForProviderConfigKey('asana'), 'asana')
  assert.equal(capabilityForProviderConfigKey('clickup'), 'clickup')
  assert.equal(capabilityForProviderConfigKey('confluence'), 'confluence')
  assert.equal(capabilityForProviderConfigKey('github-app'), 'github')
  assert.equal(capabilityForProviderConfigKey('intercom'), 'intercom')
  assert.equal(capabilityForProviderConfigKey('intercom-fhmb'), 'intercom')
  assert.equal(capabilityForProviderConfigKey('monday'), 'monday')
  assert.equal(capabilityForProviderConfigKey('perplexity'), 'perplexity')
})

test('capabilityForProviderConfigKey: unknown providerConfigKey has no capability', () => {
  assert.equal(capabilityForProviderConfigKey('notion'), undefined)
})

// ── capabilitiesToPurgeOnDisconnect ─────────────────────────────────────────
// Pure reconciliation for Nango purge-on-disconnect (Task 5, Fix B2):
// learnings are keyed by *capability*, and more than one Nango connection
// (even under different providerConfigKeys, e.g. "google-mail" vs "gmail")
// can map to the same one — so a capability must only be purged when NO
// remaining connected Nango connection still maps to it.

test('capabilitiesToPurgeOnDisconnect: disconnecting the only connection for a capability purges it', () => {
  const result = capabilitiesToPurgeOnDisconnect(['slack'], [])
  assert.deepEqual(result, ['slack'])
})

test('capabilitiesToPurgeOnDisconnect: disconnecting one of two connections sharing a capability does not purge', () => {
  // e.g. "google-mail" was disconnected, but "gmail" (same capability) is
  // still connected.
  const result = capabilitiesToPurgeOnDisconnect(['gmail'], ['gmail'])
  assert.deepEqual(result, [])
})

test('capabilitiesToPurgeOnDisconnect: a capability still connected is never purged', () => {
  const result = capabilitiesToPurgeOnDisconnect(['slack', 'gmail'], ['slack'])
  assert.deepEqual(result, ['gmail'])
})

test('capabilitiesToPurgeOnDisconnect: no affected capabilities purges nothing', () => {
  assert.deepEqual(capabilitiesToPurgeOnDisconnect([], ['slack']), [])
})

test('capabilitiesToPurgeOnDisconnect: dedupes repeated affected capabilities', () => {
  assert.deepEqual(capabilitiesToPurgeOnDisconnect(['slack', 'slack'], []), ['slack'])
})
