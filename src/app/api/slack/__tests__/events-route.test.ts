import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const SIGNING_SECRET = 'test-signing-secret-1234'
  let prisma: any
  let seeded: any
  let bindingId: string
  let encryptSecretJson: (plaintext: string) => { value: string }
  let claimSlackEvent: (bindingId: string, dedupId: string) => Promise<boolean>
  let releaseSlackEvent: (bindingId: string, dedupId: string) => Promise<void>

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    ;({ encryptSecretJson } = await import('@/lib/slack/connections'))
    ;({ claimSlackEvent, releaseSlackEvent } = await import('@/lib/slack/dedup'))
    seeded = await seedTestOrg(prisma)
    const binding = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: seeded.organizationId, teamId: 'T0AAA111', teamName: 'Acme',
        botUserId: 'U0BOT9999',
        botToken: encryptSecretJson('xoxb-test'), signingSecret: encryptSecretJson(SIGNING_SECRET),
      },
    })
    bindingId = binding.id
  })

  after(async () => {
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const signed = (rawBody: string, contentType: string, overrides: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')
    return new NextRequest(new URL(`http://test/api/slack/events/${bindingId}`), {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': overrides.timestamp ?? timestamp,
        'x-slack-signature': overrides.signature ?? signature,
      },
      body: rawBody,
    })
  }

  const mentionEnvelope = (eventId: string) => JSON.stringify({
    token: 'ignored', team_id: 'T0AAA111', api_app_id: 'A0AAA111', type: 'event_callback',
    event_id: eventId, event_time: 1752300000,
    event: { type: 'app_mention', user: 'U0USER111', text: '<@U0BOT9999> hello', ts: '1752300000.000100', channel: 'C0CHAN111' },
  })

  test('url_verification echoes the challenge (after signature verification)', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = JSON.stringify({ type: 'url_verification', token: 'ignored', challenge: 'ch4LL3nge' })
    const res = await POST(signed(raw, 'application/json'))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { challenge: 'ch4LL3nge' })
  })

  test('bad signature → 401; unknown binding → SAME 401 (no existence oracle)', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = mentionEnvelope('Ev0BAD0001')
    const bad = await POST(signed(raw, 'application/json', { signature: 'v0=' + 'ab'.repeat(32) }))
    assert.equal(bad.status, 401)
    const badBody = await bad.json()
    const reqUnknown = new NextRequest(new URL('http://test/api/slack/events/nonexistent'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    })
    const unknown = await POST(reqUnknown)
    // Unknown bindingId must be indistinguishable from a bad signature — a
    // distinct status (e.g. 404) would let a caller enumerate valid ids.
    assert.equal(unknown.status, 401)
    assert.deepEqual(await unknown.json(), badBody)
  })

  test('corrupt signing secret → 401, fails closed (no dispatch)', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const corrupt = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: seeded.organizationId, teamId: 'T0CORRUPT', teamName: 'Corrupt',
        botUserId: 'U0BOTCRPT',
        botToken: encryptSecretJson('xoxb-test'),
        // Malformed payload — decryptSecretJson throws on this shape.
        signingSecret: { nope: true },
      },
    })
    const req = new NextRequest(new URL(`http://test/api/slack/events/${corrupt.id}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': 'v0=' + 'cd'.repeat(32) },
      body: mentionEnvelope('Ev0CORRUPT'),
    })
    const res = await POST(req)
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { ok: false })
  })

  test('valid event acks 200 fast; duplicate event_id is dropped (ok:duplicate), DB-backed', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = mentionEnvelope('Ev0DEDUP01')
    const first = await POST(signed(raw, 'application/json'))
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true })
    const second = await POST(signed(raw, 'application/json'))
    assert.deepEqual(await second.json(), { ok: true, duplicate: true })
    // Backed by an actual row in slack_processed_events, not a cache entry.
    const row = await prisma.slackProcessedEvent.findFirst({ where: { bindingId, dedupId: 'Ev0DEDUP01' } })
    assert.ok(row)
  })

  test('claimSlackEvent: concurrent claims of the same id — exactly one wins the race', async () => {
    const dedupId = 'Ev0RACE001'
    const [a, b] = await Promise.all([claimSlackEvent(bindingId, dedupId), claimSlackEvent(bindingId, dedupId)])
    const winners = [a, b].filter(Boolean)
    assert.equal(winners.length, 1)
  })

  test('releaseSlackEvent: after release, a repeat claim of the same id succeeds again (retry recovery)', async () => {
    const dedupId = 'Ev0RECOVER01'
    assert.equal(await claimSlackEvent(bindingId, dedupId), true)
    assert.equal(await claimSlackEvent(bindingId, dedupId), false) // still claimed
    await releaseSlackEvent(bindingId, dedupId)
    assert.equal(await claimSlackEvent(bindingId, dedupId), true) // re-claimable after release
  })

  test('echo guard: events from the binding bot user or any bot_id are dropped', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const own = JSON.stringify({
      token: 'x', team_id: 'T0AAA111', type: 'event_callback', event_id: 'Ev0ECHO001', event_time: 1,
      event: { type: 'message', channel_type: 'channel', user: 'U0BOT9999', text: 'my own reply', ts: '2.0', channel: 'C0CHAN111' },
    })
    const res = await POST(signed(own, 'application/json'))
    assert.deepEqual(await res.json(), { ok: true, dropped: 'echo' })
  })

  test('slash command acks with the ephemeral working message', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = new URLSearchParams({
      token: 'x', team_id: 'T0AAA111', channel_id: 'C0CHAN111', channel_name: 'general',
      user_id: 'U0USER111', command: '/deploy', text: 'prod',
      response_url: 'https://hooks.slack.com/commands/T0AAA111/123/abc', trigger_id: '111.222.333',
    }).toString()
    const res = await POST(signed(raw, 'application/x-www-form-urlencoded'))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { response_type: 'ephemeral', text: 'Working on it…' })
  })
} else {
  test('slack events route (skipped — TEST_DATABASE_URL not set)', () => {})
}
