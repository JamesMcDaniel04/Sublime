import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLinkedGoalIds } from '@/lib/integrations/goals-port'

type Row = { goalId: string }

function fakeDb(rows: Row[]) {
  const calls: unknown[] = []
  return {
    calls,
    goalContribution: {
      async findMany(args: unknown) {
        calls.push(args)
        return rows
      },
    },
  }
}

test('linked goal ids are scoped by organization AND resource identity', async () => {
  const db = fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-b' }])
  const ids = await resolveLinkedGoalIds('org-1', { type: 'agent', id: 'agent-9' }, db)

  assert.deepEqual(ids, ['goal-a', 'goal-b'])
  assert.deepEqual((db.calls[0] as { where: unknown }).where, {
    organizationId: 'org-1',
    resourceType: 'agent',
    resourceId: 'agent-9',
  })
})

test('a resource with no contribution resolves to an empty set', async () => {
  const ids = await resolveLinkedGoalIds('org-1', { type: 'flow', id: 'flow-3' }, fakeDb([]))
  assert.deepEqual(ids, [])
})

test('duplicate contribution rows collapse to a unique id set', async () => {
  const ids = await resolveLinkedGoalIds(
    'org-1',
    { type: 'agent', id: 'agent-9' },
    fakeDb([{ goalId: 'goal-a' }, { goalId: 'goal-a' }]),
  )
  assert.deepEqual(ids, ['goal-a'])
})
