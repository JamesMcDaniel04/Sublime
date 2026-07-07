import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPayload, auditRowsToCsv } from '../audit'

test('hashPayload is stable and never echoes raw content', () => {
  const payload = { channel: '#secret', text: 'confidential' }
  const a = hashPayload(payload)
  const b = hashPayload({ channel: '#secret', text: 'confidential' })
  assert.equal(a, b)
  assert.match(a!, /^sha256:[0-9a-f]{64}$/)
  assert.ok(!a!.includes('confidential'))
})

test('hashPayload handles null/undefined', () => {
  assert.equal(hashPayload(null), null)
  assert.equal(hashPayload(undefined), null)
})

test('auditRowsToCsv emits a header and escapes commas/quotes/newlines', () => {
  const csv = auditRowsToCsv([
    {
      createdAt: new Date('2026-07-03T12:00:00Z'),
      action: 'tool.write',
      actorKind: 'agent',
      actorUserId: 'user-1',
      tool: 'slack_post_message',
      resourceType: 'deal',
      resourceId: 'opp, 1',
      executionId: 'exec-1',
      payloadHash: 'sha256:abc',
    },
  ])
  const [header, row] = csv.split('\n')
  assert.equal(header, 'createdAt,action,actorKind,actorUserId,tool,resourceType,resourceId,executionId,payloadHash')
  assert.match(row, /2026-07-03T12:00:00.000Z,tool\.write,agent,user-1,slack_post_message,deal,"opp, 1",exec-1,sha256:abc/)
})
