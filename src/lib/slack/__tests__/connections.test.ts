import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecretJson, decryptSecretJson, slackIngressUrl, slackAuthTest, serializeSlackConnection } from '@/lib/slack/connections'

test('encryptSecretJson round-trips through decryptSecretJson', () => {
  const blob = encryptSecretJson('xoxb-secret-token')
  assert.equal(typeof blob.value, 'string')
  assert.notEqual(blob.value, 'xoxb-secret-token') // never stored raw (b64: at minimum)
  assert.equal(decryptSecretJson(blob), 'xoxb-secret-token')
})

test('decryptSecretJson throws on malformed payloads', () => {
  assert.throws(() => decryptSecretJson(null))
  assert.throws(() => decryptSecretJson({ nope: true }))
  assert.throws(() => decryptSecretJson('raw-string'))
})

test('slackIngressUrl embeds the binding id under /api/slack/events', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  assert.equal(slackIngressUrl('bind_123'), 'https://app.example.com/api/slack/events/bind_123')
})

test('slackAuthTest verifies the token and captures team + bot user', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, team_id: 'T0AAA111', team: 'Acme', user_id: 'U0BOT9999', bot_id: 'B0BOT9999' }))
  }) as typeof fetch
  const result = await slackAuthTest('xoxb-abc', fetchImpl)
  assert.deepEqual(result, { teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999' })
  assert.equal(calls[0].url, 'https://slack.com/api/auth.test')
  assert.match(String((calls[0].init.headers as Record<string, string>).Authorization), /Bearer xoxb-abc/)
})

test('slackAuthTest rejects a bad token (Slack returns HTTP 200 + ok:false)', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))) as typeof fetch
  await assert.rejects(() => slackAuthTest('xoxb-bad', fetchImpl), /invalid_auth/)
})

test('serializeSlackConnection redacts secrets', () => {
  const now = new Date()
  const out = serializeSlackConnection({
    id: 'bind_1', organizationId: 'org', teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999',
    botToken: encryptSecretJson('xoxb-abc'), signingSecret: encryptSecretJson('sig'),
    status: 'active', createdAt: now, updatedAt: now,
  })
  assert.equal(out.hasBotToken, true)
  assert.equal(out.hasSigningSecret, true)
  assert.ok(!JSON.stringify(out).includes('xoxb'))
  assert.ok(out.ingressUrl.endsWith('/api/slack/events/bind_1'))
})
