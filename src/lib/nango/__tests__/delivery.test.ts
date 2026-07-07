import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  slackPostMessage,
  gmailSendEmail,
  salesforceCreateRecord,
  DELIVERY_TOOLS,
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
