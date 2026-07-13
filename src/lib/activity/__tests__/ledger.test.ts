import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistActivity, type ActivityDb } from '@/lib/activity/ledger'
import type { NormalizedActivity } from '@/lib/activity/types'

const event = (over: Partial<NormalizedActivity> = {}): NormalizedActivity => ({
  source: 'slack', actorRef: 'U1', action: 'posted_message',
  entityType: 'message', entityRef: 'C1:111.222',
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'ev1', ...over,
})

class P2002 extends Error { code = 'P2002' }

function stubDb(created: unknown[], opts: { duplicateKeys?: string[] } = {}): ActivityDb {
  return {
    activityEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.duplicateKeys?.includes(data.dedupeKey as string)) throw new P2002('dup')
        const row = { id: `id-${created.length}`, ...data }
        created.push(row)
        return row
      },
    },
  } as unknown as ActivityDb
}

test('persists normalized events with org + ingestKind', async () => {
  const created: Array<Record<string, unknown>> = []
  const result = await persistActivity('org-1', 'webhook', [event()], stubDb(created))
  assert.equal(result.created.length, 1)
  assert.equal(result.duplicates, 0)
  assert.equal(created[0].organizationId, 'org-1')
  assert.equal(created[0].ingestKind, 'webhook')
  assert.equal(created[0].dedupeKey, 'ev1')
})

test('P2002 on dedupeKey counts as duplicate, never throws, others still persist', async () => {
  const created: unknown[] = []
  const result = await persistActivity(
    'org-1', 'backfill',
    [event({ dedupeKey: 'dup' }), event({ dedupeKey: 'fresh' })],
    stubDb(created, { duplicateKeys: ['dup'] }),
  )
  assert.equal(result.created.length, 1)
  assert.equal(result.duplicates, 1)
})

test('non-P2002 errors propagate', async () => {
  const bad = {
    activityEvent: { create: async () => { throw new Error('connection lost') } },
  } as unknown as ActivityDb
  await assert.rejects(() => persistActivity('org-1', 'sync', [event()], bad), /connection lost/)
})
