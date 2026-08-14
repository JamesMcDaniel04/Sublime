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
  // A SECOND tenant, for the id-collision tests below.
  const ORG_B = `qa-org-b-${Date.now()}`
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
    await store.clear(ORG_B).catch(() => undefined)
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

  // ── Cross-tenant id collisions ───────────────────────────────────────────
  //
  // indexer.ts mints ids that are byte-identical across workspaces —
  // `tool:slack`, `capability:slack:post_message`, `actor:slack:U0123`. Under
  // the old global `REQUIRE e.id IS UNIQUE` constraint with MERGE on the bare
  // id, the second workspace to index Slack took ownership of the first one's
  // node and it vanished from their results. These run the REAL Cypher.

  test('two orgs hold the same node id without clobbering each other', async () => {
    const slack = nodeIds.tool('slack')
    await store.upsertNodes([
      { id: slack, organizationId: ORG, type: 'tool', text: 'org A slack', props: { provider: 'slack' }, embedding: vec(77) },
    ])
    await store.upsertNodes([
      { id: slack, organizationId: ORG_B, type: 'tool', text: 'org B slack', props: { provider: 'slack' }, embedding: vec(77) },
    ])

    const a = (await store.search(ORG, USER, vec(77), 10)).filter((h: any) => h.node.id === slack)
    const b = (await store.search(ORG_B, USER, vec(77), 10)).filter((h: any) => h.node.id === slack)

    assert.equal(a.length, 1, "org A lost its node to org B's write")
    assert.equal(a[0].node.text, 'org A slack')
    assert.equal(b.length, 1, 'org B did not get its own node')
    assert.equal(b[0].node.text, 'org B slack')
  })

  test('an edge cannot attach to another org node that shares an id', async () => {
    // Self-contained ids: sharing them with the test above made this pass on
    // the BROKEN store too, because the clobbered node simply vanished from
    // org A's results and the traversal reached nothing at all.
    const shared = nodeIds.tool('github-collide')
    await store.upsertNodes([
      { id: shared, organizationId: ORG, type: 'tool', text: 'org A github', props: {}, embedding: vec(81) },
      { id: shared, organizationId: ORG_B, type: 'tool', text: 'org B github', props: {}, embedding: vec(81) },
      { id: 'run:a-side', organizationId: ORG, type: 'run', text: 'org A run', props: {}, embedding: vec(79) },
      { id: 'run:b-side', organizationId: ORG_B, type: 'run', text: 'org B private run', props: {}, embedding: vec(80) },
    ])
    await store.upsertEdges([
      { organizationId: ORG, from: 'run:a-side', to: shared, rel: 'used' },
      // org B wires ITS github node to its own data. One shared node here
      // would bridge the two graphs.
      { organizationId: ORG_B, from: shared, to: 'run:b-side', rel: 'used' },
    ])

    const reached = await store.expand(ORG, USER, ['run:a-side'], 3)
    // POSITIVE assertion, which is what makes this a real detector: org A must
    // still reach its OWN copy. On the broken store that node belonged to
    // org B, so this comes back empty.
    assert.ok(reached.some((n: any) => n.id === shared), 'org A cannot reach its own node')
    assert.ok(reached.every((n: any) => n.organizationId === ORG), 'traversal left the tenant')
    assert.ok(!reached.some((n: any) => n.id === 'run:b-side'), "org B's node was reachable from org A")
  })

  test('deleting one org node leaves the other org copy intact', async () => {
    const shared = nodeIds.tool('notion-collide')
    await store.upsertNodes([
      { id: shared, organizationId: ORG, type: 'tool', text: 'org A notion', props: {}, embedding: vec(82) },
      { id: shared, organizationId: ORG_B, type: 'tool', text: 'org B notion', props: {}, embedding: vec(82) },
    ])
    // Both must exist BEFORE the delete, or the assertions below pass for the
    // wrong reason on a store that already lost one of them.
    const hit = async (org: string) =>
      (await store.search(org, USER, vec(82), 10)).filter((h: any) => h.node.id === shared)
    assert.equal((await hit(ORG)).length, 1, 'org A never had its own copy to delete')
    assert.equal((await hit(ORG_B)).length, 1, 'org B never had its own copy')

    await store.deleteNodes(ORG, [shared])
    assert.equal((await hit(ORG)).length, 0, 'org A node was not deleted')
    assert.equal((await hit(ORG_B)).length, 1, "org A's delete removed org B's node")
  })

  test('a node written before the tenant-key migration is backfilled, not duplicated', async () => {
    // Write a node the OLD way — id, no key — exactly as pre-migration data sits.
    const driver = await (store as any).driver()
    const legacyId = 'tool:legacy-provider'
    await driver.executeQuery(
      `CREATE (e:Entity { id: $id, organizationId: $org, type: 'tool', text: 'legacy tool',
                          props: '{}', embedding: $emb, visibility: 'shared' })`,
      { id: legacyId, org: ORG, emb: vec(88) },
    )

    // A fresh store runs ensureIndexes again, which is where the backfill lives.
    const { Neo4jGraphStore } = await import('@/lib/rag/neo4j-store')
    const migrated = new Neo4jGraphStore()
    try {
      await migrated.upsertNodes([
        { id: legacyId, organizationId: ORG, type: 'tool', text: 'updated in place', props: {}, embedding: vec(88) },
      ])
      const matching = (await migrated.search(ORG, USER, vec(88), 10)).filter((h: any) => h.node.id === legacyId)
      assert.equal(matching.length, 1, 'the upsert created a duplicate beside the legacy node')
      assert.equal(matching[0].node.text, 'updated in place')

      // The assertion that actually proves the BACKFILL ran rather than the
      // upsert merely finding the node by id: it must now carry a tenant key.
      const { records } = await driver.executeQuery(
        'MATCH (e:Entity { id: $id, organizationId: $org }) RETURN e.key AS key',
        { id: legacyId, org: ORG },
      )
      assert.equal(records.length, 1, 'legacy node is missing or duplicated')
      assert.equal(records[0].get('key'), `${ORG}::${legacyId}`, 'legacy node was never backfilled with a tenant key')
    } finally {
      await migrated.close()
    }
  })

} else {
  test('neo4j live (skipped: QA_NEO4J_URI not set)', { skip: true }, () => {})
}
