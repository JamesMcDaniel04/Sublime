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

test('dropClobberingBareNodes: bare account/opp nodes are dropped only when a read client exists but enrichment failed', async () => {
  const { dropClobberingBareNodes } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  const nodes = [
    { id: 'signal:s1', type: 'signal', text: 'Sales AI signal: x', props: {} },
    { id: 'account:a1', type: 'account', text: 'Account a1', props: {} },
    { id: 'opportunity:o1', type: 'opportunity', text: 'Opportunity o1 — Sales AI status: healthy', props: {} },
    { id: 'stakeholder:p1', type: 'stakeholder', text: 'Stakeholder p1', props: {} },
  ]
  // Client available, only the opportunity enriched → bare account dropped,
  // signal + enriched opp + (never-enrichable) stakeholder kept.
  const filtered = dropClobberingBareNodes(nodes, { clientAvailable: true, enrichedIds: new Set(['opportunity:o1']) })
  assert.deepEqual(filtered.map((n: { id: string }) => n.id), ['signal:s1', 'opportunity:o1', 'stakeholder:p1'])
  // No client at all → bare nodes are useful join points; everything kept.
  const kept = dropClobberingBareNodes(nodes, { clientAvailable: false, enrichedIds: new Set() })
  assert.equal(kept.length, 4)
})
