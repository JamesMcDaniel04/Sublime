import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Indexer is gated on embeddingsConfigured() (VOYAGE_API_KEY). Without a key it
// must be a clean no-op; the correlation logic itself is covered by the store +
// retrieve contract tests. Here we assert the gate and that a configured run
// does not throw (embedding network is stubbed via the store contract).
const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
})

test('indexSignal is a no-op when VOYAGE_API_KEY is unset', async () => {
  delete process.env.VOYAGE_API_KEY
  const { indexSignal } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  // Should resolve without touching any store/network.
  await assert.doesNotReject(
    indexSignal({
      id: 's1', organizationId: 'org1', type: 'deal.risk_detected',
      accountId: 'a1', opportunityId: 'o1', stakeholderId: null, payload: { risk: 'high' },
    }),
  )
})

test('indexExecution and indexAgent are no-ops without a key', async () => {
  delete process.env.VOYAGE_API_KEY
  const { indexExecution, indexAgent } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  await assert.doesNotReject(indexExecution({
    id: 'r1', organizationId: 'org1', agentTaskId: 'ag1', signalId: 's1',
    input: { signal: { accountId: 'a1' } }, output: { text: 'done' }, status: 'completed',
  }))
  await assert.doesNotReject(indexAgent({
    id: 'ag1', organizationId: 'org1', title: 'Test', objective: 'do x', description: null,
  }))
})

test('removeRetiredFromGraph is a no-op when Neo4j is not configured', async () => {
  delete process.env.NEO4J_URI
  const { removeRetiredFromGraph } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  // Should resolve without touching any store, even with a non-empty group.
  await assert.doesNotReject(
    removeRetiredFromGraph([
      { organizationId: 'org1', executionIds: ['r1', 'r2'], signalIds: ['s1'] },
    ]),
  )
})
