import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listSlackChannels } from '../api'

test('listSlackChannels paginates and normalizes workspace channels', async () => {
  const urls: string[] = []
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = String(input)
    urls.push(url)
    const second = url.includes('cursor=next')
    return new Response(JSON.stringify(second
      ? { ok: true, channels: [{ id: 'C2', name: 'z-private', is_private: true }], response_metadata: { next_cursor: '' } }
      : { ok: true, channels: [{ id: 'C1', name: 'general', is_member: true }], response_metadata: { next_cursor: 'next' } }), { status: 200 })
  }) as typeof fetch
  const channels = await listSlackChannels('xoxb-test', fetchImpl)
  assert.equal(urls.length, 2)
  assert.deepEqual(channels.map((channel) => channel.id), ['C1', 'C2'])
  assert.equal(channels[1].isPrivate, true)
})
