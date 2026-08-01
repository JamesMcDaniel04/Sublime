import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slackPostMessage,
  gmailSendEmail,
  salesforceCreateRecord,
  DELIVERY_TOOLS,
  capabilityForProviderConfigKey,
  capabilitiesToPurgeOnDisconnect,
  chooseDeliveryConnection,
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

// ── Native Google delivery tools (sheets / drive / calendar) ────────────────

test('sheets tools proxy the Sheets values endpoints with encoded ranges', async () => {
  const google = { connectionId: 'g1', providerConfigKey: 'google-sheets', scope: 'org' as const }
  const get = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'sheets_get_values')!.run(google, { spreadsheet_id: 'S1', range: 'Sheet1!A1:B2' }, get.proxy)
  assert.equal(get.calls[0].method, 'GET')
  assert.equal(get.calls[0].endpoint, `/v4/spreadsheets/S1/values/${encodeURIComponent('Sheet1!A1:B2')}`)

  const update = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'sheets_update_values')!.run(google, { spreadsheet_id: 'S1', range: 'A1', values: [['x']] }, update.proxy)
  assert.equal(update.calls[0].method, 'PUT')
  assert.equal(update.calls[0].endpoint, '/v4/spreadsheets/S1/values/A1')
  assert.equal(update.calls[0].params?.valueInputOption, 'USER_ENTERED')
  assert.deepEqual(update.calls[0].data, { values: [['x']] })

  const append = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'sheets_append_rows')!.run(google, { spreadsheet_id: 'S1', range: 'A1', values: [['x', 'y']] }, append.proxy)
  assert.equal(append.calls[0].method, 'POST')
  assert.equal(append.calls[0].endpoint, '/v4/spreadsheets/S1/values/A1:append')
  assert.equal(append.calls[0].params?.insertDataOption, 'INSERT_ROWS')
})

test('calendar tools proxy the Calendar v3 events endpoints', async () => {
  const google = { connectionId: 'g1', providerConfigKey: 'google-calendar', scope: 'org' as const }
  const list = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'calendar_list_events')!.run(google, { time_min: '2026-07-01T00:00:00Z', max_results: 10 }, list.proxy)
  assert.equal(list.calls[0].method, 'GET')
  assert.equal(list.calls[0].endpoint, '/calendar/v3/calendars/primary/events')
  assert.equal(list.calls[0].params?.timeMin, '2026-07-01T00:00:00Z')
  assert.equal(list.calls[0].params?.singleEvents, 'true')

  const create = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'calendar_create_event')!.run(
    google,
    { summary: 'Standup', start: '2026-07-23T09:00:00Z', end: '2026-07-23T09:15:00Z', attendees: ['a@b.com'] },
    create.proxy,
  )
  assert.equal(create.calls[0].method, 'POST')
  assert.equal(create.calls[0].endpoint, '/calendar/v3/calendars/primary/events')
  const event = create.calls[0].data as { summary: string; start: { dateTime: string }; attendees: Array<{ email: string }> }
  assert.equal(event.summary, 'Standup')
  assert.equal(event.start.dateTime, '2026-07-23T09:00:00Z')
  assert.deepEqual(event.attendees, [{ email: 'a@b.com' }])
})

