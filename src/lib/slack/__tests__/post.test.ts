import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postSlackResponseUrl } from '@/lib/slack/post'

const stubFetch = (calls: unknown[]) =>
  (async (url: unknown, init: unknown) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

test('SSRF guard: allows the real hooks.slack.com host', async () => {
  const calls: unknown[] = []
  await postSlackResponseUrl({
    responseUrl: 'https://hooks.slack.com/commands/T0AAA111/123/abc',
    text: 'done',
    fetchImpl: stubFetch(calls),
  })
  assert.equal(calls.length, 1)
})

test('SSRF guard: rejects an internal/metadata host — fetch never called', async () => {
  const calls: unknown[] = []
  await assert.rejects(
    postSlackResponseUrl({ responseUrl: 'http://169.254.169.254/latest/meta-data/', text: 'x', fetchImpl: stubFetch(calls) }),
  )
  assert.equal(calls.length, 0)
})

test('SSRF guard: rejects a non-Slack public host — fetch never called', async () => {
  const calls: unknown[] = []
  await assert.rejects(
    postSlackResponseUrl({ responseUrl: 'https://evil.example.com/webhook', text: 'x', fetchImpl: stubFetch(calls) }),
  )
  assert.equal(calls.length, 0)
})

test('SSRF guard: rejects a non-https hooks.slack.com URL — fetch never called', async () => {
  const calls: unknown[] = []
  await assert.rejects(
    postSlackResponseUrl({ responseUrl: 'http://hooks.slack.com/commands/T0AAA111/123/abc', text: 'x', fetchImpl: stubFetch(calls) }),
  )
  assert.equal(calls.length, 0)
})
