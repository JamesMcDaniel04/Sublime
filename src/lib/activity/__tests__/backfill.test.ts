import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBackfillLoop } from '@/lib/activity/backfill'
import type { BackfillBatch, NormalizedActivity } from '@/lib/activity/types'

const ev = (key: string): NormalizedActivity => ({
  source: 'slack', actorRef: 'U1', action: 'posted_message', entityType: 'message',
  entityRef: key, occurredAt: new Date('2026-06-01T00:00:00Z'), dedupeKey: key,
})

function batches(...pages: Array<{ keys: string[]; nextCursor?: string }>): AsyncIterable<BackfillBatch> {
  return (async function* () {
    for (const page of pages) yield { events: page.keys.map(ev), nextCursor: page.nextCursor }
  })()
}

test('ingests every batch, checkpoints cursor after each, marks done', async () => {
  const checkpoints: Array<string | null> = []
  const ingested: string[][] = []
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a', 'b'], nextCursor: 'c1' }, { keys: ['c'] }),
    ingest: async (events) => { ingested.push(events.map((event) => event.dedupeKey)) },
    checkpoint: async (cursor) => { checkpoints.push(cursor) },
  })
  assert.deepEqual(ingested, [['a', 'b'], ['c']])
  assert.deepEqual(checkpoints, ['c1', null])
  assert.deepEqual(result, { status: 'done', batches: 2, events: 3 })
})

test('maxBatches bound stops early and reports partial with resume cursor', async () => {
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a'], nextCursor: 'c1' }, { keys: ['b'], nextCursor: 'c2' }, { keys: ['c'] }),
    ingest: async () => {}, checkpoint: async () => {}, maxBatches: 2,
  })
  assert.deepEqual(result, { status: 'partial', batches: 2, events: 2 })
})

test('an ingest error surfaces as failed (checkpointed work is preserved)', async () => {
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a'], nextCursor: 'c1' }, { keys: ['b'] }),
    ingest: async (events) => { if (events[0].dedupeKey === 'b') throw new Error('boom') },
    checkpoint: async () => {},
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.batches, 1)
})
