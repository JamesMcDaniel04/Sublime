import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateTemplateAdoption,
  computeTemplateAdoption,
  shouldRunAdoptionSweep,
  type AdoptionEvent,
} from '@/lib/templates/aggregate-adoption'

type LedgerRow = {
  id: string
  organizationId: string
  resourceType: string | null
  resourceId: string | null
  context: unknown
}

/** Minimal stand-in for the sweep's db surface, with real cursor paging. */
function fakeDb(rows: LedgerRow[], activeResourceIds: string[]) {
  const upserts: Array<{ where: unknown; create: unknown; update: unknown }> = []
  const deletes: unknown[] = []
  const pageSizes: number[] = []
  const live = (ids: string[]) =>
    ids.filter((id) => activeResourceIds.includes(id)).map((id) => ({ id }))
  return {
    upserts,
    deletes,
    pageSizes,
    db: {
      userEvent: {
        findMany: async ({ take, cursor, skip }: { take: number; cursor?: { id: string }; skip?: number }) => {
          pageSizes.push(take)
          const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + (skip ?? 0) : 0
          return rows.slice(start, start + take)
        },
      },
      agentTask: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => live(where.id.in),
      },
      flow: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => live(where.id.in),
      },
      templateAdoption: {
        upsert: async (args: { where: unknown; create: unknown; update: unknown }) => {
          upserts.push(args)
        },
        deleteMany: async (args: unknown) => {
          deletes.push(args)
        },
      },
    },
  }
}

const ledgerRow = (
  id: string,
  organizationId: string,
  seedKey: string,
  resourceId: string,
): LedgerRow => ({
  id,
  organizationId,
  resourceType: 'flow',
  resourceId,
  context: { seedKey },
})

const deploy = (
  templateKey: string,
  organizationId: string,
  resourceId: string | null = null,
): AdoptionEvent => ({ templateKey, organizationId, resourceId })

test('counts deploys, survivors, and distinct orgs per template key', () => {
  const rows = computeTemplateAdoption(
    [
      deploy('seed:a', 'org1', 'flow1'),
      deploy('seed:a', 'org1', 'flow2'),
      deploy('seed:a', 'org2', 'flow3'),
    ],
    new Set(['flow1', 'flow3']),
    2,
  )
  assert.deepEqual(rows, [{ templateKey: 'seed:a', deploys: 3, surviving: 2, orgCount: 2 }])
})

test('drops template keys below the k-anonymity floor', () => {
  const rows = computeTemplateAdoption(
    [
      // 5 deploys, but all from one org — must never surface.
      deploy('seed:solo', 'org1', 'flow1'),
      deploy('seed:solo', 'org1', 'flow2'),
      deploy('seed:solo', 'org1', 'flow3'),
      deploy('seed:solo', 'org1', 'flow4'),
      deploy('seed:solo', 'org1', 'flow5'),
      deploy('seed:shared', 'org1', 'flow6'),
      deploy('seed:shared', 'org2', 'flow7'),
    ],
    new Set(),
    2,
  )
  assert.deepEqual(rows.map((row) => row.templateKey), ['seed:shared'])
})

test('a deploy with no surviving resource still counts as a deploy', () => {
  const rows = computeTemplateAdoption(
    [deploy('seed:a', 'org1', null), deploy('seed:a', 'org2', 'gone')],
    new Set(),
    2,
  )
  assert.deepEqual(rows, [{ templateKey: 'seed:a', deploys: 2, surviving: 0, orgCount: 2 }])
})

test('the sweep pages past the old 5k read-time cap instead of truncating', async () => {
  // 6k events across 2 orgs — the previous implementation capped at 5k and
  // silently dropped the tail. Every event must be counted.
  const rows = Array.from({ length: 6_000 }, (_, i) =>
    ledgerRow(`e${i}`, i % 2 === 0 ? 'org1' : 'org2', 'wide', `flow${i}`),
  )
  const { db, upserts } = fakeDb(rows, [])
  const result = await aggregateTemplateAdoption(db as never, new Date(), 2)

  assert.deepEqual(result, { templates: 1 })
  assert.equal(upserts.length, 1)
  assert.deepEqual(upserts[0].create, {
    templateKey: 'seed:wide',
    deploys: 6_000,
    surviving: 0,
    orgCount: 2,
  })
})

test('the sweep deletes stored rows that no longer clear the floor', async () => {
  const { db, deletes } = fakeDb(
    [
      ledgerRow('e1', 'org1', 'shared', 'flow1'),
      ledgerRow('e2', 'org2', 'shared', 'flow2'),
      ledgerRow('e3', 'org1', 'solo', 'flow3'),
    ],
    ['flow1'],
  )
  await aggregateTemplateAdoption(db as never, new Date(), 2)

  // 'seed:solo' never qualifies, so the maintenance delete must remove any
  // previously-stored row rather than leaving it at its last good value.
  assert.deepEqual(deletes, [{ where: { templateKey: { notIn: ['seed:shared'] } } }])
})

test('the sweep counts survival only for still-active deployed resources', async () => {
  const { db, upserts } = fakeDb(
    [
      ledgerRow('e1', 'org1', 'a', 'flow1'),
      ledgerRow('e2', 'org2', 'a', 'flow2'),
      ledgerRow('e3', 'org3', 'a', 'flow3'),
    ],
    ['flow1', 'flow3'],
  )
  await aggregateTemplateAdoption(db as never, new Date(), 2)

  assert.deepEqual(upserts[0].create, {
    templateKey: 'seed:a',
    deploys: 3,
    surviving: 2,
    orgCount: 3,
  })
})

test('the sweep never throws when the database fails', async () => {
  const broken = {
    userEvent: {
      findMany: async () => {
        throw new Error('connection lost')
      },
    },
  }
  assert.deepEqual(await aggregateTemplateAdoption(broken as never, new Date(), 2), {
    skipped: 'error',
  })
})

test('the daily gate fires in exactly one 15-minute dispatch tick', () => {
  assert.equal(shouldRunAdoptionSweep(new Date('2026-07-29T03:00:00Z')), true)
  assert.equal(shouldRunAdoptionSweep(new Date('2026-07-29T03:14:59Z')), true)
  assert.equal(shouldRunAdoptionSweep(new Date('2026-07-29T03:15:00Z')), false)
  assert.equal(shouldRunAdoptionSweep(new Date('2026-07-29T04:00:00Z')), false)
})
