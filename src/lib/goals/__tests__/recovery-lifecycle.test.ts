import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileRecoveryPlan } from '../recovery-lifecycle'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

const stripeAvailable: MetricSourceOption = {
  source: 'stripe',
  group: 'source_of_truth',
  metrics: [],
  connections: [{ ref: 'credential:c1', label: 'Stripe' }],
}

function deps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { resolved: [], completed: [] }
  return {
    calls,
    findOpenPlanWithActions: async () => ({
      id: 'plan-1',
      actions: [
        { id: 'a1', kind: 'connect_tool', status: 'proposed', payload: { source: 'stripe' } },
        { id: 'a2', kind: 'manual_step', status: 'proposed', payload: {} },
      ],
    }),
    resolvePlan: async (id: string) => {
      calls.resolved.push(id)
    },
    completeAction: async (id: string) => {
      calls.completed.push(id)
    },
    listSources: async () => [stripeAvailable],
    recipientFor: async () => 'user-1',
    ...overrides,
  }
}

test('returning on_track resolves the open plan', async () => {
  const d = deps()
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', d as never)
  assert.deepEqual(d.calls.resolved, ['plan-1'])
  assert.equal(d.calls.completed.length, 0)
})

test('a now-connected source completes its connect_tool action', async () => {
  const d = deps()
  await reconcileRecoveryPlan('goal-1', 'org-1', 'off_track', d as never)
  assert.deepEqual(d.calls.completed, ['a1'])
  assert.equal(d.calls.resolved.length, 0)
})

test('accepted connect_tool actions also auto-complete', async () => {
  const d = deps({
    findOpenPlanWithActions: async () => ({
      id: 'plan-1',
      actions: [
        { id: 'a1', kind: 'connect_tool', status: 'accepted', payload: { source: 'stripe' } },
      ],
    }),
  })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'at_risk', d as never)
  assert.deepEqual(d.calls.completed, ['a1'])
})

test('a still-unconnected source leaves the action untouched', async () => {
  const d = deps({ listSources: async () => [] })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'off_track', d as never)
  assert.equal(d.calls.completed.length, 0)
})

test('no recipient skips the availability check without failing', async () => {
  const d = deps({ recipientFor: async () => null })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'off_track', d as never)
  assert.equal(d.calls.completed.length, 0)
})

test('no open plan is a no-op and errors never propagate', async () => {
  const d = deps({ findOpenPlanWithActions: async () => null })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', d as never)
  assert.equal(d.calls.resolved.length, 0)

  const throwing = deps({
    findOpenPlanWithActions: async () => {
      throw new Error('db down')
    },
  })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', throwing as never)
})