test('drive tools list, download, and upload via the Drive v3 endpoints', async () => {
  const google = { connectionId: 'g1', providerConfigKey: 'google-drive', scope: 'org' as const }
  const list = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'drive_list_files')!.run(google, { query: "name contains 'report'" }, list.proxy)
  assert.equal(list.calls[0].method, 'GET')
  assert.equal(list.calls[0].endpoint, '/drive/v3/files')
  assert.equal(list.calls[0].params?.q, "name contains 'report'")

  const download = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'drive_download_file')!.run(google, { file_id: 'f1' }, download.proxy)
  assert.equal(download.calls[0].endpoint, '/drive/v3/files/f1')
  assert.equal(download.calls[0].params?.alt, 'media')

  // Upload is two calls: metadata create, then media upload of the raw content.
  const uploads: NangoProxyArgs[] = []
  const uploadProxy = async (args: NangoProxyArgs) => {
    uploads.push(args)
    return { data: { id: 'f-new' } }
  }
  await DELIVERY_TOOLS.find((t) => t.name === 'drive_upload_file')!.run(
    google,
    { name: 'notes.txt', content: 'hello world', mime_type: 'text/plain', folder_id: 'dir1' },
    uploadProxy,
  )
  assert.equal(uploads[0].method, 'POST')
  assert.equal(uploads[0].endpoint, '/drive/v3/files')
  assert.deepEqual(uploads[0].data, { name: 'notes.txt', mimeType: 'text/plain', parents: ['dir1'] })
  assert.equal(uploads[1].method, 'PATCH')
  assert.equal(uploads[1].endpoint, '/upload/drive/v3/files/f-new')
  assert.equal(uploads[1].params?.uploadType, 'media')
  assert.equal(uploads[1].data, 'hello world')
  assert.equal(uploads[1].contentType, 'text/plain')
})

test('analytics tools proxy the GA4 Admin and Data API endpoints', async () => {
  const google = { connectionId: 'g1', providerConfigKey: 'google-analytics', scope: 'org' as const }
  const list = recordingProxy()
  await DELIVERY_TOOLS.find((t) => t.name === 'analytics_list_properties')!.run(google, {}, list.proxy)
  assert.equal(list.calls[0].method, 'GET')
  assert.equal(list.calls[0].endpoint, '/v1beta/accountSummaries')

  const report = recordingProxy()
  // "properties/123" (Admin API shape) must normalize to the bare id.
  await DELIVERY_TOOLS.find((t) => t.name === 'analytics_run_report')!.run(
    google,
    { property_id: 'properties/123', metrics: ['activeUsers'], dimensions: ['date'], start_date: '2026-07-01', end_date: '2026-07-25' },
    report.proxy,
  )
  assert.equal(report.calls[0].method, 'POST')
  assert.equal(report.calls[0].endpoint, '/v1beta/properties/123:runReport')
  const body = report.calls[0].data as { metrics: Array<{ name: string }>; dimensions: Array<{ name: string }>; dateRanges: Array<{ startDate: string; endDate: string }> }
  assert.deepEqual(body.metrics, [{ name: 'activeUsers' }])
  assert.deepEqual(body.dimensions, [{ name: 'date' }])
  assert.deepEqual(body.dateRanges, [{ startDate: '2026-07-01', endDate: '2026-07-25' }])
})

test('deliverySpecByName finds a capability tool by name for multi-tool capabilities', async () => {
  const { deliverySpecByName } = await import('../delivery')
  assert.equal(deliverySpecByName('sheets', 'sheets_append_rows')?.name, 'sheets_append_rows')
  assert.equal(deliverySpecByName('sheets', 'drive_list_files'), undefined)
  assert.equal(deliverySpecByName('gmail', 'gmail_send_email')?.name, 'gmail_send_email')
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
  assert.equal(capabilityForProviderConfigKey('google-sheets'), 'sheets')
  assert.equal(capabilityForProviderConfigKey('google-drive'), 'drive')
  assert.equal(capabilityForProviderConfigKey('google-calendar'), 'calendar')
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

test('chooseDeliveryConnection: own first, then org-shared, NEVER another user\'s personal connection', () => {
  const own = { connectionId: 'own', userId: 'user-1' }
  const shared = { connectionId: 'shared', userId: null }
  const foreign = { connectionId: 'foreign', userId: 'user-2' }

  assert.equal(chooseDeliveryConnection([foreign, shared, own], 'user-1'), own)
  assert.equal(chooseDeliveryConnection([foreign, shared], 'user-1'), shared)
  // Only another user's personal connection available → fail closed.
  assert.equal(chooseDeliveryConnection([foreign], 'user-1'), null)
  assert.equal(chooseDeliveryConnection([foreign], null), null)
  assert.equal(chooseDeliveryConnection([], 'user-1'), null)
  // No acting user: org-shared only.
  assert.equal(chooseDeliveryConnection([foreign, shared], null), shared)
})
