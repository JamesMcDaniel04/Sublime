import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SlackToolClient } from '@/lib/integrations/slack'

test('SlackToolClient uses an injected workspace bot token for flow actions', async () => {
  let authorization = ''
  let payload: Record<string, unknown> = {}
  const fetchImpl: typeof fetch = async (_url, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ ok: true, ts: '1.0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const client = new SlackToolClient('xoxb-workspace-token', fetchImpl)
  await client.executeTool('', 'post_message', { channel: 'C123', text: 'Hello from the flow' })
  assert.equal(authorization, 'Bearer xoxb-workspace-token')
  assert.deepEqual(payload, { channel: 'C123', text: 'Hello from the flow' })
})

test('SlackToolClient rejects Slack API failures', async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }))
  const client = new SlackToolClient('xoxb-workspace-token', fetchImpl)
  await assert.rejects(
    () => client.executeTool('', 'post_message', { channel: 'missing', text: 'hello' }),
    /channel_not_found/,
  )
})
