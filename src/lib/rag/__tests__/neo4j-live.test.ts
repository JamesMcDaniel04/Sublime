/**
 * Live-Neo4j QA drive for the phase 1-3 graph extensions: the ACTUAL Cypher
 * in Neo4jGraphStore executing the new node types (tool, capability) and edge
 * relations (provides, used, used_with) against a real server — the leg the
 * MemoryGraphStore unit tests cannot cover.
 *
 * Nodes/edges come from the REAL production part-builders
 * (userEventGraphParts, userInferenceGraphParts) plus the tool-catalog node
 * shape; only embeddings are synthetic vectors (no Voyage key needed).
 *
 * Skipped entirely unless QA_NEO4J_URI is set. Run against a THROWAWAY
 * instance — the suite writes and deletes its own org-scoped data.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const QA_URI = process.env.QA_NEO4J_URI
if (QA_URI) {
  process.env.NEO4J_URI = QA_URI
  process.env.NEO4J_USERNAME = process.env.NEO4J_USERNAME || 'neo4j'
  process.env.NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'qa-password'

  const ORG = `qa-org-${Date.now()}`
  const USER = 'qa-user-1'
  const OTHER_USER = 'qa-user-2'
  const DIM = 1024
  const vec = (seed: number) => {
    const v = new Array(DIM).fill(0)
    v[seed % DIM] = 1
    return v
  }

  let store: any
  let nodeIds: any

  before(async () => {
    const { Neo4jGraphStore } = await import('@/lib/rag/neo4j-store')
    ;({ nodeIds } = await import('@/lib/rag/indexer'))
    store = new Neo4jGraphStore()
  })

  after(async () => {
    await store.clear(ORG).catch(() => undefined)
    await store.close()
  })

  test('tool + capability nodes upsert with provides edges (the catalog shape)', async () => {
    await store.upsertNodes([
      { id: nodeIds.tool('asana'), organizationId: ORG, type: 'tool', text: 'Connected tool Asana (asana) with 2 capabilities.', props: { provider: 'asana' }, embedding: vec(1) },
      { id: nodeIds.tool('github'), organizationId: ORG, type: 'tool', text: 'Connected tool GitHub (github).', props: { provider: 'github' }, embedding: vec(2) },
      { id: nodeIds.capability('asana', 'create_task'), organizationId: ORG, type: 'capability', text: 'Asana capability create_task.', props: { provider: 'asana', toolName: 'create_task', risk: 'write' }, embedding: vec(3) },
    ])
    await store.upsertEdges([
      { organizationId: ORG, from: nodeIds.tool('asana'), to: nodeIds.capability('asana', 'create_task'), rel: 'provides' },
    ])
    const neighborhood = await store.expand(ORG, USER, [nodeIds.tool('asana')], 1)
    const capability = neighborhood.find((n: any) => n.type === 'capability')
    assert.ok(capability, 'provides edge did not traverse to the capability node')
    assert.equal(capability.props.risk, 'write')
  })

  test('tool_call activity projects with a used edge via the real part builder', async () => {
    const { userEventGraphParts } = await import('@/lib/behavior/index-user-event')
    const { nodes, edges } = userEventGraphParts({
      id: 'qa-ev-1', organizationId: ORG, userId: USER, kind: 'tool_call',
      resourceType: 'integration', resourceId: 'asana',
      context: { provider: 'asana', toolNames: ['create_task'], executionId: 'qa-exec' },
      occurredAt: new Date(),
    })
    assert.ok(edges.some((e: any) => e.rel === 'used'), 'part builder emitted no used edge')
    await store.upsertNodes(nodes.map((n: any, i: number) => ({ ...n, organizationId: ORG, embedding: vec(10 + i) })))
    await store.upsertEdges(edges)
    const fromActivity = await store.expand(ORG, USER, [nodeIds.userEvent('qa-ev-1')], 1)
    assert.ok(fromActivity.some((n: any) => n.id === nodeIds.tool('asana')), 'used edge did not traverse activity → tool')
  })

  test('correlation/archetype/peer insights emit traversable topology edges', async () => {
    const { userInferenceGraphParts, userPatternNodeId } = await import('@/lib/behavior/user-insights')
    const flowNodeId = nodeIds.flow('qa-flow-1')
    await store.upsertNodes([
      { id: flowNodeId, organizationId: ORG, type: 'entity', text: 'flow QA Peer (sublime)', props: {}, embedding: vec(20) },
    ])
    for (const slug of ['toolcorr:asana+github', 'archetype:asana+github:schedule', 'peer:flow:qa-flow-1']) {
      const { nodes, edges } = userInferenceGraphParts({
        organizationId: ORG, userId: USER, slug, text: `QA ${slug}`, evidenceEventIds: ['qa-ev-1'],
      })
      await store.upsertNodes(nodes.map((n: any, i: number) => ({ ...n, organizationId: ORG, embedding: vec(30 + i) })))
      await store.upsertEdges(edges)
    }
    // toolcorr + archetype insights reach BOTH tool nodes over used_with.
    for (const slug of ['toolcorr:asana+github', 'archetype:asana+github:schedule']) {
      const hood = await store.expand(ORG, USER, [userPatternNodeId(slug)], 1)
      assert.ok(hood.some((n: any) => n.id === nodeIds.tool('asana')), `${slug}: used_with missing asana`)
      assert.ok(hood.some((n: any) => n.id === nodeIds.tool('github')), `${slug}: used_with missing github`)
    }
    // peer insight reaches its flow node over relates_to.
    const peerHood = await store.expand(ORG, USER, [userPatternNodeId('peer:flow:qa-flow-1')], 1)
    assert.ok(peerHood.some((n: any) => n.id === flowNodeId), 'peer relates_to missing flow node')
  })

  test('visibility scoping holds on the live store: private insights stay private', async () => {
    const { userPatternNodeId } = await import('@/lib/behavior/user-insights')
    const insightId = userPatternNodeId('toolcorr:asana+github')
    const asOwner = await store.expand(ORG, USER, [nodeIds.tool('asana')], 1)
    assert.ok(asOwner.some((n: any) => n.id === insightId), 'owner cannot see their own insight')
    const asOther = await store.expand(ORG, OTHER_USER, [nodeIds.tool('asana')], 1)
    assert.ok(!asOther.some((n: any) => n.id === insightId), 'private insight leaked to another viewer')
  })

  test('vector search returns org-scoped hits over the new node types', async () => {
    const hits = await store.search(ORG, USER, vec(1), 5)
    assert.ok(hits.length > 0, 'search returned nothing')
    assert.ok(hits.every((h: any) => h.node.organizationId === ORG))
    assert.equal(hits[0].node.id, nodeIds.tool('asana'), 'nearest neighbor should be the matching tool node')
  })

  test('deleteNodes detaches and removes graph rows', async () => {
    await store.deleteNodes(ORG, [nodeIds.tool('github')])
    const remaining = await store.expand(ORG, USER, [nodeIds.tool('asana')], 2)
    assert.ok(!remaining.some((n: any) => n.id === nodeIds.tool('github')), 'deleted node still reachable')
  })
} else {
  test('neo4j live (skipped: QA_NEO4J_URI not set)', { skip: true }, () => {})
}
